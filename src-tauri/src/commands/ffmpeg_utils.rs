use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 获取内嵌的 ffmpeg 路径
pub fn get_ffmpeg_path(app: &AppHandle) -> PathBuf {
    // Tauri 2.0 externalBin 会把文件放到 MacOS 目录（macOS）或 exe 同目录（Windows）
    // 文件名不带平台后缀
    
    let binary_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    // 方案1：尝试从 resource_dir/binaries 获取（开发模式）
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("binaries").join(binary_name);
        if path.exists() {
            return path;
        }
        // 带平台后缀的版本（开发模式可能用这个）
        let target = get_target();
        let suffixed_name = if cfg!(target_os = "windows") {
            format!("ffmpeg-{}.exe", target)
        } else {
            format!("ffmpeg-{}", target)
        };
        let path = resource_dir.join("binaries").join(&suffixed_name);
        if path.exists() {
            return path;
        }
    }

    // 方案2：Tauri 打包后放在可执行文件同目录
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            let path = dir.join(binary_name);
            if path.exists() {
                return path;
            }
        }
    }

    // 回退到系统 PATH
    PathBuf::from("ffmpeg")
}

/// 获取内嵌的 ffprobe 路径
pub fn get_ffprobe_path(app: &AppHandle) -> PathBuf {
    let binary_name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("binaries").join(binary_name);
        if path.exists() {
            return path;
        }
        let target = get_target();
        let suffixed_name = if cfg!(target_os = "windows") {
            format!("ffprobe-{}.exe", target)
        } else {
            format!("ffprobe-{}", target)
        };
        let path = resource_dir.join("binaries").join(&suffixed_name);
        if path.exists() {
            return path;
        }
    }

    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            let path = dir.join(binary_name);
            if path.exists() {
                return path;
            }
        }
    }

    PathBuf::from("ffprobe")
}

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
