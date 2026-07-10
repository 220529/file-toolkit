use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

lazy_static::lazy_static! {
    static ref WATERMARK_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

#[derive(Debug, Serialize, Clone)]
pub struct WatermarkBatchProgress {
    pub task_id: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
    pub current_file: String,
    pub succeeded: usize,
    pub failed: usize,
}

pub(super) fn lock_cancelled_tasks(
) -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    WATERMARK_CANCELLED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn register_batch_task(task_id: &str) -> Result<Arc<AtomicBool>, String> {
    let mut tasks = lock_cancelled_tasks();
    if !tasks.is_empty() {
        return Err("已有批量水印任务正在运行".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    tasks.insert(task_id.to_string(), cancelled.clone());
    Ok(cancelled)
}

pub(super) fn cleanup_batch_task(task_id: &str) {
    let mut tasks = lock_cancelled_tasks();
    tasks.remove(task_id);
}

pub(super) fn mark_batch_task_cancelled(task_id: &str) -> bool {
    let tasks = lock_cancelled_tasks();
    let Some(cancelled) = tasks.get(task_id) else {
        return false;
    };
    cancelled.store(true, Ordering::SeqCst);
    true
}

pub(super) fn ensure_not_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), String> {
    if cancelled
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        Err("操作已取消".into())
    } else {
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_batch_progress(
    app: &AppHandle,
    task_id: &str,
    stage: &str,
    current: usize,
    total: usize,
    current_file: String,
    succeeded: usize,
    failed: usize,
) {
    let percent = if total > 0 {
        (current as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let _ = app.emit(
        "watermark-progress",
        WatermarkBatchProgress {
            task_id: task_id.to_string(),
            stage: stage.to_string(),
            current,
            total,
            percent,
            current_file,
            succeeded,
            failed,
        },
    );
}
