use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::file_ops::{
    path_collision_key, path_entry_exists, validate_input_file, validate_output_path,
    TemporaryOutput,
};
use super::logger::{log_error, log_info};
use super::process::{
    kill_tracked_process, new_process_slot, run_tracked_output, ProcessSlot, ProcessTracker,
};

// 全局变量存储当前 FFmpeg 进程，用于取消
lazy_static::lazy_static! {
    static ref VIDEO_FFMPEG_PROCESS: ProcessSlot = new_process_slot();
    static ref VIDEO_TASK: Mutex<Option<ActiveVideoTask>> = Mutex::new(None);
    static ref BATCH_VIDEO_FFMPEG_PROCESS: ProcessSlot = new_process_slot();
    static ref BATCH_VIDEO_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

const SUPPORTED_VIDEO_EXTENSIONS: [&str; 7] = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];
const FAST_CUT_DURATION_TOLERANCE_SECONDS: f64 = 0.75;

fn lock_batch_cancelled_tasks() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>>
{
    BATCH_VIDEO_CANCELLED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_batch_task(task_id: &str) -> Result<Arc<AtomicBool>, String> {
    let mut tasks = lock_batch_cancelled_tasks();
    if !tasks.is_empty() {
        return Err("已有批量视频任务正在运行".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    tasks.insert(task_id.to_string(), cancelled.clone());
    Ok(cancelled)
}

fn cleanup_batch_task(task_id: &str) {
    let mut tasks = lock_batch_cancelled_tasks();
    tasks.remove(task_id);
}

fn mark_batch_task_cancelled(task_id: &str) -> bool {
    let tasks = lock_batch_cancelled_tasks();
    let Some(cancelled) = tasks.get(task_id) else {
        return false;
    };
    cancelled.store(true, Ordering::Relaxed);
    true
}

#[derive(Clone)]
struct ActiveVideoTask {
    task_id: String,
    cancelled: Arc<AtomicBool>,
}

struct VideoTaskGuard {
    task_id: String,
}

impl Drop for VideoTaskGuard {
    fn drop(&mut self) {
        let mut active = VIDEO_TASK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active
            .as_ref()
            .is_some_and(|task| task.task_id == self.task_id)
        {
            *active = None;
        }
    }
}

fn register_video_task(task_id: &str) -> Result<(VideoTaskGuard, Arc<AtomicBool>), String> {
    if task_id.trim().is_empty() {
        return Err("视频截取任务标识不能为空".into());
    }
    let mut active = VIDEO_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.is_some() {
        return Err("已有视频截取任务正在运行".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveVideoTask {
        task_id: task_id.to_string(),
        cancelled: cancelled.clone(),
    });
    Ok((
        VideoTaskGuard {
            task_id: task_id.to_string(),
        },
        cancelled,
    ))
}

fn mark_video_task_cancelled(task_id: &str) -> bool {
    let active = VIDEO_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(task) = active.as_ref().filter(|task| task.task_id == task_id) else {
        return false;
    };
    task.cancelled.store(true, Ordering::SeqCst);
    true
}

#[derive(Clone, Serialize)]
struct VideoProgress {
    task_id: String,
    percent: f64,
}

fn normalize_video_extension(path: &Path) -> String {
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

fn is_supported_video_path(path: &Path) -> bool {
    let ext = normalize_video_extension(path);
    SUPPORTED_VIDEO_EXTENSIONS.contains(&ext.as_str())
}

fn preferred_precise_output_extension(ext: &str) -> String {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" | "mov" | "m4v" | "mkv" => ext.to_ascii_lowercase(),
        _ => "mp4".into(),
    }
}

fn build_temp_preview_path() -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("preview_{}_{}.jpg", std::process::id(), unique))
}

fn parse_fps_value(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains('/') {
        let mut parts = trimmed.split('/');
        let num = parts.next()?.parse::<f64>().ok()?;
        let den = parts.next()?.parse::<f64>().ok()?;
        if den.abs() < f64::EPSILON {
            return None;
        }
        let fps = num / den;
        if fps.is_finite() && fps > 0.0 {
            Some(fps)
        } else {
            None
        }
    } else {
        let fps = trimmed.parse::<f64>().ok()?;
        if fps.is_finite() && fps > 0.0 {
            Some(fps)
        } else {
            None
        }
    }
}

fn output_needs_faststart(path: &str) -> bool {
    matches!(
        path.rsplit('.').next().map(|ext| ext.to_ascii_lowercase()),
        Some(ext) if ext == "mp4" || ext == "mov" || ext == "m4v"
    )
}

fn progress_percent(current: f64, duration: f64) -> f64 {
    if !duration.is_finite() || duration <= 0.0 {
        return 0.0;
    }

    (current / duration * 100.0).clamp(0.0, 100.0)
}

fn probe_output_duration(
    app: &AppHandle,
    path: &str,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<f64, String> {
    let ffprobe = get_ffprobe_path(app);
    let mut command = Command::new(&ffprobe);
    command.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]);
    let output = run_tracked_output(&mut command, process_slot, cancelled, "执行 ffprobe 失败")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "读取输出视频时长失败".into()
        } else {
            format!("读取输出视频时长失败: {}", stderr)
        });
    }

    let duration = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|error| format!("解析输出视频时长失败: {}", error))?;

    if duration.is_finite() && duration > 0.0 {
        Ok(duration)
    } else {
        Err("输出视频时长无效".into())
    }
}

