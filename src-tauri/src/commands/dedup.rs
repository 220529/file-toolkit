use log::{debug, info, warn};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::ffmpeg_utils::get_ffmpeg_path;

lazy_static::lazy_static! {
    static ref DEDUP_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

const MAX_ERROR_SAMPLES: usize = 3;

fn lock_cancelled_tasks() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    DEDUP_CANCELLED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_task(task_id: &str) -> Arc<AtomicBool> {
    let mut tasks = lock_cancelled_tasks();
    tasks
        .entry(task_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn cleanup_task(task_id: &str) {
    let mut tasks = lock_cancelled_tasks();
    tasks.remove(task_id);
}

fn mark_task_cancelled(task_id: &str) {
    let mut tasks = lock_cancelled_tasks();
    let cancelled = tasks
        .entry(task_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    cancelled.store(true, Ordering::Relaxed);
}

fn matches_scope(path: &Path, scope: &str) -> bool {
    if scope == "all" {
        return true;
    }

    let ext = path
        .extension()
        .map(|e| {
            let ext = e.to_string_lossy();
            if ext.is_ascii() {
                ext.to_ascii_lowercase()
            } else {
                ext.to_lowercase()
            }
        })
        .unwrap_or_default();

    let is_image = ["jpg", "jpeg", "png", "gif", "bmp", "webp"].contains(&ext.as_str());
    let is_video = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].contains(&ext.as_str());

    match scope {
        "media" => is_image || is_video,
        _ => true,
    }
}

fn push_issue(sample_errors: &mut Vec<DedupIssue>, path: Option<&Path>, reason: impl Into<String>) {
    if sample_errors.len() >= MAX_ERROR_SAMPLES {
        return;
    }

    sample_errors.push(DedupIssue {
        path: path
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "(未知路径)".into()),
        reason: reason.into(),
    });
}

fn push_issue_entry(sample_errors: &mut Vec<DedupIssue>, issue: DedupIssue) {
    if sample_errors.len() >= MAX_ERROR_SAMPLES {
        return;
    }
    sample_errors.push(issue);
}

fn build_file_info(path: &Path, meta: &std::fs::Metadata) -> FileInfo {
    FileInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        size: meta.len(),
        created: meta
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        modified: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
    }
}

fn verify_deletion_candidates(
    selected_paths: &[String],
    groups: &[DeleteGroupInput],
) -> (Vec<String>, Vec<DeleteFailure>) {
    let selected_set: HashSet<&str> = selected_paths.iter().map(String::as_str).collect();
    let relevant_groups: Vec<&DeleteGroupInput> = groups
        .iter()
        .filter(|group| {
            group
                .files
                .iter()
                .any(|path| selected_set.contains(path.as_str()))
        })
        .collect();

    let mut paths_to_hash = HashSet::new();
    for group in &relevant_groups {
        for path in &group.files {
            paths_to_hash.insert(path.clone());
        }
    }

    let hash_results: HashMap<String, Result<String, String>> = paths_to_hash
        .into_par_iter()
        .map(|path| {
            let result = calculate_full_hash(Path::new(&path));
            (path, result)
        })
        .collect();

    let mut verified = Vec::new();
    let mut failed = Vec::new();
    let mut processed = HashSet::new();

    for group in relevant_groups {
        let selected_in_group: Vec<&String> = group
            .files
            .iter()
            .filter(|path| selected_set.contains(path.as_str()))
            .collect();
        if selected_in_group.is_empty() {
            continue;
        }

        let kept_in_group: Vec<&String> = group
            .files
            .iter()
            .filter(|path| !selected_set.contains(path.as_str()))
            .collect();

        if kept_in_group.is_empty() {
            for path in selected_in_group {
                processed.insert(path.clone());
                failed.push(DeleteFailure {
                    path: path.clone(),
                    reason: "请至少保留 1 个文件".into(),
                });
            }
            continue;
        }

        let keep_hashes: HashSet<String> = kept_in_group
            .iter()
            .filter_map(|path| match hash_results.get(path.as_str()) {
                Some(Ok(hash)) => Some(hash.clone()),
                _ => None,
            })
            .collect();

        if keep_hashes.is_empty() {
            for path in selected_in_group {
                processed.insert(path.clone());
                failed.push(DeleteFailure {
                    path: path.clone(),
                    reason: "删除前校验失败：无法读取保留文件".into(),
                });
            }
            continue;
        }

        for path in selected_in_group {
            processed.insert(path.clone());
            match hash_results.get(path.as_str()) {
                Some(Ok(hash)) if keep_hashes.contains(hash) => verified.push(path.clone()),
                Some(Ok(_)) => failed.push(DeleteFailure {
                    path: path.clone(),
                    reason: "删除前校验未通过：内容与保留文件不一致".into(),
                }),
                Some(Err(reason)) => failed.push(DeleteFailure {
                    path: path.clone(),
                    reason: format!("删除前校验失败：{}", reason),
                }),
                None => failed.push(DeleteFailure {
                    path: path.clone(),
                    reason: "删除前校验失败：缺少校验结果".into(),
                }),
            }
        }
    }

    for path in selected_paths {
        if !processed.contains(path) {
            failed.push(DeleteFailure {
                path: path.clone(),
                reason: "缺少分组信息，已取消删除".into(),
            });
        }
    }

    verified.sort();
    verified.dedup();
    failed.sort_by(|a, b| a.path.cmp(&b.path));
    failed.dedup_by(|a, b| a.path == b.path && a.reason == b.reason);

    (verified, failed)
}

#[derive(Debug, Serialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub created: u64,
    pub modified: u64,
}

