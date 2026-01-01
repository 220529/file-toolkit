use log::info;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};

lazy_static::lazy_static! {
    static ref CONVERT_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref CONVERT_PROCESS: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
}

/// 获取视频时长
fn get_duration(app: &AppHandle, path: &str) -> Result<f64, String> {
    let ffprobe = get_ffprobe_path(app);
    let output = Command::new(&ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .map_err(|e| format!("执行 ffprobe 失败: {}", e))?;

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("解析时长失败: {}", e))
}

/// 转换视频格式
#[tauri::command]
pub async fn convert_video(
    app: AppHandle,
    input: String,
    output: String,
    format: String,
    quality: String,
) -> Result<String, String> {
    CONVERT_CANCELLED.store(false, Ordering::SeqCst);

    let ffmpeg = get_ffmpeg_path(&app);
    let duration = get_duration(&app, &input)?;

    info!("[转换] {} -> {} ({}, 画质: {})", input, output, format, quality);

    let output_clone = output.clone();
    let output_for_cleanup = output.clone();
    let cancelled = CONVERT_CANCELLED.clone();
    let format = format.clone();

    // 根据画质选择 CRF 值（越小质量越高）
    let crf = match quality.as_str() {
        "high" => "18",
        "medium" => "23",
        "low" => "28",
        _ => "20",
    };

    let result = tokio::task::spawn_blocking(move || {
        let mut args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input.clone(),
            "-threads".to_string(), "0".to_string(),
        ];

        if format == "gif" {
            // GIF：限制帧率和尺寸
            args.extend([
                "-vf".to_string(), "fps=12,scale='min(480,iw)':-1:flags=lanczos".to_string(),
                "-c:v".to_string(), "gif".to_string(),
                "-an".to_string(),
            ]);
        } else {
            // MP4/MOV：使用 libx264 软编码（兼容性最好）
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-preset".to_string(), "fast".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), "192k".to_string(),
            ]);
        }

        args.extend(["-progress".to_string(), "pipe:1".to_string()]);
        args.push(output_clone.clone());

        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;

        let pid = child.id();
        *CONVERT_PROCESS.lock().unwrap() = Some(pid);

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        for line in reader.lines().map_while(Result::ok) {
            if cancelled.load(Ordering::SeqCst) {
                info!("[转换] 用户取消操作");
                let _ = child.kill();
                return Err("操作已取消".to_string());
            }

            if let Some(time_str) = line.strip_prefix("out_time=") {
                if let Some(secs) = parse_ffmpeg_time(time_str) {
                    let progress = (secs / duration * 100.0).min(100.0).max(0.0);
                    let _ = app.emit("convert-progress", progress);
                }
            }
        }

        *CONVERT_PROCESS.lock().unwrap() = None;

        let status = child.wait().map_err(|e| format!("等待 ffmpeg 失败: {}", e))?;
        let _ = app.emit("convert-progress", 100.0);

        Ok::<bool, String>(status.success())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    if result {
        info!("[转换] 完成: {}", output);
        Ok(output)
    } else {
        let _ = std::fs::remove_file(&output_for_cleanup);
        Err("格式转换失败".into())
    }
}

/// 取消转换
#[tauri::command]
pub fn cancel_convert() {
    info!("[转换] 收到取消请求");
    CONVERT_CANCELLED.store(true, Ordering::SeqCst);

    if let Some(pid) = *CONVERT_PROCESS.lock().unwrap() {
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


/// 获取文件大小
#[tauri::command]
pub fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("获取文件大小失败: {}", e))
}
