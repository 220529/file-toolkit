use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use log::{debug, info};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::logger::{log_error, log_info};

// 全局变量存储当前 FFmpeg 进程，用于取消
lazy_static::lazy_static! {
    static ref VIDEO_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref FFMPEG_PROCESS: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
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
