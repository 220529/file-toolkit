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
use super::logger::{log_error, log_info};

// 全局变量存储当前 FFmpeg 进程，用于取消
lazy_static::lazy_static! {
    static ref VIDEO_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref FFMPEG_PROCESS: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    static ref BATCH_VIDEO_CANCELLED: Mutex<HashMap<String, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

const SUPPORTED_VIDEO_EXTENSIONS: [&str; 7] = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];

fn lock_batch_cancelled_tasks() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>>
{
    BATCH_VIDEO_CANCELLED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_batch_task(task_id: &str) -> Arc<AtomicBool> {
    let mut tasks = lock_batch_cancelled_tasks();
    tasks
        .entry(task_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn cleanup_batch_task(task_id: &str) {
    let mut tasks = lock_batch_cancelled_tasks();
    tasks.remove(task_id);
}

fn mark_batch_task_cancelled(task_id: &str) {
    let mut tasks = lock_batch_cancelled_tasks();
    let cancelled = tasks
        .entry(task_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    cancelled.store(true, Ordering::Relaxed);
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
        "-y".to_string(),
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
pub fn generate_preview_frame(app: AppHandle, path: String, time: f64) -> Result<String, String> {
    debug!("[预览] 生成预览帧: {} @ {:.2}s", path, time);
    generate_preview_frame_with_options(&app, &path, time, None, 2)
}

/// 生成多个预览帧（用于时间轴）
#[tauri::command]
pub fn generate_timeline_frames(
    app: AppHandle,
    path: String,
    count: u32,
) -> Result<Vec<String>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }

    let count = count.min(24);
    let duration = get_video_duration(app.clone(), path.clone())?;
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
}

/// 获取视频时长（秒）
#[tauri::command]
pub fn get_video_duration(app: AppHandle, path: String) -> Result<f64, String> {
    let ffprobe = get_ffprobe_path(&app);
    log_info(&format!(
        "[视频] 获取时长: {}, ffprobe: {:?}",
        path, ffprobe
    ));

    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path,
        ])
        .output()
        .map_err(|e| {
            let msg = format!("执行 ffprobe 失败: {}", e);
            log_error(&format!("[视频] {}", msg));
            msg
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("ffprobe 错误: {}", stderr);
        log_error(&format!("[视频] {}", msg));
        return Err(msg);
    }

    let duration_str = String::from_utf8_lossy(&output.stdout);
    duration_str.trim().parse::<f64>().map_err(|e| {
        let msg = format!("解析时长失败: {}", e);
        log_error(&format!("[视频] {}", msg));
        msg
    })
}

/// 获取视频信息
#[tauri::command]
pub fn get_video_info(app: AppHandle, path: String) -> Result<VideoInfo, String> {
    let ffprobe = get_ffprobe_path(&app);
    let duration = get_video_duration(app, path.clone())?;

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
            &path,
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
) -> PathBuf {
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
    let sanitized_suffix = if suffix.trim().is_empty() {
        "_trim".into()
    } else {
        suffix.trim().to_string()
    };

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
        if candidate != input && !candidate.exists() {
            return candidate;
        }
    }

    output_dir.join(format!(
        "{}{}_overflow.{}",
        base_name, sanitized_suffix, output_ext
    ))
}

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
) -> Result<(), String> {
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let ffmpeg = get_ffmpeg_path(app);
    let duration = end_time - start_time;
    let use_faststart = output_needs_faststart(output);

    let mut args = vec![
        "-y".to_string(),
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

    let result = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("执行 ffmpeg 失败: {}", error))?;

    if result.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        if stderr.is_empty() {
            Err("视频截取失败".into())
        } else {
            Err(format!("视频截取失败: {}", stderr))
        }
    }
}