#[derive(Debug, Serialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub files: Vec<FileInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DedupIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct DedupResult {
    pub groups: Vec<DuplicateGroup>,
    pub total_groups: usize,
    pub total_duplicates: usize,
    pub wasted_size: u64,
    pub skipped_files: usize,
    pub unreadable_files: usize,
    pub permission_denied_files: usize,
    pub hash_failed_files: usize,
    pub sample_errors: Vec<DedupIssue>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DedupProgress {
    pub task_id: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeleteFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DeleteGroupInput {
    pub files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DeleteFilesResult {
    pub deleted_count: u32,
    pub failed: Vec<DeleteFailure>,
}

#[tauri::command]
pub async fn find_duplicates(
    app: AppHandle,
    path: String,
    task_id: String,
    scope: Option<String>,
) -> Result<DedupResult, String> {
    let cancelled = register_task(&task_id);
    let scope = scope.unwrap_or_else(|| "all".to_string());
    let start_time = Instant::now();
    let task_id_for_cleanup = task_id.clone();

    info!("[去重] 开始扫描: {}", path);

    let task_result = tokio::task::spawn_blocking(move || {
        let root_metadata =
            fs::metadata(&path).map_err(|error| format!("无法访问所选文件夹: {}", error))?;
        if !root_metadata.is_dir() {
            return Err("请选择文件夹，而不是单个文件".into());
        }

        let mut size_map: HashMap<u64, Vec<FileInfo>> = HashMap::new();
        let mut unreadable_files = 0usize;
        let mut permission_denied_files = 0usize;
        let mut hash_failed_files = 0usize;
        let mut sample_errors = Vec::new();

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
        let mut file_count = 0usize;
        let mut last_progress_emit = Instant::now();

        for entry_result in WalkDir::new(&path).into_iter() {
            if cancelled.load(Ordering::Relaxed) {
                info!("[去重] 用户取消操作");
                return Err("操作已取消".to_string());
            }

            let entry = match entry_result {
                Ok(entry) => entry,
                Err(error) => {
                    unreadable_files += 1;
                    if error.io_error().is_some_and(|io_error| {
                        io_error.kind() == std::io::ErrorKind::PermissionDenied
                    }) {
                        permission_denied_files += 1;
                    }
                    push_issue(&mut sample_errors, error.path(), error.to_string());
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            if !matches_scope(entry.path(), &scope) {
                continue;
            }

            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(error) => {
                    unreadable_files += 1;
                    if error.io_error().is_some_and(|io_error| {
                        io_error.kind() == std::io::ErrorKind::PermissionDenied
                    }) {
                        permission_denied_files += 1;
                    }
                    push_issue(
                        &mut sample_errors,
                        Some(entry.path()),
                        format!("无法读取文件信息: {}", error),
                    );
                    continue;
                }
            };

            let file_info = build_file_info(entry.path(), &meta);
            size_map.entry(file_info.size).or_default().push(file_info);
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
        info!(
            "[去重] 扫描完成: {} 个文件, 耗时 {:?}",
            file_count,
            scan_start.elapsed()
        );

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

        let sample_results: Vec<Result<(u64, String, FileInfo), DedupIssue>> = files_to_sample
            .par_iter()
            .filter_map(|file_info| {
                if cancelled_clone.load(Ordering::Relaxed) {
                    return None;
                }

                let result = calculate_sample_hash(Path::new(&file_info.path), file_info.size)
                    .map(|hash| (file_info.size, hash, file_info.clone()))
                    .map_err(|error| DedupIssue {
                        path: file_info.path.clone(),
                        reason: format!("无法计算快速指纹: {}", error),
                    });

                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                if current > last && (current - last >= 20 || current == total_to_sample) {
                    if last_reported
                        .compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed)
                        .is_ok()
                    {
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

                Some(result)
            })
            .collect();

        if cancelled.load(Ordering::Relaxed) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }
        info!("[去重] 快速筛选完成, 耗时 {:?}", sample_start.elapsed());

        let mut sample_map: HashMap<(u64, String), Vec<FileInfo>> = HashMap::new();
        for result in sample_results {
            match result {
                Ok((size, hash, file_info)) => {
                    sample_map.entry((size, hash)).or_default().push(file_info);
                }
                Err(issue) => {
                    hash_failed_files += 1;
                    push_issue_entry(&mut sample_errors, issue);
                }
            }
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

        let exact_results: Vec<Result<(String, FileInfo), DedupIssue>> = files_to_hash
            .par_iter()
            .filter_map(|file_info| {
                if cancelled_clone.load(Ordering::Relaxed) {
                    return None;
                }

                let result = calculate_confirm_hash(Path::new(&file_info.path), file_info.size)
                    .map(|hash| (hash, file_info.clone()))
                    .map_err(|error| DedupIssue {
                        path: file_info.path.clone(),
                        reason: format!("无法确认重复候选: {}", error),
                    });

                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                if current > last && (current - last >= 20 || current == total_to_hash) {
                    if last_reported
                        .compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed)
                        .is_ok()
                    {
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

                Some(result)
            })
            .collect();

        if cancelled.load(Ordering::Relaxed) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }

        let mut hash_map: HashMap<String, Vec<FileInfo>> = HashMap::new();
        for result in exact_results {
            match result {
                Ok((hash, file_info)) => {
                    hash_map.entry(hash).or_default().push(file_info);
                }
                Err(issue) => {
                    hash_failed_files += 1;
                    push_issue_entry(&mut sample_errors, issue);
                }
            }
        }
        info!("[去重] 哈希计算完成, 耗时 {:?}", hash_start.elapsed());

        let mut groups: Vec<DuplicateGroup> = hash_map
            .into_iter()
            .filter(|(_, files)| files.len() > 1)
            .map(|(hash, files)| DuplicateGroup {
                size: files[0].size,
                hash,
                files,
            })
            .collect();

        groups.sort_by(|a, b| {
            let a_wasted = a
                .size
                .saturating_mul(a.files.len().saturating_sub(1) as u64);
            let b_wasted = b
                .size
                .saturating_mul(b.files.len().saturating_sub(1) as u64);
            b_wasted
                .cmp(&a_wasted)
                .then_with(|| b.files.len().cmp(&a.files.len()))
                .then_with(|| b.size.cmp(&a.size))
        });

        let total_groups = groups.len();
        let total_duplicates: usize = groups.iter().map(|group| group.files.len() - 1).sum();
        let wasted_size: u64 = groups
            .iter()
            .map(|group| {
                group
                    .size
                    .saturating_mul(group.files.len().saturating_sub(1) as u64)
            })
            .sum();
        let skipped_files = unreadable_files + hash_failed_files;

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
            skipped_files,
            unreadable_files,
            permission_denied_files,
            hash_failed_files,
            sample_errors,
        })
    })
    .await;

    cleanup_task(&task_id_for_cleanup);

    let result = task_result.map_err(|error| format!("任务执行失败: {}", error))??;

    info!(
        "[去重] 完成: {} 组重复, {} 个重复文件, 可释放 {} bytes, 总耗时 {:?}",
        result.total_groups,
        result.total_duplicates,
        result.wasted_size,
        start_time.elapsed()
    );

    Ok(result)
}

#[tauri::command]
pub fn delete_files(
    paths: Vec<String>,
    use_trash: bool,
    groups: Vec<DeleteGroupInput>,
    verify_before_delete: bool,
) -> Result<DeleteFilesResult, String> {
    info!(
        "[删除] 准备删除 {} 个文件, 使用回收站: {}",
        paths.len(),
        use_trash
    );

    let (verified_paths, mut failed) = if verify_before_delete {
        verify_deletion_candidates(&paths, &groups)
    } else {
        (paths, Vec::new())
    };
    let mut deleted_count = 0u32;

    for path in verified_paths {
        let delete_result = if use_trash {
            trash::delete(&path)
        } else {
            fs::remove_file(&path).map_err(|error| trash::Error::Unknown {
                description: error.to_string(),
            })
        };

        match delete_result {
            Ok(()) => {
                deleted_count += 1;
                debug!("[删除] 已删除: {}", path);
            }
            Err(error) => {
                warn!("[删除] 删除失败: {} ({})", path, error);
                failed.push(DeleteFailure {
                    path,
                    reason: error.to_string(),
                });
            }
        }
    }

    info!(
        "[删除] 完成: 成功删除 {} 个文件, 失败 {} 个",
        deleted_count,
        failed.len()
    );

    Ok(DeleteFilesResult {
        deleted_count,
        failed,
    })
}

#[tauri::command]
pub fn cancel_dedup(task_id: String) {
    info!("[去重] 收到取消请求: {}", task_id);
    mark_task_cancelled(&task_id);
}

#[tauri::command]
pub fn get_file_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    let path_lower = path.to_lowercase();
    let ext = path_lower.rsplit('.').next().unwrap_or("");

    if ["jpg", "jpeg", "png", "gif", "bmp", "webp"].contains(&ext) {
        let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        if size > 512 * 1024 {
            return generate_thumbnail_with_ffmpeg(&app, &path, false);
        }

        let data = fs::read(&path).map_err(|error| error.to_string())?;
        let mime = match ext {
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        return Ok(format!("data:{};base64,{}", mime, BASE64.encode(&data)));
    }

    if ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].contains(&ext) {
        return generate_thumbnail_with_ffmpeg(&app, &path, true);
    }

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
        .map_err(|error| format!("执行 ffmpeg 失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("生成缩略图失败: {}", stderr));
    }

    let data = fs::read(&temp_file).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&temp_file);
    Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(&data)))
}

