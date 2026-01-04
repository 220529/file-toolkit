mod commands;

use commands::convert::{cancel_convert, convert_video, get_file_size};
use commands::dedup::{cancel_dedup, delete_files, find_duplicates, get_file_thumbnail};
use commands::file_stats::scan_directory;
use commands::video::{
    cancel_video_cut, cut_video, cut_video_precise, generate_preview_frame,
    generate_timeline_frames, get_video_duration, get_video_info,
};
use commands::watermark::{batch_remove_watermark, remove_watermark, get_image_info};
use commands::logger::{get_log_path, get_recent_logs};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化文件日志
            commands::logger::init_logger(app.handle());
            commands::logger::log_info("小文喵启动完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            find_duplicates,
            delete_files,
            get_file_thumbnail,
            cancel_dedup,
            get_video_duration,
            get_video_info,
            cut_video,
            cut_video_precise,
            generate_preview_frame,
            generate_timeline_frames,
            cancel_video_cut,
            convert_video,
            cancel_convert,
            get_image_info,
            remove_watermark,
            batch_remove_watermark,
            get_file_size,
            get_log_path,
            get_recent_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