fn validate_fast_cut_duration(
    app: &AppHandle,
    output: &str,
    expected_duration: f64,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    let actual_duration = match probe_output_duration(app, output, process_slot, cancelled) {
        Ok(duration) => duration,
        Err(error) => {
            let _ = std::fs::remove_file(output);
            return Err(format!(
                "{}。快速模式结果无法校验，请开启精确模式重新导出。",
                error
            ));
        }
    };
    let tolerance = FAST_CUT_DURATION_TOLERANCE_SECONDS.max(expected_duration * 0.1);
    if (actual_duration - expected_duration).abs() <= tolerance {
        return Ok(());
    }

    let _ = std::fs::remove_file(output);
    Err(format!(
        "快速模式只能从关键帧附近无损截取，本次导出时长 {:.3}s，与目标时长 {:.3}s 偏差过大。请开启精确模式重新导出。",
        actual_duration, expected_duration
    ))
}

fn cancellation_requested(cancelled: Option<&AtomicBool>) -> bool {
    cancelled
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn generate_preview_frame_with_options(
    app: &AppHandle,
    path: &str,
    time: f64,
    max_width: Option<u32>,
    quality: u8,
) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(app);
    let temp_file = build_temp_preview_path();
    let temp_path = temp_file.to_string_lossy().to_string();

    let mut args = vec![
        "-n".to_string(),
        "-ss".to_string(),
        format!("{}", time),
        "-i".to_string(),
        path.to_string(),
        "-an".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
    ];

    if let Some(width) = max_width {
        args.push("-vf".to_string());
        args.push(format!("scale='min({},iw)':-2:flags=lanczos", width));
    }

    args.extend([
        "-vframes".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        quality.clamp(2, 31).to_string(),
        temp_path,
    ]);

    let output = Command::new(&ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&temp_file);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("生成预览帧失败: {}", stderr.trim()));
    }

    let image_data = std::fs::read(&temp_file).map_err(|e| format!("读取预览图失败: {}", e))?;
    let _ = std::fs::remove_file(&temp_file);

    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64.encode(&image_data)
    ))
}

/// 生成视频预览帧（返回 base64 编码的图片）
#[tauri::command]
pub async fn generate_preview_frame(
    app: AppHandle,
    path: String,
    time: f64,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_input_file(Path::new(&path))?;
        debug!("[预览] 生成预览帧 @ {:.2}s", time);
        generate_preview_frame_with_options(&app, &path, time, None, 2)
    })
    .await
    .map_err(|error| format!("生成预览任务失败: {}", error))?
}

