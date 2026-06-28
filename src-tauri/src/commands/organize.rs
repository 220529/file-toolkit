use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::logger::{log_error, log_info};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeOperation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeFilesRequest {
    pub operations: Vec<OrganizeOperation>,
}

#[derive(Debug, Serialize)]
pub struct OrganizeResultItem {
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OrganizeFilesResult {
    pub total: usize,
    pub moved: usize,
    pub failed: usize,
    pub elapsed_ms: u64,
    pub items: Vec<OrganizeResultItem>,
}

#[tauri::command]
pub fn organize_files(request: OrganizeFilesRequest) -> Result<OrganizeFilesResult, String> {
    organize_files_inner(request, true)
}

fn organize_files_inner(
    request: OrganizeFilesRequest,
    execute: bool,
) -> Result<OrganizeFilesResult, String> {
    let started = Instant::now();
    validate_operations(&request.operations)?;
    log_info(&format!(
        "[文件归类] 开始处理: {} 个文件",
        request.operations.len()
    ));

    let mut items = Vec::with_capacity(request.operations.len());
    for operation in request.operations {
        let result = move_one(&operation, execute);
        if !result.ok {
            if let Some(error) = &result.error {
                log_error(&format!(
                    "[文件归类] 失败: {} -> {}: {}",
                    result.from, result.to, error
                ));
            }
        }
        items.push(result);
    }

    let moved = items.iter().filter(|item| item.ok).count();
    let failed = items.len().saturating_sub(moved);
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    log_info(&format!(
        "[文件归类] 完成: 成功 {}, 失败 {}, 耗时 {}ms",
        moved, failed, elapsed_ms
    ));

    Ok(OrganizeFilesResult {
        total: items.len(),
        moved,
        failed,
        elapsed_ms,
        items,
    })
}

fn validate_operations(operations: &[OrganizeOperation]) -> Result<(), String> {
    if operations.is_empty() {
        return Err("没有可执行的归类项".to_string());
    }

    let mut sources = HashSet::new();
    let mut targets = HashSet::new();

    for operation in operations {
        let from = normalize_path(&operation.from)?;
        let to = normalize_path(&operation.to)?;
        if !sources.insert(from.clone()) {
            return Err(format!("源文件重复: {}", operation.from));
        }
        if from == to {
            return Err(format!("目标路径没有变化: {}", operation.from));
        }
        if !from.exists() {
            return Err(format!("源文件不存在: {}", operation.from));
        }
        if from.is_dir() {
            return Err(format!("暂不支持归类文件夹: {}", operation.from));
        }
        if sources.contains(&to) {
            return Err(format!("目标与待归类源文件冲突: {}", operation.to));
        }
        if to.exists() {
            return Err(format!("目标已存在: {}", operation.to));
        }
        if !targets.insert(to.clone()) {
            return Err(format!("目标路径重复: {}", operation.to));
        }
    }

    Ok(())
}

fn move_one(operation: &OrganizeOperation, execute: bool) -> OrganizeResultItem {
    let from = match normalize_path(&operation.from) {
        Ok(value) => value,
        Err(error) => return failed_item(operation, error),
    };
    let to = match normalize_path(&operation.to) {
        Ok(value) => value,
        Err(error) => return failed_item(operation, error),
    };

    if execute {
        if let Some(parent) = to.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return failed_item(operation, format!("创建目标文件夹失败: {}", error));
            }
        }
        if let Err(error) = move_file(&from, &to) {
            return failed_item(operation, error);
        }
    }

    OrganizeResultItem {
        from: operation.from.clone(),
        to: operation.to.clone(),
        ok: true,
        error: None,
    }
}

fn failed_item(operation: &OrganizeOperation, error: String) -> OrganizeResultItem {
    OrganizeResultItem {
        from: operation.from.clone(),
        to: operation.to.clone(),
        ok: false,
        error: Some(error),
    }
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device_error(&error) => {
            std::fs::copy(from, to)
                .map_err(|copy_error| format!("跨磁盘复制失败: {}", copy_error))?;
            if let Err(remove_error) = std::fs::remove_file(from) {
                let _ = std::fs::remove_file(to);
                return Err(format!("跨磁盘复制后删除源文件失败: {}", remove_error));
            }
            Ok(())
        }
        Err(error) => Err(format!("移动失败: {}", error)),
    }
}

fn is_cross_device_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17) | Some(18))
}

fn normalize_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    Ok(Path::new(trimmed).to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "organize-command-test-{}-{}-{}",
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

        fn join(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn moves_files_and_creates_target_directory() {
        let dir = TestDir::new();
        let from = dir.join("source.txt");
        let to = dir.join("Documents/source.txt");
        fs::write(&from, b"hello").unwrap();

        let result = organize_files_inner(
            OrganizeFilesRequest {
                operations: vec![OrganizeOperation {
                    from: from.to_string_lossy().to_string(),
                    to: to.to_string_lossy().to_string(),
                }],
            },
            true,
        )
        .unwrap();

        assert_eq!(result.moved, 1);
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"hello");
    }

    #[test]
    fn rejects_existing_target() {
        let dir = TestDir::new();
        let from = dir.join("source.txt");
        let to = dir.join("target.txt");
        fs::write(&from, b"source").unwrap();
        fs::write(&to, b"target").unwrap();

        let error = organize_files_inner(
            OrganizeFilesRequest {
                operations: vec![OrganizeOperation {
                    from: from.to_string_lossy().to_string(),
                    to: to.to_string_lossy().to_string(),
                }],
            },
            false,
        )
        .expect_err("existing target should fail");

        assert!(error.contains("目标已存在"));
    }

    #[test]
    fn rejects_duplicate_targets() {
        let dir = TestDir::new();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        let target = dir.join("Docs/file.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let error = organize_files_inner(
            OrganizeFilesRequest {
                operations: vec![
                    OrganizeOperation {
                        from: a.to_string_lossy().to_string(),
                        to: target.to_string_lossy().to_string(),
                    },
                    OrganizeOperation {
                        from: b.to_string_lossy().to_string(),
                        to: target.to_string_lossy().to_string(),
                    },
                ],
            },
            false,
        )
        .expect_err("duplicate target should fail");

        assert!(error.contains("目标路径重复"));
    }

    #[test]
    fn rejects_duplicate_sources() {
        let dir = TestDir::new();
        let source = dir.join("source.txt");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        fs::write(&source, b"source").unwrap();

        let error = organize_files_inner(
            OrganizeFilesRequest {
                operations: vec![
                    OrganizeOperation {
                        from: source.to_string_lossy().to_string(),
                        to: a.to_string_lossy().to_string(),
                    },
                    OrganizeOperation {
                        from: source.to_string_lossy().to_string(),
                        to: b.to_string_lossy().to_string(),
                    },
                ],
            },
            false,
        )
        .expect_err("duplicate source should fail");

        assert!(error.contains("源文件重复"));
    }
}
