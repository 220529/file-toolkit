use lazy_static::lazy_static;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::Metadata;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

lazy_static! {
    static ref FILE_STATS_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> =
        Mutex::new(HashMap::new());
}

const MAX_ERROR_SAMPLES: usize = 3;

fn lock_cancelled_tasks() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    FILE_STATS_CANCELLED
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

fn get_file_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

fn normalize_extension(path: &std::path::Path) -> String {
    path.extension()
        .map(|ext| {
            let ext = ext.to_string_lossy();
            if ext.is_ascii() {
                ext.to_ascii_lowercase()
            } else {
                ext.to_lowercase()
            }
        })
        .unwrap_or_default()
}

fn push_scan_issue(
    sample_errors: &mut Vec<ScanIssue>,
    path: Option<&std::path::Path>,
    reason: impl Into<String>,
) {
    if sample_errors.len() >= MAX_ERROR_SAMPLES {
        return;
    }

    sample_errors.push(ScanIssue {
        path: path
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "(未知路径)".into()),
        reason: reason.into(),
    });
}

fn emit_progress<F>(
    emit: &mut F,
    task_id: &str,
    stage: String,
    current: u64,
    total: u64,
    percent: f64,
    elapsed: Duration,
    skipped_files: u64,
    permission_denied_files: u64,
) where
    F: FnMut(FileStatsProgress),
{
    let elapsed_ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
    let processed = current.saturating_add(skipped_files);
    let files_per_second = if elapsed.as_secs_f64() > 0.0 {
        processed as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };

    emit(FileStatsProgress {
        task_id: task_id.to_string(),
        stage,
        current,
        total,
        percent,
        elapsed_ms,
        files_per_second,
        skipped_files,
        permission_denied_files,
    });
}

fn scan_directory_inner<F>(
    path: &str,
    task_id: &str,
    cancelled: &AtomicBool,
    mut emit: F,
) -> Result<ScanResult, String>
where
    F: FnMut(FileStatsProgress),
{
    let root_metadata =
        std::fs::metadata(path).map_err(|error| format!("无法访问所选文件夹: {}", error))?;
    if !root_metadata.is_dir() {
        return Err("请选择文件夹，而不是单个文件".into());
    }

    let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
    let mut total_files: u64 = 0;
    let mut folder_count: u64 = 0;
    let mut total_size: u64 = 0;
    let mut skipped_files: u64 = 0;
    let mut permission_denied_files: u64 = 0;
    let mut sample_errors = Vec::new();
    let scan_start = Instant::now();
    let mut last_progress_emit = Instant::now();

    emit_progress(
        &mut emit,
        task_id,
        "扫描文件".into(),
        0,
        0,
        0.0,
        scan_start.elapsed(),
        skipped_files,
        permission_denied_files,
    );

    for entry_result in WalkDir::new(path).into_iter() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("操作已取消".to_string());
        }

        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                skipped_files += 1;
                if error
                    .io_error()
                    .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::PermissionDenied)
                {
                    permission_denied_files += 1;
                }
                push_scan_issue(&mut sample_errors, error.path(), error.to_string());
                continue;
            }
        };

        if entry.file_type().is_dir() {
            if entry.depth() > 0 {
                folder_count += 1;
            }
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped_files += 1;
                if error
                    .io_error()
                    .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::PermissionDenied)
                {
                    permission_denied_files += 1;
                }
                push_scan_issue(
                    &mut sample_errors,
                    Some(entry.path()),
                    format!("无法读取文件信息: {}", error),
                );
                continue;
            }
        };

        let ext = normalize_extension(entry.path());
        let size = get_file_size(&metadata);

        let stat = stats.entry(ext).or_insert((0, 0));
        stat.0 += 1;
        stat.1 += size;

        total_files += 1;
        total_size += size;

        let processed_total = total_files.saturating_add(skipped_files);
        if processed_total == 1 || last_progress_emit.elapsed() >= Duration::from_millis(200) {
            last_progress_emit = Instant::now();
            emit_progress(
                &mut emit,
                task_id,
                "扫描文件".into(),
                total_files,
                0,
                0.0,
                scan_start.elapsed(),
                skipped_files,
                permission_denied_files,
            );
        }
    }

    let mut result: Vec<FileStats> = stats
        .into_iter()
        .map(|(ext, (count, size))| FileStats {
            extension: if ext.is_empty() {
                "(无扩展名)".into()
            } else {
                format!(".{}", ext)
            },
            count,
            total_size: size,
        })
        .collect();

    result.sort_by(|a, b| {
        b.total_size
            .cmp(&a.total_size)
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.extension.cmp(&b.extension))
    });

    let type_count = result.len();
    let processed_total = total_files.saturating_add(skipped_files);
    emit_progress(
        &mut emit,
        task_id,
        format!("扫描完成，耗时 {:.1}s", scan_start.elapsed().as_secs_f64()),
        total_files,
        processed_total.max(1),
        100.0,
        scan_start.elapsed(),
        skipped_files,
        permission_denied_files,
    );

    Ok(ScanResult {
        stats: result,
        total_files,
        folder_count,
        total_size,
        type_count,
        skipped_files,
        permission_denied_files,
        sample_errors,
    })
}

