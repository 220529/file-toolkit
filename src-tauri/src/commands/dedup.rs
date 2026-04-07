use log::{debug, info, warn};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::ffmpeg_utils::get_ffmpeg_path;

// 全局取消标志
lazy_static::lazy_static! {
    static ref DEDUP_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

fn matches_scope(path: &Path, scope: &str) -> bool {
    if scope == "all" {
        return true;
    }

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let is_image = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].contains(&ext.as_str());
    let is_video = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].contains(&ext.as_str());

    match scope {
        "media" => is_image || is_video,
        _ => true,
    }
}

#[derive(Serialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub created: u64,
    pub modified: u64,
}

#[derive(Serialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub files: Vec<FileInfo>,
}

#[derive(Serialize)]
pub struct DedupResult {
    pub groups: Vec<DuplicateGroup>,
    pub total_groups: usize,
    pub total_duplicates: usize,
    pub wasted_size: u64,
}

#[derive(Serialize, Clone)]
pub struct DedupProgress {
    pub task_id: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
}

/// 查找重复文件（带进度反馈）
#[tauri::command]
pub async fn find_duplicates(
    app: AppHandle,
    path: String,
    task_id: String,
    scope: Option<String>,
) -> Result<DedupResult, String> {
    // 重置取消标志
    DEDUP_CANCELLED.store(false, Ordering::SeqCst);
    
    info!("[去重] 开始扫描: {}", path);
    let start_time = Instant::now();
    let cancelled = DEDUP_CANCELLED.clone();
    let scope = scope.unwrap_or_else(|| "all".to_string());

    let result = tokio::task::spawn_blocking(move || {
        let mut size_map: HashMap<u64, Vec<FileInfo>> = HashMap::new();

        // 1. 先收集所有文件
        let _ = app.emit(
            "dedup-progress",
            DedupProgress {
                task_id: task_id.clone(),
                stage: "扫描文件".into(),
                current: 0,
                total: 0,
                percent: 0.0,
            },
        );

        let scan_start = Instant::now();
        let mut file_count = 0;
        let mut last_progress_emit = Instant::now();
        for entry in WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            // 检查是否取消
            if cancelled.load(Ordering::SeqCst) {
                info!("[去重] 用户取消操作");
                return Err("操作已取消".to_string());
            }
            
            if !matches_scope(entry.path(), &scope) {
                continue;
            }

            if let Ok(meta) = entry.metadata() {
                let size = meta.len();
                if size > 0 {
                    let path = entry.path();
                    let file_info = FileInfo {
                        path: path.to_string_lossy().to_string(),
                        name: path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        size,
                        created: meta
                            .created()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    };

                    size_map.entry(size).or_default().push(file_info);
                    file_count += 1;

                    if file_count == 1 || last_progress_emit.elapsed() >= Duration::from_millis(200) {
                        last_progress_emit = Instant::now();
                        let _ = app.emit(
                            "dedup-progress",
                            DedupProgress {
                                task_id: task_id.clone(),
                                stage: "扫描文件".into(),
                                current: file_count,
                                total: 0,
                                percent: 0.0,
                            },
                        );
                    }
                }
            }
        }
        let _ = app.emit(
            "dedup-progress",
            DedupProgress {
                task_id: task_id.clone(),
                stage: "扫描文件".into(),
                current: file_count,
                total: 0,
                percent: 0.0,
            },
        );
        info!("[去重] 扫描完成: {} 个文件, 耗时 {:?}", file_count, scan_start.elapsed());

        // 2. 快速筛出重复候选：只对同大小文件计算采样指纹
        let files_to_sample: Vec<FileInfo> = size_map
            .iter()
            .filter(|(_, files)| files.len() >= 2)
            .flat_map(|(_, files)| files.iter().cloned())
            .collect();

        let total_to_sample = files_to_sample.len();
        info!("[去重] 需要快速筛选: {} 个文件", total_to_sample);

        let sample_start = Instant::now();
        let progress_counter = Arc::new(AtomicUsize::new(0));
        let last_reported = Arc::new(AtomicUsize::new(0));
        let app_clone = app.clone();
        let cancelled_clone = cancelled.clone();

        let sample_results: Vec<(u64, String, FileInfo)> = files_to_sample
            .par_iter()
            .filter_map(|file_info| {
                // 检查是否取消
                if cancelled_clone.load(Ordering::SeqCst) {
                    return None;
                }
                
                let hash = calculate_sample_hash(Path::new(&file_info.path), file_info.size).ok()?;

                // 更新进度（使用单调递增，避免跳动）
                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                // 只有当前进度大于上次报告的进度时才更新
                if current > last && (current - last >= 20 || current == total_to_sample) {
                    // 尝试更新 last_reported，只有成功时才发送进度
                    if last_reported.compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed).is_ok() {
                        let percent = (current as f64 / total_to_sample as f64) * 70.0;
                        let _ = app_clone.emit(
                            "dedup-progress",
                            DedupProgress {
                                task_id: task_id.clone(),
                                stage: "初步筛选重复文件".into(),
                                current,
                                total: total_to_sample,
                                percent,
                            },
                        );
                    }
                }

                Some((file_info.size, hash, file_info.clone()))
            })
            .collect();

        // 检查是否被取消
        if cancelled.load(Ordering::SeqCst) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }
        info!("[去重] 快速筛选完成, 耗时 {:?}", sample_start.elapsed());

        let mut sample_map: HashMap<(u64, String), Vec<FileInfo>> = HashMap::new();
        for (size, hash, file_info) in sample_results {
            sample_map.entry((size, hash)).or_default().push(file_info);
        }

        let files_to_hash: Vec<FileInfo> = sample_map
            .into_iter()
            .filter(|(_, files)| files.len() > 1)
            .flat_map(|(_, files)| files.into_iter())
            .collect();

        let total_to_hash = files_to_hash.len();
        info!("[去重] 需要精确比对: {} 个文件", total_to_hash);

        let hash_start = Instant::now();
        let progress_counter = Arc::new(AtomicUsize::new(0));
        let last_reported = Arc::new(AtomicUsize::new(0));
        let app_clone = app.clone();
        let cancelled_clone = cancelled.clone();

        // 3. 对快速筛中的候选做全量精确哈希
        let results: Vec<(String, FileInfo)> = files_to_hash
            .par_iter()
            .filter_map(|file_info| {
                if cancelled_clone.load(Ordering::SeqCst) {
                    return None;
                }

                let hash = calculate_exact_hash(Path::new(&file_info.path), file_info.size).ok()?;

                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                if current > last && (current - last >= 20 || current == total_to_hash) {
                    if last_reported.compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed).is_ok() {
                        let percent = 70.0 + (current as f64 / total_to_hash as f64) * 30.0;
                        let _ = app_clone.emit(
                            "dedup-progress",
                            DedupProgress {
                                task_id: task_id.clone(),
                                stage: "确认重复文件".into(),
                                current,
                                total: total_to_hash,
                                percent,
                            },
                        );
                    }
                }

                Some((hash, file_info.clone()))
            })
            .collect();

        // 汇总结果
        let mut hash_map: HashMap<String, Vec<FileInfo>> = HashMap::new();
        for (hash, file_info) in results {
            hash_map.entry(hash).or_default().push(file_info);
        }
        info!("[去重] 哈希计算完成, 耗时 {:?}", hash_start.elapsed());

        // 4. 只返回有重复的组
        let mut groups: Vec<DuplicateGroup> = hash_map
            .into_iter()
            .filter(|(_, files)| files.len() > 1)
            .map(|(hash, files)| DuplicateGroup {
                hash,
                size: files[0].size,
                files,
            })
            .collect();

        groups.sort_by(|a, b| b.size.cmp(&a.size));

        let total_groups = groups.len();
        let total_duplicates: usize = groups.iter().map(|g| g.files.len() - 1).sum();
        let wasted_size: u64 = groups
            .iter()
            .map(|g| g.size * (g.files.len() as u64 - 1))
            .sum();

        let _ = app.emit(
            "dedup-progress",
            DedupProgress {
                task_id: task_id.clone(),
                stage: "完成".into(),
                current: total_to_hash.max(total_to_sample).max(1),
                total: total_to_hash.max(total_to_sample).max(1),
                percent: 100.0,
            },
        );

        Ok::<DedupResult, String>(DedupResult {
            groups,
            total_groups,
            total_duplicates,
            wasted_size,
        })
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    info!("[去重] 完成: {} 组重复, {} 个重复文件, 可释放 {} bytes, 总耗时 {:?}",
        result.total_groups, result.total_duplicates, result.wasted_size, start_time.elapsed());

    Ok(result)
}

