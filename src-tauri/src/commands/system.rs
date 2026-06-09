use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
pub struct PathMetadata {
    pub size: u64,
    pub modified_ms: u64,
    pub is_file: bool,
    pub is_dir: bool,
}

#[tauri::command]
pub fn open_file_path(app: AppHandle, path: String) -> Result<(), String> {
    std::fs::metadata(&path).map_err(|e| format!("无法访问文件: {}", e))?;

    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_file_path(app: AppHandle, path: String) -> Result<(), String> {
    std::fs::metadata(&path).map_err(|e| format!("无法访问文件: {}", e))?;

    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::fs::metadata(path).is_ok()
}

#[tauri::command]
pub fn get_path_metadata(path: String) -> Result<PathMetadata, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败: {}", e))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);

    Ok(PathMetadata {
        size: metadata.len(),
        modified_ms,
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "system-command-test-{}-{}-{}",
                std::process::id(),
                NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("failed to create temp test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn path_exists_reports_existing_and_missing_paths() {
        let temp_dir = TestDir::new();
        let existing = temp_dir.path().join("sample.txt");
        fs::write(&existing, b"hello").expect("failed to write test file");
        let missing = temp_dir.path().join("missing.txt");

        assert!(path_exists(existing.to_string_lossy().to_string()));
        assert!(!path_exists(missing.to_string_lossy().to_string()));
    }

    #[test]
    fn get_path_metadata_returns_size_kind_and_mtime() {
        let temp_dir = TestDir::new();
        let file_path = temp_dir.path().join("sample.txt");
        fs::write(&file_path, b"hello").expect("failed to write test file");

        let file_meta = get_path_metadata(file_path.to_string_lossy().to_string())
            .expect("file metadata should be available");
        assert_eq!(file_meta.size, 5);
        assert!(file_meta.modified_ms > 0);
        assert!(file_meta.is_file);
        assert!(!file_meta.is_dir);

        let dir_meta = get_path_metadata(temp_dir.path().to_string_lossy().to_string())
            .expect("directory metadata should be available");
        assert!(dir_meta.is_dir);
        assert!(!dir_meta.is_file);
    }

    #[test]
    fn get_path_metadata_rejects_missing_paths() {
        let temp_dir = TestDir::new();
        let missing = temp_dir.path().join("missing.txt");

        let error = get_path_metadata(missing.to_string_lossy().to_string())
            .expect_err("missing path should return an error");
        assert!(error.contains("读取文件信息失败"));
    }
}
