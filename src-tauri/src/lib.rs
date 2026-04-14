mod commands;

use commands::convert::{cancel_convert, convert_video, get_file_size};
use commands::dedup::{cancel_dedup, delete_files, find_duplicates, get_file_thumbnail};
use commands::file_stats::{cancel_file_stats, scan_directory};
use commands::logger::{get_log_path, get_recent_logs};
use commands::system::open_file_path;
use commands::video::{
    batch_trim_videos, cancel_batch_video_trim, cancel_video_cut, collect_batch_video_files,
    cut_video, cut_video_precise, generate_preview_frame, generate_timeline_frames,
    get_video_duration, get_video_info,
};
use commands::watermark::{batch_remove_watermark, get_image_info, remove_watermark};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            cancel_file_stats,
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
            collect_batch_video_files,
            batch_trim_videos,
            cancel_batch_video_trim,
            convert_video,
            cancel_convert,
            get_image_info,
            remove_watermark,
            batch_remove_watermark,
            get_file_size,
            get_log_path,
            get_recent_logs,
            open_file_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