/// 删除指定文件
#[tauri::command]
pub fn delete_files(paths: Vec<String>, use_trash: bool) -> Result<u32, String> {
    info!("[删除] 准备删除 {} 个文件, 使用回收站: {}", paths.len(), use_trash);
    let mut deleted = 0;
    for path in &paths {
        let result = if use_trash {
            trash::delete(path)
        } else {
            fs::remove_file(path).map_err(|e| trash::Error::Unknown { description: e.to_string() })
        };
        
        if result.is_ok() {
            debug!("[删除] 已删除: {}", path);
            deleted += 1;
        } else {
            warn!("[删除] 删除失败: {}", path);
        }
    }
    info!("[删除] 完成: 成功删除 {} 个文件", deleted);
    Ok(deleted)
}

/// 取消去重操作
#[tauri::command]
pub fn cancel_dedup() {
    info!("[去重] 收到取消请求");
    DEDUP_CANCELLED.store(true, Ordering::SeqCst);
}

/// 生成文件预览缩略图
/// 图片：直接读取并缩放
/// 视频：使用 FFmpeg 截取第一帧
#[tauri::command]
pub fn get_file_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    let path_lower = path.to_lowercase();
    let ext = path_lower.rsplit('.').next().unwrap_or("");

    // 图片类型
    if ["jpg", "jpeg", "png", "gif", "bmp", "webp"].contains(&ext) {
        let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        if size > 512 * 1024 {
            return generate_thumbnail_with_ffmpeg(&app, &path, false);
        }

        let data = fs::read(&path).map_err(|e| e.to_string())?;
        let mime = match ext {
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        return Ok(format!("data:{};base64,{}", mime, BASE64.encode(&data)));
    }

    // 视频类型：用 FFmpeg 截取第一帧
    if ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].contains(&ext) {
        return generate_thumbnail_with_ffmpeg(&app, &path, true);
    }

    // 其他类型返回空
    Err("不支持的文件类型".into())
}