#[derive(Debug, Serialize)]
pub struct FileStats {
    pub extension: String,
    pub count: u64,
    pub total_size: u64,
}

#[derive(Debug, Serialize)]
pub struct ScanIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub stats: Vec<FileStats>,
    pub total_files: u64,
    pub folder_count: u64,
    pub total_size: u64,
    pub type_count: usize,
    pub skipped_files: u64,
    pub permission_denied_files: u64,
    pub sample_errors: Vec<ScanIssue>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileStatsProgress {
    pub task_id: String,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub elapsed_ms: u64,
    pub files_per_second: f64,
    pub skipped_files: u64,
    pub permission_denied_files: u64,
}

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    path: String,
    task_id: String,
) -> Result<ScanResult, String> {
    let cancelled = register_task(&task_id);
    let task_id_for_cleanup = task_id.clone();

    let task_result = tokio::task::spawn_blocking(move || {
        scan_directory_inner(&path, &task_id, &cancelled, |progress| {
            let _ = app.emit("file-stats-progress", progress);
        })
    })
    .await;

    cleanup_task(&task_id_for_cleanup);

    let result = task_result.map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(result)
}

#[tauri::command]
pub fn cancel_file_stats(task_id: String) {
    mark_task_cancelled(&task_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "file-stats-test-{}-{}-{}",
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
    fn scan_directory_groups_extensions_case_insensitively() {
        let temp_dir = TestDir::new();
        fs::write(temp_dir.path().join("a.TXT"), b"hello").expect("failed to write test file");
        fs::write(temp_dir.path().join("b.txt"), b"world!").expect("failed to write test file");
        fs::write(temp_dir.path().join("README"), b"note").expect("failed to write test file");

        let cancelled = AtomicBool::new(false);
        let result = scan_directory_inner(
            temp_dir.path().to_str().expect("invalid temp dir path"),
            "task-test",
            &cancelled,
            |_| {},
        )
        .expect("scan should succeed");

        assert_eq!(result.total_files, 3);
        assert_eq!(result.total_size, 15);
        assert_eq!(result.type_count, 2);
        assert_eq!(result.skipped_files, 0);
        assert_eq!(result.permission_denied_files, 0);

        let txt = result
            .stats
            .iter()
            .find(|item| item.extension == ".txt")
            .expect("txt stats should exist");
        assert_eq!(txt.count, 2);
        assert_eq!(txt.total_size, 11);

        let no_extension = result
            .stats
            .iter()
            .find(|item| item.extension == "(无扩展名)")
            .expect("no-extension stats should exist");
        assert_eq!(no_extension.count, 1);
        assert_eq!(no_extension.total_size, 4);
    }

    #[test]
    fn scan_directory_rejects_regular_files() {
        let temp_dir = TestDir::new();
        let file_path = temp_dir.path().join("single.txt");
        fs::write(&file_path, b"content").expect("failed to write test file");

        let cancelled = AtomicBool::new(false);
        let error = scan_directory_inner(
            file_path.to_str().expect("invalid file path"),
            "task-test",
            &cancelled,
            |_| {},
        )
        .expect_err("scan should reject regular files");

        assert!(error.contains("请选择文件夹"));
    }

    #[test]
    fn scan_directory_returns_cancelled_error() {
        let temp_dir = TestDir::new();
        fs::write(temp_dir.path().join("a.txt"), b"hello").expect("failed to write test file");

        let cancelled = AtomicBool::new(true);
        let error = scan_directory_inner(
            temp_dir.path().to_str().expect("invalid temp dir path"),
            "task-test",
            &cancelled,
            |_| {},
        )
        .expect_err("scan should be cancelled");

        assert_eq!(error, "操作已取消");
    }
}
