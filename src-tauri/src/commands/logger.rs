use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use chrono::Local;
use tauri::{AppHandle, Manager};

lazy_static::lazy_static! {
    static ref LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
}

/// 初始化日志系统
pub fn init_logger(app: &AppHandle) {
    if let Ok(app_data) = app.path().app_data_dir() {
        let log_dir = app_data.join("logs");
        let _ = fs::create_dir_all(&log_dir);
        
        // 日志文件按日期命名
        let today = Local::now().format("%Y-%m-%d").to_string();
        let log_file = log_dir.join(format!("{}.log", today));
        
        *LOG_PATH.lock().unwrap() = Some(log_file.clone());
        
        // 写入启动日志
        let _ = write_log_internal(&log_file, "INFO", "应用启动");
        
        // 清理 7 天前的日志
        cleanup_old_logs(&log_dir, 7);
    }
}

/// 写入日志
fn write_log_internal(path: &PathBuf, level: &str, message: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    writeln!(file, "[{}] [{}] {}", timestamp, level, message)?;
    Ok(())
}

/// 清理旧日志
fn cleanup_old_logs(log_dir: &PathBuf, keep_days: i64) {
    if let Ok(entries) = fs::read_dir(log_dir) {
        let cutoff = Local::now() - chrono::Duration::days(keep_days);
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".log") {
                    // 解析文件名中的日期
                    let date_str = name.trim_end_matches(".log");
                    if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                        if date < cutoff.date_naive() {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

/// 公开的日志写入函数
pub fn log_info(message: &str) {
    if let Some(path) = LOG_PATH.lock().unwrap().as_ref() {
        let _ = write_log_internal(path, "INFO", message);
    }
    log::info!("{}", message);
}

pub fn log_error(message: &str) {
    if let Some(path) = LOG_PATH.lock().unwrap().as_ref() {
        let _ = write_log_internal(path, "ERROR", message);
    }
    log::error!("{}", message);
}

#[allow(dead_code)]
pub fn log_warn(message: &str) {
    if let Some(path) = LOG_PATH.lock().unwrap().as_ref() {
        let _ = write_log_internal(path, "WARN", message);
    }
    log::warn!("{}", message);
}

/// 获取日志目录路径
#[tauri::command]
pub fn get_log_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("logs").to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// 获取最近的日志内容（最后 N 行）
#[tauri::command]
pub fn get_recent_logs(app: AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    
    let today = Local::now().format("%Y-%m-%d").to_string();
    let log_file = log_dir.join(format!("{}.log", today));
    
    if !log_file.exists() {
        return Ok("暂无日志".to_string());
    }
    
    let content = fs::read_to_string(&log_file)
        .map_err(|e| format!("读取日志失败: {}", e))?;
    
    let max_lines = lines.unwrap_or(100);
    let log_lines: Vec<&str> = content.lines().collect();
    let start = log_lines.len().saturating_sub(max_lines);
    
    Ok(log_lines[start..].join("\n"))
}