/// 生成多个预览帧（用于时间轴）
#[tauri::command]
pub async fn generate_timeline_frames(
    app: AppHandle,
    path: String,
    count: u32,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        validate_input_file(Path::new(&path))?;
        if count == 0 {
            return Ok(Vec::new());
        }

        let count = count.min(24);
        let duration = get_video_duration_inner(&app, &path)?;
        if duration <= 0.0 {
            return Err("视频时长无效，无法生成时间轴缩略帧".into());
        }

        let mut frames = Vec::new();
        let interval = duration / (count as f64 + 1.0);

        for i in 1..=count {
            let time = interval * (i as f64);
            match generate_preview_frame_with_options(&app, &path, time, Some(360), 6) {
                Ok(frame) => frames.push(frame),
                Err(_) => continue,
            }
        }

        if count > 0 && frames.is_empty() {
            return Err("未能生成时间轴缩略帧".into());
        }

        Ok(frames)
    })
    .await
    .map_err(|error| format!("生成时间轴任务失败: {}", error))?
}

/// 获取视频时长（秒）
#[tauri::command]
pub async fn get_video_duration(app: AppHandle, path: String) -> Result<f64, String> {
    tokio::task::spawn_blocking(move || get_video_duration_inner(&app, &path))
        .await
        .map_err(|error| format!("读取视频时长任务失败: {}", error))?
}

fn get_video_duration_inner(app: &AppHandle, path: &str) -> Result<f64, String> {
    get_video_duration_tracked(app, path, None, None)
}

fn get_video_duration_tracked(
    app: &AppHandle,
    path: &str,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<f64, String> {
    validate_input_file(Path::new(path))?;
    let ffprobe = get_ffprobe_path(app);
    log_info("[视频] 获取时长");

    let mut command = Command::new(&ffprobe);
    command.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]);
    let output = run_tracked_output(&mut command, process_slot, cancelled, "执行 ffprobe 失败")
        .inspect_err(|_| {
            log_error("[视频] 启动 ffprobe 失败");
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("ffprobe 错误: {}", stderr);
        log_error("[视频] ffprobe 返回失败");
        return Err(msg);
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str.trim().parse::<f64>().map_err(|e| {
        let msg = format!("解析时长失败: {}", e);
        log_error("[视频] 解析时长失败");
        msg
    })
}

/// 获取视频信息
#[tauri::command]
pub async fn get_video_info(app: AppHandle, path: String) -> Result<VideoInfo, String> {
    tokio::task::spawn_blocking(move || get_video_info_inner(&app, &path))
        .await
        .map_err(|error| format!("读取视频信息任务失败: {}", error))?
}

fn get_video_info_inner(app: &AppHandle, path: &str) -> Result<VideoInfo, String> {
    validate_input_file(Path::new(path))?;
    let ffprobe = get_ffprobe_path(app);
    let duration = get_video_duration_inner(app, path)?;

    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "csv=p=0",
            path,
        ])
        .output()
        .map_err(|e| format!("执行 ffprobe 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("读取视频流信息失败: {}", stderr.trim()));
    }

    let info_str = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = info_str.trim().split(',').collect();

    let (width, height, fps) = if parts.len() >= 4 {
        let w = parts[0]
            .parse()
            .map_err(|e| format!("解析视频宽度失败: {}", e))?;
        let h = parts[1]
            .parse()
            .map_err(|e| format!("解析视频高度失败: {}", e))?;
        let fps = parse_fps_value(parts[2])
            .or_else(|| parse_fps_value(parts[3]))
            .unwrap_or(30.0);
        (w, h, fps)
    } else if parts.len() >= 3 {
        let w = parts[0]
            .parse()
            .map_err(|e| format!("解析视频宽度失败: {}", e))?;
        let h = parts[1]
            .parse()
            .map_err(|e| format!("解析视频高度失败: {}", e))?;
        let fps = parse_fps_value(parts[2]).unwrap_or(30.0);
        (w, h, fps)
    } else {
        (0, 0, 30.0)
    };

    Ok(VideoInfo {
        duration,
        width,
        height,
        fps,
    })
}

#[derive(serde::Serialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Debug, Serialize)]
pub struct BatchVideoFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchVideoOutputMode {
    Source,
    Directory,
}