fn build_temp_thumbnail_path() -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("thumb_{}_{}.jpg", std::process::id(), unique))
}

fn calculate_sample_hash(path: &Path, size: u64) -> Result<String, String> {
    use memmap2::Mmap;
    use xxhash_rust::xxh3::Xxh3;

    const TINY_FILE: u64 = 256 * 1024;
    const SAMPLE_SIZE: usize = 512 * 1024;

    if size == 0 {
        return Ok("empty".into());
    }

    let file = File::open(path).map_err(|error| error.to_string())?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|error| error.to_string())?;
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

fn calculate_confirm_hash(path: &Path, size: u64) -> Result<String, String> {
    use memmap2::Mmap;
    use xxhash_rust::xxh3::Xxh3;

    const SMALL_FILE: u64 = 4 * 1024 * 1024;
    const SAMPLE_SIZE: usize = 2 * 1024 * 1024;

    if size == 0 {
        return Ok("empty".into());
    }

    let file = File::open(path).map_err(|error| error.to_string())?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|error| error.to_string())?;
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

fn calculate_full_hash(path: &Path) -> Result<String, String> {
    use xxhash_rust::xxh3::Xxh3;

    const BUFFER_SIZE: usize = 1024 * 1024;

    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(BUFFER_SIZE, file);
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; BUFFER_SIZE];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:016x}", hasher.digest()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "dedup-test-{}-{}-{}",
                std::process::id(),
                NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("failed to create temp test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn sample_hash_can_match_while_full_hash_still_differs() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("a.bin");
        let second = temp_dir.path().join("b.bin");

        let size = 10 * 1024 * 1024;
        let data_a = vec![0_u8; size];
        let mut data_b = data_a.clone();
        data_b[3 * 1024 * 1024] = 1;

        fs::write(&first, &data_a).expect("failed to write first file");
        fs::write(&second, &data_b).expect("failed to write second file");

        let sample_hash_a = calculate_sample_hash(&first, size as u64)
            .expect("sample hash for first file should succeed");
        let sample_hash_b = calculate_sample_hash(&second, size as u64)
            .expect("sample hash for second file should succeed");
        assert_eq!(sample_hash_a, sample_hash_b);

        let confirm_hash_a = calculate_confirm_hash(&first, size as u64)
            .expect("confirm hash for first file should succeed");
        let confirm_hash_b = calculate_confirm_hash(&second, size as u64)
            .expect("confirm hash for second file should succeed");
        assert_eq!(confirm_hash_a, confirm_hash_b);

        let full_hash_a =
            calculate_full_hash(&first).expect("full hash for first file should succeed");
        let full_hash_b =
            calculate_full_hash(&second).expect("full hash for second file should succeed");
        assert_ne!(full_hash_a, full_hash_b);
    }

    #[test]
    fn hashes_handle_empty_files() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("empty-a.bin");
        let second = temp_dir.path().join("empty-b.bin");
        fs::write(&first, []).expect("failed to write first empty file");
        fs::write(&second, []).expect("failed to write second empty file");

        let sample_hash_a =
            calculate_sample_hash(&first, 0).expect("sample hash should handle empty file");
        let sample_hash_b =
            calculate_sample_hash(&second, 0).expect("sample hash should handle empty file");
        let confirm_hash_a =
            calculate_confirm_hash(&first, 0).expect("confirm hash should handle empty file");
        let confirm_hash_b =
            calculate_confirm_hash(&second, 0).expect("confirm hash should handle empty file");
        let full_hash_a = calculate_full_hash(&first).expect("full hash should handle empty file");
        let full_hash_b = calculate_full_hash(&second).expect("full hash should handle empty file");

        assert_eq!(sample_hash_a, sample_hash_b);
        assert_eq!(confirm_hash_a, confirm_hash_b);
        assert_eq!(full_hash_a, full_hash_b);
    }

    #[test]
    fn delete_files_reports_failures() {
        let temp_dir = TestDir::new();
        let existing = temp_dir.path().join("keep.txt");
        let missing = temp_dir.path().join("missing.txt");
        fs::write(&existing, b"hello").expect("failed to write test file");

        let result = delete_files(
            vec![
                existing.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
            false,
            vec![DeleteGroupInput {
                files: vec![
                    existing.to_string_lossy().to_string(),
                    missing.to_string_lossy().to_string(),
                ],
            }],
            false,
        )
        .expect("delete_files should return a result");

        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, missing.to_string_lossy());
        assert!(!existing.exists());
    }

    #[test]
    fn delete_files_only_removes_paths_that_match_kept_copy_when_verification_enabled() {
        let temp_dir = TestDir::new();
        let keep = temp_dir.path().join("keep.bin");
        let duplicate = temp_dir.path().join("duplicate.bin");
        let mismatch = temp_dir.path().join("mismatch.bin");

        let size = 10 * 1024 * 1024;
        let base = vec![0_u8; size];
        let mut different = base.clone();
        different[3 * 1024 * 1024] = 1;

        fs::write(&keep, &base).expect("failed to write keep file");
        fs::write(&duplicate, &base).expect("failed to write duplicate file");
        fs::write(&mismatch, &different).expect("failed to write mismatch file");

        let result = delete_files(
            vec![
                duplicate.to_string_lossy().to_string(),
                mismatch.to_string_lossy().to_string(),
            ],
            false,
            vec![DeleteGroupInput {
                files: vec![
                    keep.to_string_lossy().to_string(),
                    duplicate.to_string_lossy().to_string(),
                    mismatch.to_string_lossy().to_string(),
                ],
            }],
            true,
        )
        .expect("delete_files should verify before deleting");

        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, mismatch.to_string_lossy());
        assert!(keep.exists());
        assert!(!duplicate.exists());
        assert!(mismatch.exists());
    }
}
