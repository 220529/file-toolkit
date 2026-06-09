use std::fs;
use std::path::{Path, PathBuf};

pub(super) fn build_temp_thumbnail_path() -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("thumb_{}_{}.jpg", std::process::id(), unique))
}

pub(super) fn build_temp_mask_path() -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "watermark-mask_{}_{}.pgm",
        std::process::id(),
        unique
    ))
}

pub(super) fn remove_file_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}