#[derive(Debug, Serialize)]
pub struct BatchTrimItemResult {
    pub input_path: String,
    pub output_path: Option<String>,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct BatchTrimResult {
    pub total: usize,
    pub succeeded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub items: Vec<BatchTrimItemResult>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BatchTrimProgress {
    pub task_id: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
    pub current_file: String,
    pub item_progress: f64,
    pub succeeded: usize,
    pub skipped: usize,
    pub failed: usize,
}

fn create_unique_output_path(
    input: &Path,
    output_dir: &Path,
    suffix: &str,
    precise_mode: bool,
) -> Result<PathBuf, String> {
    if !output_dir.is_absolute() || !output_dir.is_dir() {
        return Err("输出目录不存在或不可访问".into());
    }
    let input_ext = normalize_video_extension(input);
    let output_ext = if precise_mode {
        preferred_precise_output_extension(&input_ext)
    } else if input_ext.is_empty() {
        "mp4".into()
    } else {
        input_ext
    };
    let base_name = input
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "video".into());
    let sanitized_suffix = suffix.trim();

    for index in 0..10_000 {
        let candidate_name = if index == 0 {
            format!("{}{}.{}", base_name, sanitized_suffix, output_ext)
        } else {
            format!(
                "{}{}-{}.{}",
                base_name,
                sanitized_suffix,
                index + 1,
                output_ext
            )
        };
        let candidate = output_dir.join(candidate_name);
        if candidate.parent() != Some(output_dir) {
            return Err("输出文件名不能离开所选目录".into());
        }
        if path_collision_key(&candidate) != path_collision_key(input)
            && !path_entry_exists(&candidate)
        {
            return Ok(candidate);
        }
    }

    Err("无法生成不冲突的输出文件名".into())
}

fn normalize_batch_output_suffix(suffix: Option<&str>) -> Result<String, String> {
    let suffix = suffix.unwrap_or("_trim").trim();
    let suffix = if suffix.is_empty() { "_trim" } else { suffix };
    if suffix.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err("文件名后缀不能包含路径分隔符或系统保留字符".into());
    }
    Ok(suffix.to_string())
}

#[allow(clippy::too_many_arguments)]
fn emit_batch_progress(
    app: &AppHandle,
    task_id: &str,
    stage: &str,
    current: usize,
    total: usize,
    current_file: String,
    item_progress: f64,
    succeeded: usize,
    skipped: usize,
    failed: usize,
) {
    let completed_units =
        current.saturating_sub(1) as f64 + (item_progress.clamp(0.0, 100.0) / 100.0);
    let percent = if total > 0 {
        (completed_units / total as f64 * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let _ = app.emit(
        "batch-video-progress",
        BatchTrimProgress {
            task_id: task_id.to_string(),
            stage: stage.to_string(),
            current,
            total,
            percent,
            current_file,
            item_progress: item_progress.clamp(0.0, 100.0),
            succeeded,
            skipped,
            failed,
        },
    );
}

fn run_fast_cut(
    app: &AppHandle,
    input: &str,
    output: &str,
    start_time: f64,
    end_time: f64,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }
    if cancellation_requested(cancelled) {
        return Err("操作已取消".into());
    }

    let ffmpeg = get_ffmpeg_path(app);
    let duration = end_time - start_time;
    let use_faststart = output_needs_faststart(output);

    let mut args = vec![
        "-n".to_string(),
        "-ss".to_string(),
        format!("{}", start_time),
        "-i".to_string(),
        input.to_string(),
        "-t".to_string(),
        format!("{}", duration),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-map_metadata".to_string(),
        "0".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
    ];

    if use_faststart {
        args.push("-movflags".to_string());
        args.push("+faststart".to_string());
    }

    args.push(output.to_string());

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 失败: {}", error))?;

    let _process_tracker = process_slot.map(|slot| ProcessTracker::register(slot, child.id()));
    if cancellation_requested(cancelled) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(output);
        return Err("操作已取消".into());
    }
    let result = child
        .wait_with_output()
        .map_err(|error| format!("等待 ffmpeg 失败: {}", error))?;

    if cancellation_requested(cancelled) {
        let _ = std::fs::remove_file(output);
        return Err("操作已取消".into());
    }

    if result.status.success() {
        validate_fast_cut_duration(app, output, duration, process_slot, cancelled)
    } else {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        if stderr.is_empty() {
            Err("视频截取失败".into())
        } else {
            Err(format!("视频截取失败: {}", stderr))
        }
    }
}

