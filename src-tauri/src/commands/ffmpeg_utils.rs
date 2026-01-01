use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 获取当前平台的 target triple
fn get_target() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "x86_64") {
            "x86_64-apple-darwin"
        } else {
            "aarch64-apple-darwin"
        }
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

/// 获取内嵌的 ffmpeg 路径
pub fn get_ffmpeg_path(app: &AppHandle) -> PathBuf {
    let target = get_target();
    let binary_name = if cfg!(target_os = "windows") {
        format!("ffmpeg-{}.exe", target)
    } else {
        format!("ffmpeg-{}", target)
    };

    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.join("binaries").join(&binary_name))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// 获取内嵌的 ffprobe 路径
pub fn get_ffprobe_path(app: &AppHandle) -> PathBuf {
    let target = get_target();
    let binary_name = if cfg!(target_os = "windows") {
        format!("ffprobe-{}.exe", target)
    } else {
        format!("ffprobe-{}", target)
    };

    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.join("binaries").join(&binary_name))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("ffprobe"))
}
