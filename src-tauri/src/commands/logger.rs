use chrono::Local;
use log::{LevelFilter, Metadata, Record};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, Once};
use tauri::{AppHandle, Manager};

lazy_static::lazy_static! {
    static ref LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
}

static LOGGER: AppLogger = AppLogger;
static LOGGER_INIT: Once = Once::new();
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_LINE_CHARS: usize = 4_000;
const RECENT_LOG_READ_BYTES: u64 = 256 * 1024;

struct AppLogger;

fn lock_log_path() -> MutexGuard<'static, Option<PathBuf>> {
    LOG_PATH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl log::Log for AppLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{}] [{}] {}", timestamp, record.level(), record.args());

        eprintln!("{}", line);

        if let Some(path) = lock_log_path().as_ref() {
            let _ = append_log_line(path, &line);
        }
    }

    fn flush(&self) {}
}

fn append_log_line(path: &PathBuf, line: &str) -> std::io::Result<()> {
    if fs::metadata(path)
        .map(|metadata| metadata.len() >= MAX_LOG_FILE_BYTES)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let bounded_line: String = line.chars().take(MAX_LOG_LINE_CHARS).collect();
    writeln!(file, "{}", bounded_line)?;
    Ok(())
}

pub fn init_logger(app: &AppHandle) {
    if let Ok(app_data) = app.path().app_data_dir() {
        let log_dir = app_data.join("logs");
        let _ = fs::create_dir_all(&log_dir);

        let today = Local::now().format("%Y-%m-%d").to_string();
        let log_file = log_dir.join(format!("{}.log", today));
        *lock_log_path() = Some(log_file);

        cleanup_old_logs(&log_dir, 7);
    }

    LOGGER_INIT.call_once(|| {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(LevelFilter::Info);
    });

    log::info!("应用启动");
}

fn cleanup_old_logs(log_dir: &PathBuf, keep_days: i64) {
    if let Ok(entries) = fs::read_dir(log_dir) {
        let cutoff = Local::now() - chrono::Duration::days(keep_days);
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".log") {
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

pub fn log_info(message: &str) {
    log::info!("{}", message);
}

pub fn log_error(message: &str) {
    log::error!("{}", message);
}

#[allow(dead_code)]
pub fn log_warn(message: &str) {
    log::warn!("{}", message);
}

#[tauri::command]
pub fn get_log_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("logs").to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_logs(app: AppHandle, lines: Option<usize>) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    let today = Local::now().format("%Y-%m-%d").to_string();
    let log_file = log_dir.join(format!("{}.log", today));

    if !log_file.exists() {
        return Ok("暂无日志".to_string());
    }

    let mut file = fs::File::open(&log_file).map_err(|e| format!("读取日志失败: {}", e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败: {}", e))?
        .len();
    let start_offset = file_len.saturating_sub(RECENT_LOG_READ_BYTES);
    file.seek(SeekFrom::Start(start_offset))
        .map_err(|e| format!("定位日志失败: {}", e))?;
    let mut bytes = Vec::with_capacity((file_len - start_offset) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("读取日志失败: {}", e))?;
    let decoded = String::from_utf8_lossy(&bytes);
    let content = if start_offset > 0 {
        decoded.split_once('\n').map(|(_, tail)| tail).unwrap_or("")
    } else {
        decoded.as_ref()
    };
    let max_lines = lines.unwrap_or(200).clamp(1, 1_000);
    let log_lines: Vec<&str> = content.lines().collect();
    let start = log_lines.len().saturating_sub(max_lines);

    Ok(log_lines[start..].join("\n"))
}