struct PreciseCutRequest<'a> {
    input: &'a str,
    output: &'a str,
    start_time: f64,
    end_time: f64,
}

fn run_precise_cut<F>(
    app: &AppHandle,
    request: PreciseCutRequest<'_>,
    process_slot: &ProcessSlot,
    cancelled: &AtomicBool,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(f64),
{
    let PreciseCutRequest {
        input,
        output,
        start_time,
        end_time,
    } = request;

    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let ffmpeg = get_ffmpeg_path(app);
    let duration = end_time - start_time;
    let use_faststart = output_needs_faststart(output);

    let mut args = vec![
        "-n".to_string(),
        "-i".to_string(),
        input.to_string(),
        "-ss".to_string(),
        format!("{}", start_time),
        "-t".to_string(),
        format!("{}", duration),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-map_metadata".to_string(),
        "0".to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-crf".to_string(),
        "23".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "128k".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
    ];

    if use_faststart {
        args.push("-movflags".to_string());
        args.push("+faststart".to_string());
    }

    args.extend([
        "-progress".to_string(),
        "pipe:1".to_string(),
        output.to_string(),
    ]);

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 失败: {}", error))?;

    let _process_tracker = ProcessTracker::register(process_slot, child.id());
    if cancelled.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(output);
        return Err("操作已取消".into());
    }

    let cut_result = (|| -> Result<(), String> {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 ffmpeg 输出".to_string())?;
        let reader = BufReader::new(stdout);

        for line in reader.lines().map_while(Result::ok) {
            if cancelled.load(Ordering::SeqCst) {
                let _ = child.kill();
                break;
            }

            if let Some(time_str) = line.strip_prefix("out_time_ms=") {
                if let Ok(ms) = time_str.parse::<i64>() {
                    let current = ms as f64 / 1_000_000.0;
                    on_progress(progress_percent(current, duration));
                }
            } else if let Some(time_str) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = time_str.parse::<i64>() {
                    let current = us as f64 / 1_000_000.0;
                    on_progress(progress_percent(current, duration));
                }
            } else if let Some(time_str) = line.strip_prefix("out_time=") {
                if let Some(secs) = parse_ffmpeg_time(time_str) {
                    on_progress(progress_percent(secs, duration));
                }
            }
        }

        let status = child
            .wait()
            .map_err(|error| format!("等待 ffmpeg 失败: {}", error))?;

        if cancelled.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(output);
            return Err("操作已取消".to_string());
        }

        if !status.success() {
            let _ = std::fs::remove_file(output);
            return Err("视频截取失败".into());
        }

        on_progress(100.0);
        Ok(())
    })();

    cut_result
}

#[tauri::command]
pub async fn collect_batch_video_files(inputs: Vec<String>) -> Result<Vec<BatchVideoFile>, String> {
    tokio::task::spawn_blocking(move || collect_batch_video_files_inner(inputs))
        .await
        .map_err(|error| format!("读取批量视频任务失败: {}", error))?
}

