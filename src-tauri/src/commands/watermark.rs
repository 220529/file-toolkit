use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::AppHandle;
use base64::{Engine as _, engine::general_purpose};

use super::ffmpeg_utils::get_ffmpeg_path;
use super::logger::{log_info, log_error};

#[derive(Debug, Serialize, Deserialize)]
pub struct CropResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub path: String,
    pub thumbnail: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrushStroke {
    pub x: f64,
    pub y: f64,
}

/// 生成缩略图
fn generate_thumbnail(path: &str, app: &AppHandle) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(app);

    // 创建临时文件
    let temp_path = std::env::temp_dir().join(format!("thumb_{}.jpg", std::process::id()));
    
    let output = Command::new(&ffmpeg)
        .args([
            "-y", "-i", path,
            "-vf", "scale=400:-1",
            "-q:v", "5",
            temp_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("生成缩略图失败: {}", e))?;

    if !output.status.success() {
        return Err("生成缩略图失败".to_string());
    }

    // 读取并转为 base64
    let data = fs::read(&temp_path).map_err(|e| format!("读取缩略图失败: {}", e))?;
    let _ = fs::remove_file(&temp_path);
    
    let base64_str = general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

/// 获取图片信息（跨平台：使用 ffprobe）
#[tauri::command]
pub fn get_image_info(app: AppHandle, path: String) -> Result<ImageInfo, String> {
    log_info(&format!("[去水印] 获取图片信息: {}", path));
    
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        log_error(&format!("[去水印] 文件不存在: {}", path));
        return Err("文件不存在".to_string());
    }

    let ffprobe = super::ffmpeg_utils::get_ffprobe_path(&app);
    log_info(&format!("[去水印] 使用 ffprobe: {:?}", ffprobe));

    // 使用 ffprobe 获取图片尺寸（跨平台）
    let output = Command::new(&ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            &path,
        ])
        .output()
        .map_err(|e| {
            let msg = format!("获取图片信息失败: {}", e);
            log_error(&format!("[去水印] {}", msg));
            msg
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("ffprobe 错误: {}", stderr);
        log_error(&format!("[去水印] {}", msg));
        return Err(msg);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split('x').collect();
    
    let (width, height) = if parts.len() >= 2 {
        (
            parts[0].parse().unwrap_or(0),
            parts[1].parse().unwrap_or(0),
        )
    } else {
        (0, 0)
    };

    if width == 0 || height == 0 {
        log_error(&format!("[去水印] 无法获取图片尺寸, ffprobe 输出: {}", stdout));
        return Err("无法获取图片尺寸".to_string());
    }

    log_info(&format!("[去水印] 图片尺寸: {}x{}", width, height));

    // 生成缩略图
    let thumbnail = generate_thumbnail(&path, &app).unwrap_or_default();

    Ok(ImageInfo {
        width,
        height,
        path,
        thumbnail,
    })
}

/// 用颜色覆盖水印区域
#[tauri::command]
pub fn remove_watermark(
    app: AppHandle,
    input_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: String,
    mode: String,
    brush_strokes: Vec<BrushStroke>,
    brush_size: u32,
) -> Result<CropResult, String> {
    let input = Path::new(&input_path);
    if !input.exists() {
        return Err("文件不存在".to_string());
    }

    // 参数校验
    if width == 0 || height == 0 {
        return Err("选区尺寸无效".to_string());
    }

    let ffmpeg = get_ffmpeg_path(&app);

    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    let ext = input.extension().unwrap_or_default().to_string_lossy();
    let parent = input.parent().unwrap_or(Path::new("."));
    let output_path = parent.join(format!("{}_no_watermark.{}", stem, ext));

    // 转换颜色格式：#ffffff -> 0xffffff
    let ffmpeg_color = if color.starts_with('#') {
        format!("0x{}", &color[1..])
    } else {
        color.clone()
    };

    // 根据模式构建命令
    let output = match mode.as_str() {
        "blur" => {
            // 高斯模糊：使用 delogo 或 boxblur
            // 方案：用 boxblur 对指定区域模糊
            let filter = format!(
                "[0:v]crop={}:{}:{}:{}[crop];[crop]boxblur=15:3[blur];[0:v][blur]overlay={}:{}",
                width, height, x, y, x, y
            );
            Command::new(&ffmpeg)
                .args([
                    "-y", "-i", &input_path,
                    "-filter_complex", &filter,
                    "-q:v", "1",
                    output_path.to_string_lossy().as_ref(),
                ])
                .output()
                .map_err(|e| format!("处理失败: {}", e))?
        }
        "fill" | _ => {
            // 颜色覆盖
            let filter = format!(
                "drawbox=x={}:y={}:w={}:h={}:color={}:t=fill",
                x, y, width, height, ffmpeg_color
            );
            Command::new(&ffmpeg)
                .args([
                    "-y", "-i", &input_path,
                    "-vf", &filter,
                    "-q:v", "1",
                    output_path.to_string_lossy().as_ref(),
                ])
                .output()
                .map_err(|e| format!("处理失败: {}", e))?
        }
    };

    let _ = brush_strokes;
    let _ = brush_size;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("处理失败: {}", stderr));
    }

    Ok(CropResult {
        success: true,
        output_path: output_path.to_string_lossy().to_string(),
        message: format!("已保存到: {}", output_path.display()),
    })
}

/// 批量去水印
#[tauri::command]
pub fn batch_remove_watermark(
    app: AppHandle,
    input_paths: Vec<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: String,
    mode: String,
) -> Result<Vec<CropResult>, String> {
    let mut results = Vec::new();
    
    for path in input_paths {
        match remove_watermark(
            app.clone(), path.clone(), x, y, width, height, 
            color.clone(), mode.clone(), vec![], 0
        ) {
            Ok(result) => results.push(result),
            Err(e) => results.push(CropResult {
                success: false,
                output_path: String::new(),
                message: format!("{}: {}", path, e),
            }),
        }
    }
    
    Ok(results)
}
