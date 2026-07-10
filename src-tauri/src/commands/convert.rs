use log::info;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::file_ops::{unique_output_path, validate_input_file, TemporaryOutput};
use super::process::{
    kill_tracked_process, new_process_slot, run_tracked_output, ProcessSlot, ProcessTracker,
};

lazy_static::lazy_static! {
    static ref CONVERT_CANCELLED: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref CONVERT_PROCESS: ProcessSlot = new_process_slot();
    static ref CURRENT_CONVERT_TASK: Mutex<Option<String>> = Mutex::new(None);
}

#[derive(Clone, Serialize)]
struct ConvertProgress {
    task_id: String,
    percent: f64,
}

struct ConvertTaskGuard {
    task_id: String,
}

impl Drop for ConvertTaskGuard {
    fn drop(&mut self) {
        let mut current = lock_current_task();
        if current.as_deref() == Some(self.task_id.as_str()) {
            *current = None;
        }
    }
}

fn lock_current_task() -> MutexGuard<'static, Option<String>> {
    CURRENT_CONVERT_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_convert_task(task_id: &str) -> Result<ConvertTaskGuard, String> {
    let mut current = lock_current_task();
    if current.is_some() {
        return Err("已有格式转换任务正在运行".into());
    }
    *current = Some(task_id.to_string());
    Ok(ConvertTaskGuard {
        task_id: task_id.to_string(),
    })
}

/// 获取视频时长
fn get_duration(app: &AppHandle, path: &str, cancelled: &AtomicBool) -> Result<f64, String> {
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
    let output = run_tracked_output(
        &mut command,
        Some(&CONVERT_PROCESS),
        Some(cancelled),
        "执行 ffprobe 失败",
    )?;

    if !output.status.success() {
        return Err("读取视频时长失败".into());
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("解析时长失败: {}", e))
}

/// 转换视频格式
#[tauri::command]
pub async fn convert_video(
    app: AppHandle,
    task_id: String,
    input: String,
    output: String,
    format: String,
    quality: String,
) -> Result<String, String> {
    let _task_guard = register_convert_task(&task_id)?;
    CONVERT_CANCELLED.store(false, Ordering::SeqCst);

    let input_path = PathBuf::from(&input);
    validate_input_file(&input_path)?;
    if !matches!(format.as_str(), "mp4" | "mov" | "gif") {
        return Err("不支持的输出格式".into());
    }
    if !matches!(quality.as_str(), "high" | "medium" | "low") {
        return Err("不支持的画质选项".into());
    }

    let requested_output = PathBuf::from(&output);
    let final_output = unique_output_path(&requested_output, &[input_path.as_path()])?;
    let ffmpeg = get_ffmpeg_path(&app);

    info!("[转换] 开始处理 ({}, 画质: {})", format, quality);

    let cancelled = CONVERT_CANCELLED.clone();
    let format = format.clone();
    let progress_task_id = task_id.clone();

    // 根据画质选择 CRF 值（越小质量越高）
    let crf = match quality.as_str() {
        "high" => "18",
        "medium" => "23",
        "low" => "28",
        _ => "20",
    };

    let result = tokio::task::spawn_blocking(move || {
        let duration = get_duration(&app, &input, &cancelled)?;
        let temporary_output = TemporaryOutput::new(&final_output)?;
        let temporary_output_string = temporary_output.path().to_string_lossy().to_string();
        let mut args = vec![
            "-n".to_string(),
            "-i".to_string(),
            input.clone(),
            "-threads".to_string(),
            "0".to_string(),
        ];

        if format == "gif" {
            // GIF：限制帧率和尺寸
            args.extend([
                "-vf".to_string(),
                "fps=12,scale='min(480,iw)':-1:flags=lanczos".to_string(),
                "-c:v".to_string(),
                "gif".to_string(),
                "-an".to_string(),
            ]);
        } else {
            // MP4/MOV：使用 libx264 软编码（兼容性最好）
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "192k".to_string(),
            ]);
        }

        args.extend(["-progress".to_string(), "pipe:1".to_string()]);
        args.push(temporary_output_string);

        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;

        let _process_tracker = ProcessTracker::register(&CONVERT_PROCESS, child.id());
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("操作已取消".into());
        }

        let convert_result = (|| -> Result<String, String> {
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "无法读取 ffmpeg 输出".to_string())?;
            let reader = BufReader::new(stdout);

            for line in reader.lines().map_while(Result::ok) {
                if cancelled.load(Ordering::SeqCst) {
                    info!("[转换] 用户取消操作");
                    let _ = child.kill();
                    break;
                }

                if let Some(time_str) = line.strip_prefix("out_time=") {
                    if let Some(secs) = parse_ffmpeg_time(time_str) {
                        let progress = (secs / duration * 100.0).clamp(0.0, 100.0);
                        let _ = app.emit(
                            "convert-progress",
                            ConvertProgress {
                                task_id: progress_task_id.clone(),
                                percent: progress,
                            },
                        );
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("等待 ffmpeg 失败: {}", e))?;

            if cancelled.load(Ordering::SeqCst) {
                return Err("操作已取消".to_string());
            }

            if !status.success() {
                return Err("格式转换失败".into());
            }

            temporary_output.commit(&final_output)?;
            let _ = app.emit(
                "convert-progress",
                ConvertProgress {
                    task_id: progress_task_id,
                    percent: 100.0,
                },
            );

            Ok(final_output.to_string_lossy().to_string())
        })();

        convert_result
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;

    info!("[转换] 完成");
    Ok(result)
}

/// 取消转换
#[tauri::command]
pub fn cancel_convert(task_id: String) {
    let current = lock_current_task();
    if current.as_deref() != Some(task_id.as_str()) {
        return;
    }

    info!("[转换] 收到取消请求: {}", task_id);
    CONVERT_CANCELLED.store(true, Ordering::SeqCst);

    kill_tracked_process(&CONVERT_PROCESS);
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
