use serde::Serialize;
use std::collections::HashMap;
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct FileStats {
    pub extension: String,
    pub count: u64,
    pub total_size: u64,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub stats: Vec<FileStats>,
    pub total_files: u64,
    pub total_size: u64,
    pub type_count: usize,
}

#[tauri::command]
pub fn scan_directory(path: String) -> Result<ScanResult, String> {
    let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
    let mut total_files: u64 = 0;
    let mut total_size: u64 = 0;

    for entry in WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let ext = entry
            .path()
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let stat = stats.entry(ext).or_insert((0, 0));
        stat.0 += 1;
        stat.1 += size;

        total_files += 1;
        total_size += size;
    }

    let mut result: Vec<FileStats> = stats
        .into_iter()
        .map(|(ext, (count, size))| FileStats {
            extension: if ext.is_empty() {
                "(无扩展名)".into()
            } else {
                format!(".{}", ext)
            },
            count,
            total_size: size,
        })
        .collect();

    // 按数量降序排序
    result.sort_by(|a, b| b.count.cmp(&a.count));

    Ok(ScanResult {
        type_count: result.len(),
        stats: result,
        total_files,
        total_size,
    })
}
