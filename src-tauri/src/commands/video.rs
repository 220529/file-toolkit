use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use log::{debug, info};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::logger::{log_info, log_error};

// 全局变量存储当前 FFmpeg 进程，用于取消
lazy_static::lazy_static! {
    static ref VIDEO_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref FFMPEG_PROCESS: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
}

/// 生成视频预览帧（返回 base64 编码的图片）
#[tauri::command]
pub fn generate_preview_frame(app: AppHandle, path: String, time: f64) -> Result<String, String> {
    debug!("[预览] 生成预览帧: {} @ {:.2}s", path, time);
    let ffmpeg = get_ffmpeg_path(&app);

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("preview_{}.jpg", std::process::id()));
    let temp_path = temp_file.to_string_lossy().to_string();

    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-ss",
            &format!("{}", time),
            "-i",
            &path,
            "-vframes",
            "1",
            "-q:v",
            "2",
            &temp_path,
        ])
        .output()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if !status.status.success() {
        return Err("生成预览帧失败".into());
    }

    let image_data =
        std::fs::read(&temp_file).map_err(|e| format!("读取预览图失败: {}", e))?;
    let _ = std::fs::remove_file(&temp_file);

    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64.encode(&image_data)
    ))
}

/// 生成多个预览帧（用于时间轴）
#[tauri::command]
pub fn generate_timeline_frames(
    app: AppHandle,
    path: String,
    count: u32,
) -> Result<Vec<String>, String> {
    let duration = get_video_duration(app.clone(), path.clone())?;

    let mut frames = Vec::new();
    let interval = duration / (count as f64 + 1.0);

    for i in 1..=count {
        let time = interval * (i as f64);
        match generate_preview_frame(app.clone(), path.clone(), time) {
            Ok(frame) => frames.push(frame),
            Err(_) => continue,
        }
    }

    Ok(frames)
}

/// 获取视频时长（秒）
#[tauri::command]
pub fn get_video_duration(app: AppHandle, path: String) -> Result<f64, String> {
    let ffprobe = get_ffprobe_path(&app);
    log_info(&format!("[视频] 获取时长: {}, ffprobe: {:?}", path, ffprobe));

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
    duration_str
        .trim()
        .parse::<f64>()
        .map_err(|e| {
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
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
            &path,
        ])
        .output()
        .map_err(|e| format!("执行 ffprobe 失败: {}", e))?;

    let info_str = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = info_str.trim().split(',').collect();

    let (width, height, fps) = if parts.len() >= 3 {
        let w = parts[0].parse().unwrap_or(0);
        let h = parts[1].parse().unwrap_or(0);
        let fps_str = parts[2];
        let fps = if fps_str.contains('/') {
            let fps_parts: Vec<&str> = fps_str.split('/').collect();
            let num: f64 = fps_parts[0].parse().unwrap_or(30.0);
            let den: f64 = fps_parts[1].parse().unwrap_or(1.0);
            num / den
        } else {
            fps_str.parse().unwrap_or(30.0)
        };
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
    info!(
        "[截取] 快速模式: {} -> {}, {:.2}s - {:.2}s (时长 {:.2}s)",
        input, output, start_time, end_time, duration
    );

    let result = Command::new(&ffmpeg)
        .args([
            "-y",
            "-ss",
            &format!("{}", start_time),
            "-i",
            &input,
            "-t",
            &format!("{}", duration),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            &output,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if result.success() {
        info!("[截取] 快速模式完成: {}", output);
        Ok(output)
    } else {
        Err("视频截取失败".into())
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

    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(&ffmpeg)
            .args([
                "-y",
                "-ss",
                &format!("{}", start_time),
                "-i",
                &input,
                "-t",
                &format!("{}", duration),
                "-c:v",
                "libx264",
                "-crf",
                "23",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-progress",
                "pipe:1",
                &output_clone,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;

        let pid = child.id();
        *FFMPEG_PROCESS.lock().unwrap() = Some(pid);

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        for line in reader.lines().map_while(Result::ok) {
            if cancelled.load(Ordering::SeqCst) {
                info!("[截取] 用户取消操作，终止 FFmpeg 进程");
                let _ = child.kill();
                return Err("操作已取消".to_string());
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

        *FFMPEG_PROCESS.lock().unwrap() = None;

        let status = child
            .wait()
            .map_err(|e| format!("等待 ffmpeg 失败: {}", e))?;
        let _ = app.emit("video-progress", 100.0);

        Ok::<bool, String>(status.success())
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