fn collect_batch_video_files_inner(inputs: Vec<String>) -> Result<Vec<BatchVideoFile>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();

    for input in inputs {
        let path = PathBuf::from(&input);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
                if !entry.file_type().is_file() || !is_supported_video_path(entry.path()) {
                    continue;
                }
                let entry_path = entry.path().to_string_lossy().to_string();
                if !seen.insert(entry_path.clone()) {
                    continue;
                }
                let entry_meta = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(_) => continue,
                };
                items.push(BatchVideoFile {
                    name: entry
                        .path()
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: entry_path,
                    size: entry_meta.len(),
                });
            }
        } else if metadata.is_file() && is_supported_video_path(&path) {
            let normalized = path.to_string_lossy().to_string();
            if seen.insert(normalized.clone()) {
                items.push(BatchVideoFile {
                    name: path
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: normalized,
                    size: metadata.len(),
                });
            }
        }
    }

    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(items)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn batch_trim_videos(
    app: AppHandle,
    task_id: String,
    paths: Vec<String>,
    trim_start: f64,
    precise_mode: bool,
    output_mode: BatchVideoOutputMode,
    output_dir: Option<String>,
    suffix: Option<String>,
) -> Result<BatchTrimResult, String> {
    if paths.is_empty() {
        return Err("请先选择要处理的视频".into());
    }
    if trim_start <= 0.0 {
        return Err("请先设定要删除的片头时长".into());
    }

    let suffix = normalize_batch_output_suffix(suffix.as_deref())?;
    if matches!(output_mode, BatchVideoOutputMode::Directory) {
        let directory = output_dir
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "请先选择输出目录".to_string())?;
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("输出目录不存在或不可访问".into());
        }
    }

    let cancelled = register_batch_task(&task_id)?;
    let task_id_for_cleanup = task_id.clone();

    let task_result = tokio::task::spawn_blocking(move || {
        let total = paths.len();
        let target_directory = output_dir.map(PathBuf::from);
        let mut succeeded = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let mut was_cancelled = false;
        let mut items = Vec::with_capacity(total);

        emit_batch_progress(
            &app,
            &task_id,
            "准备批量去片头",
            0,
            total,
            "".into(),
            0.0,
            succeeded,
            skipped,
            failed,
        );

        for (index, input_path) in paths.iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }

            let current = index + 1;
            let input = PathBuf::from(input_path);
            let current_name = input
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| input_path.clone());

            emit_batch_progress(
                &app,
                &task_id,
                "处理中",
                current,
                total,
                current_name.clone(),
                0.0,
                succeeded,
                skipped,
                failed,
            );

            let duration = match get_video_duration_tracked(
                &app,
                input_path,
                Some(&BATCH_VIDEO_FFMPEG_PROCESS),
                Some(&cancelled),
            ) {
                Ok(duration) => duration,
                Err(error) => {
                    failed += 1;
                    items.push(BatchTrimItemResult {
                        input_path: input_path.clone(),
                        output_path: None,
                        status: "failed".into(),
                        message: error,
                    });
                    emit_batch_progress(
                        &app,
                        &task_id,
                        "处理中",
                        current,
                        total,
                        current_name,
                        100.0,
                        succeeded,
                        skipped,
                        failed,
                    );
                    continue;
                }
            };

            if duration <= trim_start + 0.001 {
                skipped += 1;
                items.push(BatchTrimItemResult {
                    input_path: input_path.clone(),
                    output_path: None,
                    status: "skipped".into(),
                    message: format!("视频时长 {:.1}s 不足以删除前 {:.1}s", duration, trim_start),
                });
                emit_batch_progress(
                    &app,
                    &task_id,
                    "处理中",
                    current,
                    total,
                    current_name,
                    100.0,
                    succeeded,
                    skipped,
                    failed,
                );
                continue;
            }

            let output_parent = match output_mode {
                BatchVideoOutputMode::Source => input
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from(".")),
                BatchVideoOutputMode::Directory => target_directory
                    .clone()
                    .ok_or_else(|| "请先选择输出目录".to_string())?,
            };

            let output_path =
                match create_unique_output_path(&input, &output_parent, &suffix, precise_mode) {
                    Ok(path) => path,
                    Err(error) => {
                        failed += 1;
                        items.push(BatchTrimItemResult {
                            input_path: input_path.clone(),
                            output_path: None,
                            status: "failed".into(),
                            message: error,
                        });
                        continue;
                    }
                };
            let output_string = output_path.to_string_lossy().to_string();
            let result = TemporaryOutput::new(&output_path).and_then(|temporary_output| {
                let temporary_output_string = temporary_output.path().to_string_lossy().to_string();
                let processing_result = if precise_mode {
                    run_precise_cut(
                        &app,
                        PreciseCutRequest {
                            input: input_path,
                            output: &temporary_output_string,
                            start_time: trim_start,
                            end_time: duration,
                        },
                        &BATCH_VIDEO_FFMPEG_PROCESS,
                        &cancelled,
                        |item_progress| {
                            emit_batch_progress(
                                &app,
                                &task_id,
                                "处理中",
                                current,
                                total,
                                current_name.clone(),
                                item_progress,
                                succeeded,
                                skipped,
                                failed,
                            );
                        },
                    )
                } else {
                    run_fast_cut(
                        &app,
                        input_path,
                        &temporary_output_string,
                        trim_start,
                        duration,
                        Some(&BATCH_VIDEO_FFMPEG_PROCESS),
                        Some(&cancelled),
                    )
                };

                processing_result.and_then(|()| temporary_output.commit(&output_path))
            });

            match result {
                Ok(()) => {
                    succeeded += 1;
                    items.push(BatchTrimItemResult {
                        input_path: input_path.clone(),
                        output_path: Some(output_string.clone()),
                        status: "success".into(),
                        message: "处理完成".into(),
                    });
                }
                Err(error) if error.contains("取消") => {
                    was_cancelled = true;
                    break;
                }
                Err(error) => {
                    failed += 1;
                    items.push(BatchTrimItemResult {
                        input_path: input_path.clone(),
                        output_path: None,
                        status: "failed".into(),
                        message: error,
                    });
                }
            }

            emit_batch_progress(
                &app,
                &task_id,
                "处理中",
                current,
                total,
                current_name,
                100.0,
                succeeded,
                skipped,
                failed,
            );
        }

        let completed = items.len();
        emit_batch_progress(
            &app,
            &task_id,
            if was_cancelled { "已取消" } else { "完成" },
            completed,
            total,
            "".into(),
            if completed == 0 { 0.0 } else { 100.0 },
            succeeded,
            skipped,
            failed,
        );

        Ok::<BatchTrimResult, String>(BatchTrimResult {
            total,
            succeeded,
            skipped,
            failed,
            cancelled: was_cancelled,
            items,
        })
    })
    .await;

    cleanup_batch_task(&task_id_for_cleanup);

    task_result.map_err(|error| format!("任务执行失败: {}", error))?
}

