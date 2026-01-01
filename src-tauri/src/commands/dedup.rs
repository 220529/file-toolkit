use log::{debug, info, warn};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

// 全局取消标志
lazy_static::lazy_static! {
    static ref DEDUP_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

#[derive(Serialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
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
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
}

/// 查找重复文件（带进度反馈）
#[tauri::command]
pub async fn find_duplicates(app: AppHandle, path: String) -> Result<DedupResult, String> {
    // 重置取消标志
    DEDUP_CANCELLED.store(false, Ordering::SeqCst);
    
    info!("[去重] 开始扫描: {}", path);
    let start_time = Instant::now();
    let cancelled = DEDUP_CANCELLED.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut size_map: HashMap<u64, Vec<String>> = HashMap::new();

        // 1. 先收集所有文件
        let _ = app.emit(
            "dedup-progress",
            DedupProgress {
                stage: "扫描文件".into(),
                current: 0,
                total: 0,
                percent: 0.0,
            },
        );

        let scan_start = Instant::now();
        let mut file_count = 0;
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
            
            if let Ok(meta) = entry.metadata() {
                let size = meta.len();
                if size > 0 {
                    size_map
                        .entry(size)
                        .or_default()
                        .push(entry.path().to_string_lossy().to_string());
                    file_count += 1;

                    if file_count % 100 == 0 {
                        let _ = app.emit(
                            "dedup-progress",
                            DedupProgress {
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
        info!("[去重] 扫描完成: {} 个文件, 耗时 {:?}", file_count, scan_start.elapsed());

        // 2. 筛选需要计算哈希的文件
        let files_to_hash: Vec<(u64, String)> = size_map
            .iter()
            .filter(|(_, files)| files.len() >= 2)
            .flat_map(|(size, files)| files.iter().map(move |f| (*size, f.clone())))
            .collect();

        let total_to_hash = files_to_hash.len();
        info!("[去重] 需要计算哈希: {} 个文件", total_to_hash);

        let hash_start = Instant::now();
        let progress_counter = Arc::new(AtomicUsize::new(0));
        let last_reported = Arc::new(AtomicUsize::new(0));
        let app_clone = app.clone();
        let cancelled_clone = cancelled.clone();

        // 3. 并行计算哈希（使用 rayon）
        let results: Vec<(String, FileInfo)> = files_to_hash
            .par_iter()
            .filter_map(|(size, file_path)| {
                // 检查是否取消
                if cancelled_clone.load(Ordering::SeqCst) {
                    return None;
                }
                
                let hash = calculate_fast_hash(Path::new(file_path), *size).ok()?;
                let meta = fs::metadata(file_path).ok();
                let file_info = FileInfo {
                    name: Path::new(file_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: file_path.clone(),
                    size: *size,
                    modified: meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                };

                // 更新进度（使用单调递增，避免跳动）
                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                // 只有当前进度大于上次报告的进度时才更新
                if current > last && (current - last >= 20 || current == total_to_hash) {
                    // 尝试更新 last_reported，只有成功时才发送进度
                    if last_reported.compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed).is_ok() {
                        let percent = (current as f64 / total_to_hash as f64) * 100.0;
                        let _ = app_clone.emit(
                            "dedup-progress",
                            DedupProgress {
                                stage: "计算文件指纹".into(),
                                current,
                                total: total_to_hash,
                                percent,
                            },
                        );
                    }
                }

                Some((hash, file_info))
            })
            .collect();

        // 检查是否被取消
        if cancelled.load(Ordering::SeqCst) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }

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
                stage: "完成".into(),
                current: total_to_hash,
                total: total_to_hash,
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
pub fn delete_files(paths: Vec<String>) -> Result<u32, String> {
    info!("[删除] 准备删除 {} 个文件", paths.len());
    let mut deleted = 0;
    for path in &paths {
        if fs::remove_file(path).is_ok() {
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
    use std::process::Command;
    use tauri::Manager;

    let path_lower = path.to_lowercase();
    let ext = path_lower.rsplit('.').next().unwrap_or("");

    // 图片类型
    if ["jpg", "jpeg", "png", "gif", "bmp", "webp"].contains(&ext) {
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
        // 获取内嵌的 ffmpeg 路径
        let ffmpeg = app
            .path()
            .resource_dir()
            .ok()
            .map(|p| p.join("binaries").join("ffmpeg"))
            .filter(|p| p.exists())
            .unwrap_or_else(|| std::path::PathBuf::from("ffmpeg"));

        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join(format!("thumb_{}.jpg", std::process::id()));
        let temp_path = temp_file.to_string_lossy().to_string();

        let output = Command::new(&ffmpeg)
            .args([
                "-y",
                "-ss",
                "0",
                "-i",
                &path,
                "-vframes",
                "1",
                "-vf",
                "scale=120:-1",
                "-q:v",
                "5",
                &temp_path,
            ])
            .output()
            .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

        if output.status.success() {
            let data = fs::read(&temp_file).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&temp_file);
            return Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(&data)));
        }
    }

    // 其他类型返回空
    Err("不支持的文件类型".into())
}

/// 快速哈希：使用 xxHash3（比 MD5 快 5-10 倍）
/// 小文件用内存映射，大文件只读头中尾
fn calculate_fast_hash(path: &Path, size: u64) -> Result<String, String> {
    use memmap2::Mmap;
    use xxhash_rust::xxh3::Xxh3;

    const SMALL_FILE: u64 = 1024 * 1024;      // 1MB 以下用 mmap
    const THRESHOLD: u64 = 10 * 1024 * 1024;  // 10MB 以下完整读取
    const SAMPLE_SIZE: usize = 1024 * 1024;   // 采样 1MB

    let file = File::open(path).map_err(|e| e.to_string())?;

    if size <= SMALL_FILE {
        // 小文件：内存映射，零拷贝
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;
        let hash = xxhash_rust::xxh3::xxh3_64(&mmap);
        return Ok(format!("{:016x}", hash));
    }

    let mut hasher = Xxh3::new();

    if size <= THRESHOLD {
        // 中等文件：大缓冲区读取
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;
        hasher.update(&mmap);
    } else {
        // 大文件：只读头部 + 中间 + 尾部
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;
        let len = mmap.len();

        // 头部
        hasher.update(&mmap[..SAMPLE_SIZE]);

        // 中间
        let mid = len / 2 - SAMPLE_SIZE / 2;
        hasher.update(&mmap[mid..mid + SAMPLE_SIZE]);

        // 尾部
        hasher.update(&mmap[len - SAMPLE_SIZE..]);

        // 加入文件大小
        hasher.update(&size.to_le_bytes());
    }

    Ok(format!("{:016x}", hasher.digest()))
}