fn run_precise_cut<F>(
    app: &AppHandle,
    input: &str,
    output: &str,
    start_time: f64,
    end_time: f64,
    cancelled: &AtomicBool,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(f64),
{
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let ffmpeg = get_ffmpeg_path(app);
    let duration = end_time - start_time;
    let use_faststart = output_needs_faststart(output);

    let mut args = vec![
        "-y".to_string(),
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

    let pid = child.id();
    *FFMPEG_PROCESS.lock().unwrap() = Some(pid);

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
                    on_progress((current / duration * 100.0).min(100.0).max(0.0));
                }
            } else if let Some(time_str) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = time_str.parse::<i64>() {
                    let current = us as f64 / 1_000_000.0;
                    on_progress((current / duration * 100.0).min(100.0).max(0.0));
                }
            } else if let Some(time_str) = line.strip_prefix("out_time=") {
                if let Some(secs) = parse_ffmpeg_time(time_str) {
                    on_progress((secs / duration * 100.0).min(100.0).max(0.0));
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

    *FFMPEG_PROCESS.lock().unwrap() = None;
    cut_result
}

#[tauri::command]
pub fn collect_batch_video_files(inputs: Vec<String>) -> Result<Vec<BatchVideoFile>, String> {
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

    let cancelled = register_batch_task(&task_id);
    let task_id_for_cleanup = task_id.clone();
    let suffix = suffix.unwrap_or_else(|| "_trim".into());

    let task_result = tokio::task::spawn_blocking(move || {
        let total = paths.len();
        let target_directory = output_dir.map(PathBuf::from);
        let mut succeeded = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
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
                return Err("操作已取消".to_string());
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

            let duration = match get_video_duration(app.clone(), input_path.clone()) {
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
                create_unique_output_path(&input, &output_parent, &suffix, precise_mode);
            let output_string = output_path.to_string_lossy().to_string();

            let result = if precise_mode {
                run_precise_cut(
                    &app,
                    input_path,
                    &output_string,
                    trim_start,
                    duration,
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
                run_fast_cut(&app, input_path, &output_string, trim_start, duration)
            };

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
                    return Err("操作已取消".into());
                }
                Err(error) => {
                    failed += 1;
                    items.push(BatchTrimItemResult {
                        input_path: input_path.clone(),
                        output_path: Some(output_string),
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

        emit_batch_progress(
            &app,
            &task_id,
            "完成",
            total,
            total,
            "".into(),
            100.0,
            succeeded,
            skipped,
            failed,
        );

        Ok::<BatchTrimResult, String>(BatchTrimResult {
            total,
            succeeded,
            skipped,
            failed,
            items,
        })
    })
    .await;

    cleanup_batch_task(&task_id_for_cleanup);

    task_result.map_err(|error| format!("任务执行失败: {}", error))?
}

/// 截取视频（快速模式）
#[tauri::command]
pub fn cut_video(
    app: AppHandle,
    input: String,
    output: String,
    start_time: f64,
    end_time: f64,
) -> Result<String, String> {
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    let ffmpeg = get_ffmpeg_path(&app);
    let duration = end_time - start_time;
    let use_faststart = output_needs_faststart(&output);
    info!(
        "[截取] 快速模式: {} -> {}, {:.2}s - {:.2}s (时长 {:.2}s)",
        input, output, start_time, end_time, duration
    );

    let mut args = vec![
        "-y".to_string(),
        "-ss".to_string(),
        format!("{}", start_time),
        "-i".to_string(),
        input.clone(),
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

    args.push(output.clone());

    let result = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if result.status.success() {
        info!("[截取] 快速模式完成: {}", output);
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        if stderr.is_empty() {
            Err("视频截取失败".into())
        } else {
            Err(format!("视频截取失败: {}", stderr))
        }
    }
}

/// 精确截取视频（重新编码，带进度反馈）
#[tauri::command]
pub async fn cut_video_precise(
    app: AppHandle,
    input: String,
    output: String,
    start_time: f64,
    end_time: f64,
) -> Result<String, String> {
    if end_time <= start_time {
        return Err("结束时间必须大于开始时间".into());
    }

    VIDEO_CANCELLED.store(false, Ordering::SeqCst);

    let ffmpeg = get_ffmpeg_path(&app);
    let duration = end_time - start_time;
    info!(
        "[截取] 精确模式: {} -> {}, {:.2}s - {:.2}s (时长 {:.2}s)",
        input, output, start_time, end_time, duration
    );

    let output_clone = output.clone();
    let output_for_cleanup = output.clone();
    let cancelled = VIDEO_CANCELLED.clone();
    let use_faststart = output_needs_faststart(&output);

    let result = tokio::task::spawn_blocking(move || {
        let mut args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input,
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
            output_clone.clone(),
        ]);

        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;

        let pid = child.id();
        *FFMPEG_PROCESS.lock().unwrap() = Some(pid);

        let cut_result = (|| -> Result<bool, String> {
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "无法读取 ffmpeg 输出".to_string())?;
            let reader = BufReader::new(stdout);

            for line in reader.lines().map_while(Result::ok) {
                if cancelled.load(Ordering::SeqCst) {
                    info!("[截取] 用户取消操作，终止 FFmpeg 进程");
                    let _ = child.kill();
                    break;
                }

                if let Some(time_str) = line.strip_prefix("out_time_ms=") {
                    if let Ok(ms) = time_str.parse::<i64>() {
                        let current = ms as f64 / 1_000_000.0;
                        let progress = (current / duration * 100.0).min(100.0).max(0.0);
                        let _ = app.emit("video-progress", progress);
                    }
                } else if let Some(time_str) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = time_str.parse::<i64>() {
                        let current = us as f64 / 1_000_000.0;
                        let progress = (current / duration * 100.0).min(100.0).max(0.0);
                        let _ = app.emit("video-progress", progress);
                    }
                } else if let Some(time_str) = line.strip_prefix("out_time=") {
                    if let Some(secs) = parse_ffmpeg_time(time_str) {
                        let progress = (secs / duration * 100.0).min(100.0).max(0.0);
                        let _ = app.emit("video-progress", progress);
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("等待 ffmpeg 失败: {}", e))?;

            if cancelled.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(&output_clone);
                return Err("操作已取消".to_string());
            }

            if !status.success() {
                let _ = std::fs::remove_file(&output_clone);
                return Err("视频截取失败".into());
            }

            let _ = app.emit("video-progress", 100.0);
            Ok(true)
        })();

        *FFMPEG_PROCESS.lock().unwrap() = None;
        cut_result
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    if result {
        info!("[截取] 精确模式完成: {}", output);
        Ok(output)
    } else {
        let _ = std::fs::remove_file(&output_for_cleanup);
        Err("视频截取失败".into())
    }
}

/// 取消视频截取操作
#[tauri::command]
pub fn cancel_video_cut() {
    info!("[截取] 收到取消请求");
    VIDEO_CANCELLED.store(true, Ordering::SeqCst);

    if let Some(pid) = *FFMPEG_PROCESS.lock().unwrap() {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .status();
        }
    }
}

#[tauri::command]
pub fn cancel_batch_video_trim(task_id: String) {
    info!("[批量去头] 收到取消请求: {}", task_id);
    mark_batch_task_cancelled(&task_id);

    if let Some(pid) = *FFMPEG_PROCESS.lock().unwrap() {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .status();
        }
    }
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

        let result = collect_batch_video_files(vec![temp_dir.path().to_string_lossy().to_string()])
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

        let output = create_unique_output_path(&input, temp_dir.path(), "_trim", false);

        assert_ne!(output, input);
        assert_ne!(output, existing_output);
        assert_eq!(
            output.file_name().and_then(|value| value.to_str()),
            Some("clip_trim-2.mp4")
        );
    }
}