fn generate_thumbnail_with_ffmpeg(
    app: &tauri::AppHandle,
    path: &str,
    seek_first_frame: bool,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use std::process::Command;

    let ffmpeg = get_ffmpeg_path(app);
    let temp_file = build_temp_thumbnail_path();
    let temp_path = temp_file.to_string_lossy().to_string();

    let mut args = vec!["-y".to_string()];
    if seek_first_frame {
        args.push("-ss".into());
        args.push("0".into());
    }
    args.push("-i".into());
    args.push(path.to_string());
    args.push("-frames:v".into());
    args.push("1".into());
    args.push("-vf".into());
    args.push("scale=240:-1".into());
    args.push("-q:v".into());
    args.push("6".into());
    args.push(temp_path.clone());

    let output = Command::new(&ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("生成缩略图失败: {}", stderr));
    }

    let data = fs::read(&temp_file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&temp_file);
    Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(&data)))
}

fn build_temp_thumbnail_path() -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("thumb_{}_{}.jpg", std::process::id(), unique))
}

/// 快速采样指纹：只读头中尾，避免把中等图片整文件拉进来
fn calculate_sample_hash(path: &Path, size: u64) -> Result<String, String> {
    use memmap2::Mmap;
    use xxhash_rust::xxh3::Xxh3;

    const TINY_FILE: u64 = 256 * 1024;
    const SAMPLE_SIZE: usize = 512 * 1024;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;
    let len = mmap.len();

    if size <= TINY_FILE {
        let hash = xxhash_rust::xxh3::xxh3_64(&mmap);
        return Ok(format!("{:016x}", hash));
    }

    let mut hasher = Xxh3::new();
    let sample_len = SAMPLE_SIZE.min(len);

    hasher.update(&mmap[..sample_len]);

    if len > sample_len * 2 {
        let mid = len / 2 - sample_len / 2;
        hasher.update(&mmap[mid..mid + sample_len]);
    }

    if len > sample_len {
        hasher.update(&mmap[len - sample_len..]);
    }

    hasher.update(&size.to_le_bytes());

    Ok(format!("{:016x}", hasher.digest()))
}

/// 二次确认：读取头/中/尾更大样本，兼顾速度和稳定性
fn calculate_exact_hash(path: &Path, size: u64) -> Result<String, String> {
    use memmap2::Mmap;
    use xxhash_rust::xxh3::Xxh3;

    const SMALL_FILE: u64 = 4 * 1024 * 1024;
    const SAMPLE_SIZE: usize = 2 * 1024 * 1024;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;
    let len = mmap.len();

    if size <= SMALL_FILE {
        let hash = xxhash_rust::xxh3::xxh3_64(&mmap);
        return Ok(format!("{:016x}", hash));
    }

    let mut hasher = Xxh3::new();
    let sample_len = SAMPLE_SIZE.min(len);

    hasher.update(&mmap[..sample_len]);

    if len > sample_len * 2 {
        let mid = len / 2 - sample_len / 2;
        hasher.update(&mmap[mid..mid + sample_len]);
    }

    if len > sample_len {
        hasher.update(&mmap[len - sample_len..]);
    }

    hasher.update(&size.to_le_bytes());

    Ok(format!("{:016x}", hasher.digest()))
}
