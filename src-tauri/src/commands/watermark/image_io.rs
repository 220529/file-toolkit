use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::AppHandle;

use super::super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::super::process::ProcessSlot;
use super::runner::{run_command_output, track_process};
use super::temp::{build_temp_mask_path, build_temp_thumbnail_path, remove_file_quietly};

const RGBA_CHANNELS: usize = 4;

pub(super) fn generate_thumbnail(path: &str, app: &AppHandle) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(app);
    let temp_path = build_temp_thumbnail_path();

    let temp_path_string = temp_path.to_string_lossy().to_string();
    let mut command = Command::new(&ffmpeg);
    command.args([
        "-y",
        "-i",
        path,
        "-vf",
        "scale=400:-1",
        "-q:v",
        "5",
        &temp_path_string,
    ]);
    let output = run_command_output(&mut command, None, "生成缩略图失败")?;

    if !output.status.success() {
        remove_file_quietly(&temp_path);
        return Err("生成缩略图失败".to_string());
    }

    let data = fs::read(&temp_path).map_err(|error| {
        remove_file_quietly(&temp_path);
        format!("读取缩略图失败: {}", error)
    })?;
    remove_file_quietly(&temp_path);

    let base64_str = general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

pub(super) fn probe_image_dimensions(app: &AppHandle, path: &str) -> Result<(u32, u32), String> {
    let ffprobe = get_ffprobe_path(app);
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            path,
        ])
        .output()
        .map_err(|error| format!("获取图片信息失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe 错误: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split('x').collect();
    let (width, height) = if parts.len() >= 2 {
        (
            parts[0].parse().unwrap_or(0_u32),
            parts[1].parse().unwrap_or(0_u32),
        )
    } else {
        (0, 0)
    };

    if width == 0 || height == 0 {
        return Err("无法获取图片尺寸".to_string());
    }

    Ok((width, height))
}

pub(super) fn decode_image_rgba(
    app: &AppHandle,
    path: &str,
    image_width: u32,
    image_height: u32,
    process_slot: Option<&ProcessSlot>,
) -> Result<Vec<u8>, String> {
    let ffmpeg = get_ffmpeg_path(app);
    let mut command = Command::new(&ffmpeg);
    command.args([
        "-v",
        "error",
        "-i",
        path,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-frames:v",
        "1",
        "pipe:1",
    ]);
    let output = run_command_output(&mut command, process_slot, "读取图片像素失败")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("读取图片像素失败: {}", stderr));
    }

    let expected_size = image_width as usize * image_height as usize * RGBA_CHANNELS;
    if output.stdout.len() != expected_size {
        return Err(format!(
            "读取图片像素失败: 实际输出 {} 字节，期望 {} 字节",
            output.stdout.len(),
            expected_size
        ));
    }

    Ok(output.stdout)
}

pub(super) fn encode_image_rgba(
    app: &AppHandle,
    pixels: &[u8],
    image_width: u32,
    image_height: u32,
    output_path: &Path,
    process_slot: Option<&ProcessSlot>,
) -> Result<(), String> {
    let ffmpeg = get_ffmpeg_path(app);
    let expected_size = image_width as usize * image_height as usize * RGBA_CHANNELS;
    if pixels.len() != expected_size {
        return Err("输出像素尺寸无效".to_string());
    }

    let video_size = format!("{}x{}", image_width, image_height);
    let output_path_string = output_path.to_string_lossy().to_string();
    let mut child = Command::new(&ffmpeg)
        .args([
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-video_size",
            &video_size,
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-q:v",
            "1",
            &output_path_string,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("写出修复结果失败: {}", error))?;
    let _process_tracker = process_slot.map(|slot| track_process(slot, child.id()));

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(pixels).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            remove_file_quietly(output_path);
            format!("写出修复结果失败: {}", error)
        })?;
    }

    let output = child.wait_with_output().map_err(|error| {
        remove_file_quietly(output_path);
        format!("写出修复结果失败: {}", error)
    })?;

    if output.status.success() {
        Ok(())
    } else {
        remove_file_quietly(output_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("写出修复结果失败: {}", stderr))
    }
}

pub(super) fn run_ffmpeg_repair_fallback(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &Path,
    mask: &[u8],
    image_width: u32,
    image_height: u32,
    process_slot: Option<&ProcessSlot>,
) -> Result<(), String> {
    let mask_path = build_temp_mask_path();
    let result = (|| -> Result<(), String> {
        write_mask_file(&mask_path, image_width, image_height, mask)?;
        let filter = format!("removelogo={}", escape_filter_path(&mask_path));
        let output_path_string = output_path.to_string_lossy().to_string();

        let mut command = Command::new(ffmpeg);
        command.args([
            "-y",
            "-i",
            input_path,
            "-vf",
            &filter,
            "-q:v",
            "1",
            &output_path_string,
        ]);
        let output = run_command_output(&mut command, process_slot, "处理失败")?;

        if output.status.success() {
            Ok(())
        } else {
            remove_file_quietly(output_path);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("处理失败: {}", stderr))
        }
    })();

    remove_file_quietly(&mask_path);
    result
}

fn escape_filter_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let escaped = normalized
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'");
    format!("filename='{}'", escaped)
}

fn write_mask_file(
    path: &Path,
    image_width: u32,
    image_height: u32,
    mask: &[u8],
) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| format!("创建蒙版失败: {}", error))?;
    write!(file, "P5\n{} {}\n255\n", image_width, image_height)
        .map_err(|error| format!("写入蒙版失败: {}", error))?;
    file.write_all(mask)
        .map_err(|error| format!("写入蒙版失败: {}", error))?;
    Ok(())
}
