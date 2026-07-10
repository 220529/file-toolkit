use log::{debug, info, warn};
use rayon::prelude::*;
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::ffmpeg_utils::get_ffmpeg_path;
use super::file_ops::{path_collision_key, validate_input_file};

lazy_static::lazy_static! {
    static ref DEDUP_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

const MAX_ERROR_SAMPLES: usize = 3;
const DEFAULT_DEDUP_IO_THREADS: usize = 1;
const QUICK_SAMPLE_SIZE: usize = 16 * 1024;
const TINY_FILE: u64 = 128 * 1024;

fn dedup_io_threads() -> usize {
    std::env::var("FILE_TOOLKIT_DEDUP_IO_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, 8))
        .unwrap_or(DEFAULT_DEDUP_IO_THREADS)
}

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
    let tasks = lock_cancelled_tasks();
    if let Some(cancelled) = tasks.get(task_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
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
    let is_audio = ["mp3", "wav", "flac", "aac", "ogg", "m4a"].contains(&ext.as_str());

    match scope {
        "media" => is_image || is_video || is_audio,
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

fn sort_files_for_io(files: &mut [FileInfo]) {
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
}

fn filter_rate(before: usize, after: usize) -> f64 {
    if before == 0 {
        return 0.0;
    }

    let kept = after.min(before) as f64 / before as f64;
    (1.0 - kept) * 100.0
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

const APPLEDOUBLE_MAGIC: [u8; 4] = [0x00, 0x05, 0x16, 0x07];

#[cfg(unix)]
fn appledouble_sibling_path(path: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    let file_name = path.file_name()?;
    let sibling_name = file_name.as_bytes().strip_prefix(b"._")?;
    if sibling_name.is_empty() {
        return None;
    }

    Some(
        path.parent()?
            .join(OsString::from_vec(sibling_name.to_vec())),
    )
}

#[cfg(not(unix))]
fn appledouble_sibling_path(path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_string_lossy();
    let sibling_name = file_name.strip_prefix("._")?;
    if sibling_name.is_empty() {
        return None;
    }

    Some(path.parent()?.join(sibling_name))
}

fn has_appledouble_magic(path: &Path) -> bool {
    let mut header = [0u8; APPLEDOUBLE_MAGIC.len()];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(()) = file.read_exact(&mut header) else {
        return false;
    };
    header == APPLEDOUBLE_MAGIC
}

fn is_appledouble_sidecar(path: &Path) -> bool {
    let Some(sibling_path) = appledouble_sibling_path(path) else {
        return false;
    };

    sibling_path.exists() || has_appledouble_magic(path)
}

fn should_skip_dedup_file(path: &Path) -> bool {
    is_appledouble_sidecar(path)
}

fn delete_path(path: &str, use_trash: bool) -> Result<(), trash::Error> {
    if use_trash {
        move_to_trash(path)
    } else {
        fs::remove_file(path).map_err(|error| trash::Error::Unknown {
            description: error.to_string(),
        })
    }
}

#[derive(Clone)]
struct DedupStageContext {
    io_threads: usize,
    cancelled: Arc<AtomicBool>,
    app: AppHandle,
    task_id: String,
}

struct DedupStageProgress {
    stage: &'static str,
    detail: Option<&'static str>,
    base_percent: f64,
    percent_span: f64,
    report_current_offset: usize,
    report_total_override: Option<usize>,
}

fn run_dedup_stage<T, F>(
    files: &[FileInfo],
    context: DedupStageContext,
    progress: DedupStageProgress,
    worker: F,
) -> Vec<Result<T, DedupIssue>>
where
    T: Send,
    F: Fn(&FileInfo) -> Result<T, DedupIssue> + Sync,
{
    if files.is_empty() {
        let reported_total = progress.report_total_override.unwrap_or(0);
        let _ = context.app.emit(
            "dedup-progress",
            DedupProgress {
                task_id: context.task_id,
                stage: progress.stage.into(),
                detail: progress.detail.map(str::to_string),
                current: progress.report_current_offset,
                total: reported_total,
                percent: progress.base_percent + progress.percent_span,
            },
        );
        return Vec::new();
    }

    let total = files.len();
    let reported_total = progress
        .report_total_override
        .unwrap_or(total)
        .max(progress.report_current_offset + total);
    let progress_counter = Arc::new(AtomicUsize::new(0));
    let last_reported = Arc::new(AtomicUsize::new(0));
    let last_logged = Arc::new(AtomicUsize::new(0));
    let report_every = (total / 200).clamp(1, 100);
    let log_every = (total / 20).clamp(1, 1000);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(context.io_threads)
        .thread_name(|index| format!("dedup-io-{}", index))
        .build()
        .expect("dedup thread pool should build");

    pool.install(|| {
        files
            .par_iter()
            .filter_map(|file_info| {
                if context.cancelled.load(Ordering::Relaxed) {
                    return None;
                }

                let result = worker(file_info);
                let current = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let last = last_reported.load(Ordering::Relaxed);
                let should_report = current == 1
                    || current == total
                    || current.saturating_sub(last) >= report_every;

                if should_report
                    && last_reported
                        .compare_exchange(last, current, Ordering::SeqCst, Ordering::Relaxed)
                        .is_ok()
                {
                    let percent = progress.base_percent
                        + (current as f64 / total as f64) * progress.percent_span;
                    let reported_current =
                        (progress.report_current_offset + current).min(reported_total);
                    let _ = context.app.emit(
                        "dedup-progress",
                        DedupProgress {
                            task_id: context.task_id.clone(),
                            stage: progress.stage.into(),
                            detail: progress.detail.map(str::to_string),
                            current: reported_current,
                            total: reported_total,
                            percent,
                        },
                    );

                    let last_log = last_logged.load(Ordering::Relaxed);
                    if (current == 1
                        || current == total
                        || current.saturating_sub(last_log) >= log_every)
                        && last_logged
                            .compare_exchange(
                                last_log,
                                current,
                                Ordering::SeqCst,
                                Ordering::Relaxed,
                            )
                            .is_ok()
                    {
                        info!(
                            "[去重] {}进度: {}/{} ({:.1}%)",
                            progress.stage,
                            current,
                            total,
                            (current as f64 / total as f64) * 100.0
                        );
                    }
                }

                Some(result)
            })
            .collect()
    })
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &str) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    use trash::TrashContext;

    let mut finder_ctx = TrashContext::new();
    finder_ctx.set_delete_method(DeleteMethod::Finder);

    match finder_ctx.delete(path) {
        Ok(()) => Ok(()),
        Err(finder_error) => {
            debug!("[删除] Finder 回收站失败，尝试 NSFileManager");

            let mut fallback_ctx = TrashContext::new();
            fallback_ctx.set_delete_method(DeleteMethod::NsFileManager);
            fallback_ctx
                .delete(path)
                .map_err(|fallback_error| trash::Error::Unknown {
                    description: format!(
                        "Finder 回收站失败: {}; NSFileManager 回收站失败: {}",
                        finder_error, fallback_error
                    ),
                })
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(path: &str) -> Result<(), trash::Error> {
    trash::delete(path)
}

fn validate_keep_one_selection(
    selected_paths: &[String],
    groups: &[DeleteGroupInput],
) -> (Vec<String>, Vec<DeleteFailure>) {
    let mut unique_selected = Vec::new();
    let mut selected_keys = HashSet::new();
    let mut failed = Vec::new();

    for path in selected_paths {
        let key = path_collision_key(Path::new(path));
        if selected_keys.insert(key) {
            unique_selected.push(path.clone());
        } else {
            failed.push(DeleteFailure {
                path: path.clone(),
                reason: "重复选择，已取消处理".into(),
            });
        }
    }

    let mut membership: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, group) in groups.iter().enumerate() {
        let mut group_keys = HashSet::new();
        for path in &group.files {
            let key = path_collision_key(Path::new(path));
            if group_keys.insert(key.clone()) {
                membership.entry(key).or_default().push(index);
            }
        }
    }

    let mut valid = Vec::new();
    for path in unique_selected {
        let key = path_collision_key(Path::new(&path));
        let Some(group_indexes) = membership.get(&key) else {
            failed.push(DeleteFailure {
                path,
                reason: "缺少重复分组信息，已取消删除".into(),
            });
            continue;
        };
        if group_indexes.len() != 1 {
            failed.push(DeleteFailure {
                path,
                reason: "文件出现在多个重复分组中，已取消删除".into(),
            });
            continue;
        }

        let has_readable_keeper = groups[group_indexes[0]].files.iter().any(|keeper| {
            !selected_keys.contains(&path_collision_key(Path::new(keeper)))
                && validate_input_file(Path::new(keeper)).is_ok()
        });
        if !has_readable_keeper {
            failed.push(DeleteFailure {
                path,
                reason: "请至少保留 1 个当前可读取的文件".into(),
            });
            continue;
        }
        valid.push(path);
    }

    (valid, failed)
}

struct DeletionCandidate {
    path: String,
    file: File,
    handle: Handle,
    size: u64,
    modified: Option<std::time::SystemTime>,
}

impl DeletionCandidate {
    fn capture(path: String) -> Result<Self, DeleteFailure> {
        validate_input_file(Path::new(&path)).map_err(|reason| DeleteFailure {
            path: path.clone(),
            reason,
        })?;
        let file = File::open(&path).map_err(|error| DeleteFailure {
            path: path.clone(),
            reason: format!("删除前无法打开文件: {}", error),
        })?;
        let handle = Handle::from_file(file.try_clone().map_err(|error| DeleteFailure {
            path: path.clone(),
            reason: format!("删除前无法复制文件句柄: {}", error),
        })?)
        .map_err(|error| DeleteFailure {
            path: path.clone(),
            reason: format!("删除前无法锁定文件身份: {}", error),
        })?;
        let metadata = file.metadata().map_err(|error| DeleteFailure {
            path: path.clone(),
            reason: format!("删除前无法读取文件信息: {}", error),
        })?;

        Ok(Self {
            path,
            file,
            handle,
            size: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }

    fn is_unchanged(&self) -> bool {
        let Ok(current_handle) = Handle::from_path(&self.path) else {
            return false;
        };
        let Ok(path_metadata) = fs::metadata(&self.path) else {
            return false;
        };
        let Ok(handle_metadata) = self.file.metadata() else {
            return false;
        };

        current_handle == self.handle
            && path_metadata.len() == self.size
            && path_metadata.modified().ok() == self.modified
            && handle_metadata.len() == self.size
            && handle_metadata.modified().ok() == self.modified
    }

    fn full_hash(&self) -> Result<String, String> {
        let file = self
            .file
            .try_clone()
            .map_err(|error| format!("复制文件句柄失败: {}", error))?;
        calculate_full_hash_from_file(file)
    }
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
    pub detail: Option<String>,
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

    info!("[去重] 开始扫描目录");

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
                detail: Some("递归读取目录结构".into()),
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

            if should_skip_dedup_file(entry.path()) {
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
                        detail: Some("递归读取目录结构".into()),
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
                detail: Some("递归读取目录结构".into()),
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

        let mut files_to_sample: Vec<FileInfo> = size_map
            .iter()
            .filter(|(_, files)| files.len() >= 2)
            .flat_map(|(_, files)| files.iter().cloned())
            .collect();
        sort_files_for_io(&mut files_to_sample);

        let total_to_sample = files_to_sample.len();
        info!("[去重] 需要快速筛选: {} 个文件", total_to_sample);

        let sample_start = Instant::now();
        let io_threads = dedup_io_threads();
        info!(
            "[去重] 初步筛选尾部指纹开始: {} 个文件, I/O 并发 {}",
            total_to_sample, io_threads
        );
        let tail_sample_results = run_dedup_stage(
            &files_to_sample,
            DedupStageContext {
                io_threads,
                cancelled: cancelled.clone(),
                app: app.clone(),
                task_id: task_id.clone(),
            },
            DedupStageProgress {
                stage: "初步筛选重复文件",
                detail: Some("读取尾部指纹，缩小同尺寸候选"),
                base_percent: 0.0,
                percent_span: 35.0,
                report_current_offset: 0,
                report_total_override: Some(total_to_sample.saturating_mul(2)),
            },
            |file_info| {
                calculate_tail_sample_hash(Path::new(&file_info.path), file_info.size)
                    .map(|hash| (file_info.size, hash, file_info.clone()))
                    .map_err(|error| DedupIssue {
                        path: file_info.path.clone(),
                        reason: format!("无法计算尾部指纹: {}", error),
                    })
            },
        );

        if cancelled.load(Ordering::Relaxed) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }

        let mut tail_sample_map: HashMap<(u64, String), Vec<FileInfo>> = HashMap::new();
        for result in tail_sample_results {
            match result {
                Ok((size, hash, file_info)) => {
                    tail_sample_map
                        .entry((size, hash))
                        .or_default()
                        .push(file_info);
                }
                Err(issue) => {
                    hash_failed_files += 1;
                    push_issue_entry(&mut sample_errors, issue);
                }
            }
        }

        let mut sample_map: HashMap<(u64, String), Vec<FileInfo>> = HashMap::new();
        let mut files_to_middle_sample = Vec::new();
        let mut tail_hash_by_path: HashMap<String, String> = HashMap::new();
        let mut small_file_candidates = 0usize;
        for ((size, tail_hash), files) in tail_sample_map {
            if files.len() <= 1 {
                continue;
            }

            if size <= QUICK_SAMPLE_SIZE as u64 {
                small_file_candidates += files.len();
                sample_map
                    .entry((size, tail_hash))
                    .or_default()
                    .extend(files);
            } else {
                for file_info in files {
                    tail_hash_by_path.insert(file_info.path.clone(), tail_hash.clone());
                    files_to_middle_sample.push(file_info);
                }
            }
        }
        sort_files_for_io(&mut files_to_middle_sample);

        let total_to_middle_sample = files_to_middle_sample.len();
        let tail_candidate_count = total_to_middle_sample + small_file_candidates;
        let tail_filter_rate = filter_rate(total_to_sample, tail_candidate_count);
        info!(
            "[去重] 尾部指纹筛选完成: {} -> {} 个候选, 过滤 {:.1}%, 小文件跳过中段采样 {} 个",
            total_to_sample, tail_candidate_count, tail_filter_rate, small_file_candidates
        );
        info!("[去重] 需要中段指纹确认: {} 个文件", total_to_middle_sample);

        let middle_sample_results = run_dedup_stage(
            &files_to_middle_sample,
            DedupStageContext {
                io_threads,
                cancelled: cancelled.clone(),
                app: app.clone(),
                task_id: task_id.clone(),
            },
            DedupStageProgress {
                stage: "初步筛选重复文件",
                detail: Some("读取中段指纹，继续缩小候选"),
                base_percent: 35.0,
                percent_span: 35.0,
                report_current_offset: total_to_sample,
                report_total_override: Some(total_to_sample + total_to_middle_sample),
            },
            |file_info| {
                calculate_middle_sample_hash(Path::new(&file_info.path), file_info.size)
                    .map(|middle_hash| {
                        let tail_hash = tail_hash_by_path
                            .get(&file_info.path)
                            .cloned()
                            .unwrap_or_default();
                        (
                            file_info.size,
                            format!("{}:{}", tail_hash, middle_hash),
                            file_info.clone(),
                        )
                    })
                    .map_err(|error| DedupIssue {
                        path: file_info.path.clone(),
                        reason: format!("无法计算中段指纹: {}", error),
                    })
            },
        );

        if cancelled.load(Ordering::Relaxed) {
            info!("[去重] 用户取消操作");
            return Err("操作已取消".to_string());
        }
        info!("[去重] 快速筛选完成, 耗时 {:?}", sample_start.elapsed());

        for result in middle_sample_results {
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
        let mut files_to_hash = files_to_hash;
        sort_files_for_io(&mut files_to_hash);

        let total_to_hash = files_to_hash.len();
        let sample_filter_rate = filter_rate(total_to_sample, total_to_hash);
        info!(
            "[去重] 快速筛选候选完成: {} -> {} 个精确候选, 过滤 {:.1}%",
            total_to_sample, total_to_hash, sample_filter_rate
        );
        info!("[去重] 需要精确比对: {} 个文件", total_to_hash);

        let hash_start = Instant::now();
        info!(
            "[去重] 精确确认开始: {} 个文件, I/O 并发 {}",
            total_to_hash, io_threads
        );
        let exact_results = run_dedup_stage(
            &files_to_hash,
            DedupStageContext {
                io_threads,
                cancelled: cancelled.clone(),
                app: app.clone(),
                task_id: task_id.clone(),
            },
            DedupStageProgress {
                stage: "确认重复文件",
                detail: Some("完整读取候选文件，确认内容完全一致"),
                base_percent: 70.0,
                percent_span: 30.0,
                report_current_offset: 0,
                report_total_override: None,
            },
            |file_info| {
                calculate_full_hash(Path::new(&file_info.path))
                    .map(|hash| (hash, file_info.clone()))
                    .map_err(|error| DedupIssue {
                        path: file_info.path.clone(),
                        reason: format!("无法确认重复候选: {}", error),
                    })
            },
        );

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
                detail: Some("已完成重复确认".into()),
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
pub async fn delete_files(
    paths: Vec<String>,
    use_trash: bool,
    groups: Vec<DeleteGroupInput>,
    verify_before_delete: bool,
) -> Result<DeleteFilesResult, String> {
    tokio::task::spawn_blocking(move || {
        delete_files_inner(paths, use_trash, groups, verify_before_delete)
    })
    .await
    .map_err(|error| format!("删除任务执行失败: {}", error))?
}

fn delete_files_inner(
    paths: Vec<String>,
    use_trash: bool,
    groups: Vec<DeleteGroupInput>,
    _verify_before_delete: bool,
) -> Result<DeleteFilesResult, String> {
    info!(
        "[删除] 准备删除 {} 个文件, 使用回收站: {}",
        paths.len(),
        use_trash
    );

    let (valid_paths, mut failed) = validate_keep_one_selection(&paths, &groups);
    let selected_keys: HashSet<String> = valid_paths
        .iter()
        .map(|path| path_collision_key(Path::new(path)))
        .collect();
    let mut group_index_by_path = HashMap::new();
    for (group_index, group) in groups.iter().enumerate() {
        for path in &group.files {
            let key = path_collision_key(Path::new(path));
            if selected_keys.contains(&key) {
                group_index_by_path.insert(key, group_index);
            }
        }
    }

    let mut deleted_count = 0u32;

    for path in valid_paths {
        let path_key = path_collision_key(Path::new(&path));
        let Some(group_index) = group_index_by_path.get(&path_key).copied() else {
            failed.push(DeleteFailure {
                path,
                reason: "删除前无法确定唯一重复分组".into(),
            });
            continue;
        };
        let candidate = match DeletionCandidate::capture(path.clone()) {
            Ok(candidate) => candidate,
            Err(failure) => {
                failed.push(failure);
                continue;
            }
        };
        if !candidate.is_unchanged() {
            failed.push(DeleteFailure {
                path: candidate.path.clone(),
                reason: "待删文件在校验开始前发生变化，已取消删除".into(),
            });
            continue;
        }
        let candidate_hash = match candidate.full_hash() {
            Ok(hash) => hash,
            Err(error) => {
                failed.push(DeleteFailure {
                    path: candidate.path.clone(),
                    reason: format!("删除前无法完整校验待删文件: {}", error),
                });
                continue;
            }
        };
        if !candidate.is_unchanged() {
            failed.push(DeleteFailure {
                path: candidate.path.clone(),
                reason: "待删文件在完整校验期间发生变化，已取消删除".into(),
            });
            continue;
        }

        // Keep only the candidate and one possible keeper open at a time. Large duplicate
        // sets otherwise exhaust the process file-descriptor limit before deletion starts.
        let mut matching_keeper = None;
        for keeper_path in &groups[group_index].files {
            if selected_keys.contains(&path_collision_key(Path::new(keeper_path))) {
                continue;
            }
            let Ok(keeper) = DeletionCandidate::capture(keeper_path.clone()) else {
                continue;
            };
            if !keeper.is_unchanged() {
                continue;
            }
            let Ok(keeper_hash) = keeper.full_hash() else {
                continue;
            };
            if keeper_hash == candidate_hash && keeper.is_unchanged() {
                matching_keeper = Some(keeper);
                break;
            }
        }
        let Some(keeper) = matching_keeper else {
            failed.push(DeleteFailure {
                path: candidate.path.clone(),
                reason: "删除前校验失败：没有当前可读取且内容相同的保留文件".into(),
            });
            continue;
        };

        let final_hashes_match = candidate
            .full_hash()
            .and_then(|candidate_hash| {
                keeper
                    .full_hash()
                    .map(|keeper_hash| candidate_hash == keeper_hash)
            })
            .unwrap_or(false);
        if !final_hashes_match || !candidate.is_unchanged() || !keeper.is_unchanged() {
            failed.push(DeleteFailure {
                path: candidate.path.clone(),
                reason: "文件或保留副本在最终内容复核时发生变化，已取消删除".into(),
            });
            continue;
        }

        let delete_result = delete_path(&candidate.path, use_trash);

        match delete_result {
            Ok(()) => {
                deleted_count += 1;
                debug!("[删除] 已删除文件");
            }
            Err(error) => {
                warn!("[删除] 删除失败");
                failed.push(DeleteFailure {
                    path: candidate.path.clone(),
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

fn calculate_middle_sample_hash(path: &Path, size: u64) -> Result<String, String> {
    use xxhash_rust::xxh3::Xxh3;

    if size == 0 {
        return Ok("empty".into());
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Xxh3::new();

    hasher.update(&size.to_le_bytes());

    if size <= TINY_FILE {
        let mut buffer = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buffer)
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer);
        return Ok(format!("{:016x}", hasher.digest()));
    }

    let sample_len = QUICK_SAMPLE_SIZE.min(size as usize);
    let offset = if size > sample_len as u64 {
        size / 2 - sample_len as u64 / 2
    } else {
        0
    };
    update_hash_from_file_segment(&mut file, &mut hasher, offset, sample_len)?;

    Ok(format!("{:016x}", hasher.digest()))
}

fn calculate_tail_sample_hash(path: &Path, size: u64) -> Result<String, String> {
    use xxhash_rust::xxh3::Xxh3;

    if size == 0 {
        return Ok("empty".into());
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Xxh3::new();
    let sample_len = QUICK_SAMPLE_SIZE.min(size as usize);

    hasher.update(&size.to_le_bytes());
    update_hash_from_file_segment(
        &mut file,
        &mut hasher,
        size.saturating_sub(sample_len as u64),
        sample_len,
    )?;
    Ok(format!("{:016x}", hasher.digest()))
}

fn update_hash_from_file_segment(
    file: &mut File,
    hasher: &mut xxhash_rust::xxh3::Xxh3,
    offset: u64,
    len: usize,
) -> Result<(), String> {
    let mut buffer = vec![0_u8; len];
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    hasher.update(&buffer);
    Ok(())
}

fn calculate_full_hash(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    calculate_full_hash_from_file(file)
}

fn calculate_full_hash_from_file(mut file: File) -> Result<String, String> {
    use xxhash_rust::xxh3::Xxh3;

    const BUFFER_SIZE: usize = 1024 * 1024;

    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
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
    fn middle_sample_hash_can_match_while_full_hash_still_differs() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("a.bin");
        let second = temp_dir.path().join("b.bin");

        let size = 10 * 1024 * 1024;
        let data_a = vec![0_u8; size];
        let mut data_b = data_a.clone();
        data_b[3 * 1024 * 1024] = 1;

        fs::write(&first, &data_a).expect("failed to write first file");
        fs::write(&second, &data_b).expect("failed to write second file");

        let sample_hash_a = calculate_middle_sample_hash(&first, size as u64)
            .expect("sample hash for first file should succeed");
        let sample_hash_b = calculate_middle_sample_hash(&second, size as u64)
            .expect("sample hash for second file should succeed");
        assert_eq!(sample_hash_a, sample_hash_b);

        let full_hash_a =
            calculate_full_hash(&first).expect("full hash for first file should succeed");
        let full_hash_b =
            calculate_full_hash(&second).expect("full hash for second file should succeed");
        assert_ne!(full_hash_a, full_hash_b);
    }

    #[test]
    fn tail_sample_hash_detects_tail_changes() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("tail-a.bin");
        let second = temp_dir.path().join("tail-b.bin");

        let size = 256 * 1024;
        let data_a = vec![0_u8; size];
        let mut data_b = data_a.clone();
        data_b[size - 1] = 1;

        fs::write(&first, &data_a).expect("failed to write first file");
        fs::write(&second, &data_b).expect("failed to write second file");

        let tail_hash_a = calculate_tail_sample_hash(&first, size as u64)
            .expect("tail hash for first file should succeed");
        let tail_hash_b = calculate_tail_sample_hash(&second, size as u64)
            .expect("tail hash for second file should succeed");

        assert_ne!(tail_hash_a, tail_hash_b);
    }

    #[test]
    fn middle_sample_hash_detects_middle_changes() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("middle-a.bin");
        let second = temp_dir.path().join("middle-b.bin");

        let size = 256 * 1024;
        let data_a = vec![0_u8; size];
        let mut data_b = data_a.clone();
        data_b[size / 2] = 1;

        fs::write(&first, &data_a).expect("failed to write first file");
        fs::write(&second, &data_b).expect("failed to write second file");

        let middle_hash_a = calculate_middle_sample_hash(&first, size as u64)
            .expect("middle hash for first file should succeed");
        let middle_hash_b = calculate_middle_sample_hash(&second, size as u64)
            .expect("middle hash for second file should succeed");

        assert_ne!(middle_hash_a, middle_hash_b);
    }

    #[test]
    fn hashes_handle_empty_files() {
        let temp_dir = TestDir::new();
        let first = temp_dir.path().join("empty-a.bin");
        let second = temp_dir.path().join("empty-b.bin");
        fs::write(&first, []).expect("failed to write first empty file");
        fs::write(&second, []).expect("failed to write second empty file");

        let sample_hash_a =
            calculate_middle_sample_hash(&first, 0).expect("sample hash should handle empty file");
        let sample_hash_b =
            calculate_middle_sample_hash(&second, 0).expect("sample hash should handle empty file");
        let full_hash_a = calculate_full_hash(&first).expect("full hash should handle empty file");
        let full_hash_b = calculate_full_hash(&second).expect("full hash should handle empty file");

        assert_eq!(sample_hash_a, sample_hash_b);
        assert_eq!(full_hash_a, full_hash_b);
    }

    #[test]
    fn delete_files_reports_failures() {
        let temp_dir = TestDir::new();
        let existing = temp_dir.path().join("keep.txt");
        let missing = temp_dir.path().join("missing.txt");
        fs::write(&existing, b"hello").expect("failed to write test file");

        let keeper = temp_dir.path().join("keeper.txt");
        fs::write(&keeper, b"hello").expect("failed to write keeper file");

        let result = delete_files_inner(
            vec![
                existing.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
            false,
            vec![DeleteGroupInput {
                files: vec![
                    existing.to_string_lossy().to_string(),
                    missing.to_string_lossy().to_string(),
                    keeper.to_string_lossy().to_string(),
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

        let result = delete_files_inner(
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

    #[test]
    fn appledouble_sidecar_is_skipped_when_matching_file_exists() {
        let temp_dir = TestDir::new();
        let original = temp_dir.path().join("photo.jpg");
        let sidecar = temp_dir.path().join("._photo.jpg");

        fs::write(&original, b"photo").expect("failed to write original file");
        fs::write(&sidecar, b"sidecar").expect("failed to write sidecar file");

        assert!(is_appledouble_sidecar(&sidecar));
        assert!(should_skip_dedup_file(&sidecar));
        assert!(!should_skip_dedup_file(&original));
    }

    #[test]
    fn standalone_appledouble_file_is_skipped_by_magic_header() {
        let temp_dir = TestDir::new();
        let standalone = temp_dir.path().join("._lonely.jpg");

        let mut payload = Vec::from(APPLEDOUBLE_MAGIC);
        payload.extend_from_slice(b"Mac OS X");
        fs::write(&standalone, payload).expect("failed to write standalone file");

        assert!(is_appledouble_sidecar(&standalone));
        assert!(should_skip_dedup_file(&standalone));
    }

    #[test]
    fn standalone_dot_underscore_file_without_appledouble_header_is_not_skipped() {
        let temp_dir = TestDir::new();
        let standalone = temp_dir.path().join("._lonely.jpg");

        fs::write(&standalone, b"standalone").expect("failed to write standalone file");

        assert!(!is_appledouble_sidecar(&standalone));
        assert!(!should_skip_dedup_file(&standalone));
    }

    #[test]
    fn appledouble_sidecar_for_directory_is_skipped() {
        let temp_dir = TestDir::new();
        let original_dir = temp_dir.path().join("album");
        let sidecar = temp_dir.path().join("._album");

        fs::create_dir(&original_dir).expect("failed to create directory");
        fs::write(&sidecar, b"sidecar").expect("failed to write directory sidecar");

        assert!(is_appledouble_sidecar(&sidecar));
        assert!(should_skip_dedup_file(&sidecar));
    }

    #[cfg(unix)]
    #[test]
    fn appledouble_sibling_path_handles_non_utf8_names() {
        use std::ffi::{OsStr, OsString};
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let temp_dir = TestDir::new();
        let sidecar = temp_dir.path().join(OsString::from_vec(vec![
            b'.', b'_', 0xFF, b'p', b'h', b'o', b't', b'o',
        ]));
        let sibling =
            appledouble_sibling_path(&sidecar).expect("non-utf8 sidecar should resolve sibling");

        assert_eq!(sibling.parent(), Some(temp_dir.path()));
        assert_eq!(
            sibling.file_name(),
            Some(OsStr::from_bytes(&[0xFF, b'p', b'h', b'o', b't', b'o']))
        );
    }
}
