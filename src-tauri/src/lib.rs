mod commands;

use commands::dedup::{cancel_dedup, delete_files, find_duplicates, get_file_thumbnail};
use commands::file_stats::scan_directory;
use commands::video::{
    cancel_video_cut, cut_video, cut_video_precise, generate_preview_frame,
    generate_timeline_frames, get_video_duration, get_video_info,
};
use log::info;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("File Toolkit 启动中...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
