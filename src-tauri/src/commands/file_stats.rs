use lazy_static::lazy_static;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::Metadata;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

lazy_static! {
    static ref FILE_STATS_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

#[cfg(unix)]
fn get_allocated_size(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks() * 512
}

#[cfg(not(unix))]
fn get_allocated_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

#[derive(Serialize)]
pub struct FileStats {
    pub extension: String,
    pub count: u64,
    pub total_size: u64,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub stats: Vec<FileStats>,
    pub total_files: u64,
    pub folder_count: u64,
    pub total_size: u64,
    pub type_count: usize,
}

#[derive(Serialize, Clone)]
pub struct FileStatsProgress {
    pub task_id: String,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
}

#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String, task_id: String) -> Result<ScanResult, String> {
    FILE_STATS_CANCELLED.store(false, Ordering::SeqCst);
    let cancelled = FILE_STATS_CANCELLED.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
        let mut total_files: u64 = 0;
        let mut folder_count: u64 = 0;
        let mut total_size: u64 = 0;
        let scan_start = Instant::now();
        let mut last_progress_emit = Instant::now();

        let _ = app.emit(
            "file-stats-progress",
            FileStatsProgress {
                task_id: task_id.clone(),
                stage: "扫描文件".into(),
                current: 0,
                total: 0,
                percent: 0.0,
            },
        );

        for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
            if cancelled.load(Ordering::SeqCst) {
                return Err("操作已取消".to_string());
            }

            if entry.file_type().is_dir() {
                if entry.depth() > 0 {
                    folder_count += 1;
                }
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }

            let ext = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let size = get_allocated_size(&metadata);

            let stat = stats.entry(ext).or_insert((0, 0));
            stat.0 += 1;
            stat.1 += size;

            total_files += 1;
            total_size += size;

            if total_files == 1 || last_progress_emit.elapsed() >= Duration::from_millis(200) {
                last_progress_emit = Instant::now();
                let _ = app.emit(
                    "file-stats-progress",
                    FileStatsProgress {
                        task_id: task_id.clone(),
                        stage: "扫描文件".into(),
                        current: total_files,
                        total: 0,
                        percent: 0.0,
                    },
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

        result.sort_by(|a, b| b.count.cmp(&a.count));

        let _ = app.emit(
            "file-stats-progress",
            FileStatsProgress {
                task_id: task_id.clone(),
                stage: format!("扫描完成，耗时 {:.1}s", scan_start.elapsed().as_secs_f64()),
                current: total_files.max(1),
                total: total_files.max(1),
                percent: 100.0,
            },
        );

        Ok::<ScanResult, String>(ScanResult {
            type_count: result.len(),
            stats: result,
            total_files,
            folder_count,
            total_size,
        })
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    Ok(result)
}

#[tauri::command]
pub fn cancel_file_stats() {
    FILE_STATS_CANCELLED.store(true, Ordering::SeqCst);
}
