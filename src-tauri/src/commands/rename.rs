use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::file_ops::{
    move_file_no_replace, path_collision_key, path_entry_exists, paths_refer_to_same_file,
    validate_input_file,
};
use super::logger::{log_error, log_info};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOperation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameRequest {
    pub operations: Vec<RenameOperation>,
}

#[derive(Debug, Serialize)]
pub struct RenameResultItem {
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchRenameResult {
    pub total: usize,
    pub renamed: usize,
    pub failed: usize,
    pub elapsed_ms: u64,
    pub items: Vec<RenameResultItem>,
}

#[tauri::command]
pub async fn batch_rename(request: BatchRenameRequest) -> Result<BatchRenameResult, String> {
    tokio::task::spawn_blocking(move || batch_rename_inner(request, true))
        .await
        .map_err(|error| format!("重命名任务执行失败: {}", error))?
}

fn batch_rename_inner(
    request: BatchRenameRequest,
    execute: bool,
) -> Result<BatchRenameResult, String> {
    let started = Instant::now();
    validate_operations(&request.operations)?;
    log_info(&format!(
        "[重命名] 开始处理: {} 个文件",
        request.operations.len()
    ));

    let mut items = Vec::with_capacity(request.operations.len());
    for (index, operation) in request.operations.into_iter().enumerate() {
        let result = rename_one(&operation, execute);
        if !result.ok {
            log_error(&format!("[重命名] 第 {} 项失败", index + 1));
        }
        items.push(result);
    }

    let renamed = items.iter().filter(|item| item.ok).count();
    let failed = items.len().saturating_sub(renamed);
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    log_info(&format!(
        "[重命名] 完成: 成功 {}, 失败 {}, 耗时 {}ms",
        renamed, failed, elapsed_ms
    ));

    Ok(BatchRenameResult {
        total: items.len(),
        renamed,
        failed,
        elapsed_ms,
        items,
    })
}

fn validate_operations(operations: &[RenameOperation]) -> Result<(), String> {
    if operations.is_empty() {
        return Err("没有可执行的重命名项".to_string());
    }

    let source_paths: Vec<PathBuf> = operations
        .iter()
        .map(|operation| normalize_path(&operation.from))
        .collect::<Result<_, _>>()?;
    let source_keys: Vec<String> = source_paths
        .iter()
        .map(|path| path_collision_key(path))
        .collect();
    let sources: HashSet<&str> = source_keys.iter().map(String::as_str).collect();
    if sources.len() != operations.len() {
        return Err("源文件重复或仅大小写不同".into());
    }
    let mut targets = HashSet::new();
    for ((operation, from), from_key) in operations
        .iter()
        .zip(source_paths.iter())
        .zip(source_keys.iter())
    {
        let to = normalize_path(&operation.to)?;
        let to_key = path_collision_key(&to);
        if from.as_path() == to {
            return Err(format!("目标文件名没有变化: {}", operation.from));
        }
        validate_input_file(from).map_err(|error| format!("源文件不可用: {}", error))?;
        let case_only_target =
            from_key == &to_key && (!path_entry_exists(&to) || paths_refer_to_same_file(from, &to));
        if sources.contains(to_key.as_str()) && !case_only_target {
            return Err(format!("目标与待重命名源文件冲突: {}", operation.to));
        }
        if path_entry_exists(&to) && !paths_refer_to_same_file(from, &to) {
            return Err(format!("目标已存在: {}", operation.to));
        }
        if !targets.insert(to_key) {
            return Err(format!("目标文件名重复: {}", operation.to));
        }
    }

    Ok(())
}

fn rename_one(operation: &RenameOperation, execute: bool) -> RenameResultItem {
    let from = match normalize_path(&operation.from) {
        Ok(value) => value,
        Err(error) => return failed_item(operation, error),
    };
    let to = match normalize_path(&operation.to) {
        Ok(value) => value,
        Err(error) => return failed_item(operation, error),
    };

    if execute {
        if let Err(error) = validate_input_file(&from) {
            return failed_item(operation, error);
        }
        if let Err(error) = move_file_no_replace(&from, &to) {
            return failed_item(operation, error);
        }
    }

    RenameResultItem {
        from: operation.from.clone(),
        to: operation.to.clone(),
        ok: true,
        error: None,
    }
}

fn failed_item(operation: &RenameOperation, error: String) -> RenameResultItem {
    RenameResultItem {
        from: operation.from.clone(),
        to: operation.to.clone(),
        ok: false,
        error: Some(error),
    }
}

fn normalize_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("文件操作只接受本机绝对路径".to_string());
    }
    Ok(path.to_path_buf())
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
                "rename-command-test-{}-{}-{}",
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
    fn renames_files_without_overwriting() {
        let dir = TestDir::new();
        let from = dir.join("old.txt");
        let to = dir.join("new.txt");
        fs::write(&from, b"hello").unwrap();

        let result = batch_rename_inner(
            BatchRenameRequest {
                operations: vec![RenameOperation {
                    from: from.to_string_lossy().to_string(),
                    to: to.to_string_lossy().to_string(),
                }],
            },
            true,
        )
        .unwrap();

        assert_eq!(result.renamed, 1);
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"hello");
    }

    #[test]
    fn rejects_duplicate_targets() {
        let dir = TestDir::new();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        let target = dir.join("target.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let error = batch_rename_inner(
            BatchRenameRequest {
                operations: vec![
                    RenameOperation {
                        from: a.to_string_lossy().to_string(),
                        to: target.to_string_lossy().to_string(),
                    },
                    RenameOperation {
                        from: b.to_string_lossy().to_string(),
                        to: target.to_string_lossy().to_string(),
                    },
                ],
            },
            false,
        )
        .expect_err("duplicate target should fail");

        assert!(error.contains("目标文件名重复"));
    }

    #[test]
    fn rejects_existing_target() {
        let dir = TestDir::new();
        let from = dir.join("a.txt");
        let target = dir.join("target.txt");
        fs::write(&from, b"a").unwrap();
        fs::write(&target, b"target").unwrap();

        let error = batch_rename_inner(
            BatchRenameRequest {
                operations: vec![RenameOperation {
                    from: from.to_string_lossy().to_string(),
                    to: target.to_string_lossy().to_string(),
                }],
            },
            false,
        )
        .expect_err("existing target should fail");

        assert!(error.contains("目标已存在"));
    }

    #[test]
    fn rejects_target_that_is_another_source() {
        let dir = TestDir::new();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        let c = dir.join("c.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let error = batch_rename_inner(
            BatchRenameRequest {
                operations: vec![
                    RenameOperation {
                        from: a.to_string_lossy().to_string(),
                        to: b.to_string_lossy().to_string(),
                    },
                    RenameOperation {
                        from: b.to_string_lossy().to_string(),
                        to: c.to_string_lossy().to_string(),
                    },
                ],
            },
            false,
        )
        .expect_err("target that is another source should fail");

        assert!(error.contains("目标与待重命名源文件冲突"));
    }
}