/// 截取视频（快速模式）
#[tauri::command]
pub async fn cut_video(
    app: AppHandle,
    task_id: String,
    input: String,
    output: String,
    start_time: f64,
    end_time: f64,
) -> Result<String, String> {
    let (_task_guard, cancelled) = register_video_task(&task_id)?;
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let input_path = PathBuf::from(&input);
    let output_path = PathBuf::from(&output);
    validate_input_file(&input_path)?;
    validate_output_path(&output_path)?;
    if path_entry_exists(&output_path) {
        return Err("目标文件已存在，请选择新的文件名".into());
    }
    let duration = end_time - start_time;
    info!(
        "[截取] 快速模式: {:.2}s - {:.2}s (时长 {:.2}s)",
        start_time, end_time, duration
    );

    let output_for_result = output_path.clone();
    tokio::task::spawn_blocking(move || {
        let temporary_output = TemporaryOutput::new(&output_path)?;
        let temporary_output_string = temporary_output.path().to_string_lossy().to_string();
        run_fast_cut(
            &app,
            &input,
            &temporary_output_string,
            start_time,
            end_time,
            Some(&VIDEO_FFMPEG_PROCESS),
            Some(&cancelled),
        )?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("操作已取消".into());
        }
        temporary_output.commit(&output_path)
    })
    .await
    .map_err(|error| format!("截取任务执行失败: {}", error))??;

    info!("[截取] 快速模式完成");
    Ok(output_for_result.to_string_lossy().to_string())
}

/// 精确截取视频（重新编码，带进度反馈）
#[tauri::command]
pub async fn cut_video_precise(
    app: AppHandle,
    task_id: String,
    input: String,
    output: String,
    start_time: f64,
    end_time: f64,
) -> Result<String, String> {
    let (_task_guard, cancelled) = register_video_task(&task_id)?;
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let input_path = PathBuf::from(&input);
    let output_path = PathBuf::from(&output);
    validate_input_file(&input_path)?;
    validate_output_path(&output_path)?;
    if path_entry_exists(&output_path) {
        return Err("目标文件已存在，请选择新的文件名".into());
    }
    let duration = end_time - start_time;
    info!(
        "[截取] 精确模式: {:.2}s - {:.2}s (时长 {:.2}s)",
        start_time, end_time, duration
    );

    let progress_task_id = task_id.clone();
    let output_for_result = output_path.clone();
    tokio::task::spawn_blocking(move || {
        let temporary_output = TemporaryOutput::new(&output_path)?;
        let temporary_output_string = temporary_output.path().to_string_lossy().to_string();
        run_precise_cut(
            &app,
            PreciseCutRequest {
                input: &input,
                output: &temporary_output_string,
                start_time,
                end_time,
            },
            &VIDEO_FFMPEG_PROCESS,
            &cancelled,
            |progress| {
                let _ = app.emit(
                    "video-progress",
                    VideoProgress {
                        task_id: progress_task_id.clone(),
                        percent: progress,
                    },
                );
            },
        )?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("操作已取消".into());
        }
        temporary_output.commit(&output_path)
    })
    .await
    .map_err(|error| format!("截取任务执行失败: {}", error))??;

    info!("[截取] 精确模式完成");
    Ok(output_for_result.to_string_lossy().to_string())
}

/// 取消视频截取操作
#[tauri::command]
pub fn cancel_video_cut(task_id: String) {
    if !mark_video_task_cancelled(&task_id) {
        return;
    }
    info!("[截取] 收到取消请求");
    kill_tracked_process(&VIDEO_FFMPEG_PROCESS);
}

#[tauri::command]
pub fn cancel_batch_video_trim(task_id: String) {
    if !mark_batch_task_cancelled(&task_id) {
        return;
    }
    info!("[批量去头] 收到取消请求: {}", task_id);

    kill_tracked_process(&BATCH_VIDEO_FFMPEG_PROCESS);
}

fn parse_ffmpeg_time(time_str: &str) -> Option<f64> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let hours: f64 = parts[0].parse().ok()?;
        let minutes: f64 = parts[1].parse().ok()?;
        let seconds: f64 = parts[2].parse().ok()?;
        Some(hours * 3600.0 + minutes * 60.0 + seconds)
    } else {
        None
    }
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
                "video-batch-test-{}-{}-{}",
                std::process::id(),
                NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn collect_batch_video_files_recurses_and_filters_extensions() {
        let temp_dir = TestDir::new();
        let nested_dir = temp_dir.path().join("nested");
        std::fs::create_dir_all(&nested_dir).expect("failed to create nested dir");
        std::fs::write(temp_dir.path().join("a.mp4"), b"video").expect("failed to write mp4 file");
        std::fs::write(nested_dir.join("b.MOV"), b"video").expect("failed to write mov file");
        std::fs::write(temp_dir.path().join("note.txt"), b"text")
            .expect("failed to write text file");

        let result =
            collect_batch_video_files_inner(vec![temp_dir.path().to_string_lossy().to_string()])
                .expect("collect should succeed");

        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|item| item.name == "a.mp4"));
        assert!(result.iter().any(|item| item.name == "b.MOV"));
    }

    #[test]
    fn create_unique_output_path_avoids_existing_and_input_paths() {
        let temp_dir = TestDir::new();
        let input = temp_dir.path().join("clip.mp4");
        let existing_output = temp_dir.path().join("clip_trim.mp4");
        std::fs::write(&input, b"video").expect("failed to write input");
        std::fs::write(&existing_output, b"video").expect("failed to write existing output");

        let output = create_unique_output_path(&input, temp_dir.path(), "_trim", false)
            .expect("output path should be available");

        assert_ne!(output, input);
        assert_ne!(output, existing_output);
        assert_eq!(
            output.file_name().and_then(|value| value.to_str()),
            Some("clip_trim-2.mp4")
        );
    }
}
