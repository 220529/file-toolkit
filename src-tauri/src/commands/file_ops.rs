use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

pub fn path_collision_key(path: &Path) -> String {
    let normalized = normalize_existing_parent(path);
    let value = normalized.to_string_lossy().replace('\\', "/");

    if cfg!(any(target_os = "macos", target_os = "windows")) {
        value.to_lowercase()
    } else {
        value
    }
}

pub fn paths_refer_to_same_file(first: &Path, second: &Path) -> bool {
    same_file::is_same_file(first, second).unwrap_or(false)
}

pub fn path_entry_exists(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

pub fn validate_input_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("请选择本机绝对路径文件".into());
    }

    let link_metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法访问输入文件: {}", error))?;
    if link_metadata.file_type().is_symlink() {
        return Err("为避免链接目标被误操作，请选择原始文件而不是符号链接".into());
    }

    let metadata = fs::metadata(path).map_err(|error| format!("无法访问输入文件: {}", error))?;
    if !metadata.is_file() {
        return Err("输入路径不是普通文件".into());
    }

    Ok(())
}

pub fn validate_output_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("输出路径必须是本机绝对路径".into());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "输出路径缺少父目录".to_string())?;
    if !parent.is_dir() {
        return Err("输出目录不存在或不可访问".into());
    }

    Ok(())
}

pub fn unique_output_path(requested: &Path, protected_paths: &[&Path]) -> Result<PathBuf, String> {
    validate_output_path(requested)?;
    let parent = requested
        .parent()
        .ok_or_else(|| "输出路径缺少父目录".to_string())?;
    let stem = requested
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "output".into());
    let extension = requested
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty());

    for index in 0..10_000_u32 {
        let name = if index == 0 {
            requested
                .file_name()
                .map(|value| value.to_os_string())
                .ok_or_else(|| "输出路径缺少文件名".to_string())?
        } else if let Some(extension) = &extension {
            format!("{}-{}.{}", stem, index + 1, extension).into()
        } else {
            format!("{}-{}", stem, index + 1).into()
        };
        let candidate = parent.join(name);
        let protected = protected_paths.iter().any(|path| {
            path_collision_key(path) == path_collision_key(&candidate)
                || (path_entry_exists(&candidate) && paths_refer_to_same_file(path, &candidate))
        });
        if !protected && !path_entry_exists(&candidate) {
            return Ok(candidate);
        }
    }

    Err("无法生成不冲突的输出文件名".into())
}

pub struct TemporaryOutput {
    path: PathBuf,
    directory: PathBuf,
    active: bool,
}

impl TemporaryOutput {
    pub fn new(final_path: &Path) -> Result<Self, String> {
        validate_output_path(final_path)?;
        let parent = final_path
            .parent()
            .ok_or_else(|| "输出路径缺少父目录".to_string())?;
        let stem = final_path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "output".into());
        let file_name = final_path
            .file_name()
            .ok_or_else(|| "输出路径缺少文件名".to_string())?;

        for _ in 0..100 {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let directory = parent.join(format!(
                ".{}.file-toolkit-{}-{}-{}",
                stem,
                std::process::id(),
                nonce,
                id
            ));
            match create_private_directory(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        path: directory.join(file_name),
                        directory,
                        active: true,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法创建临时输出目录: {}", error)),
            }
        }

        Err("无法创建临时输出路径".into())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit(mut self, final_path: &Path) -> Result<(), String> {
        move_file_no_replace(&self.path, final_path)?;
        self.active = false;
        let _ = fs::remove_dir(&self.directory);
        Ok(())
    }

    fn preserve(mut self) -> PathBuf {
        self.active = false;
        self.path.clone()
    }
}

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

pub fn move_file_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    validate_input_file(from)?;
    validate_output_path(to)?;

    if from == to {
        return Err("源路径和目标路径相同".into());
    }

    if path_entry_exists(to) {
        if path_collision_key(from) == path_collision_key(to) && paths_refer_to_same_file(from, to)
        {
            return rename_same_file_case_only(from, to);
        }
        return Err("目标文件已存在，未执行覆盖".into());
    }

    move_regular_file_no_replace(from, to)
}

fn move_regular_file_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    if path_entry_exists(to) {
        return Err("目标文件已存在，未执行覆盖".into());
    }

    match rename_no_replace(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err("目标文件已存在，未执行覆盖".into())
        }
        Err(error) if is_cross_device_error(&error) => {
            Err("源文件与目标目录不在同一磁盘；为避免丢失扩展属性，未执行复制后删源".into())
        }
        Err(error) => Err(format!("移动文件失败，源文件已保留: {}", error)),
    }
}

fn rename_same_file_case_only(from: &Path, to: &Path) -> Result<(), String> {
    let temporary = TemporaryOutput::new(to)?;
    let temporary_path = temporary.path().to_path_buf();
    move_regular_file_no_replace(from, &temporary_path)
        .map_err(|error| format!("创建大小写改名临时文件失败: {}", error))?;

    match move_regular_file_no_replace(&temporary_path, to) {
        Ok(()) => Ok(()),
        Err(error) => {
            let restore_result = move_regular_file_no_replace(&temporary_path, from);
            match restore_result {
                Ok(()) => Err(format!("大小写改名失败，已恢复原文件: {}", error)),
                Err(restore_error) => {
                    let preserved_path = temporary.preserve();
                    Err(format!(
                        "大小写改名失败，临时文件保留在 {}，恢复失败: {}",
                        preserved_path.display(),
                        restore_error
                    ))
                }
            }
        }
    }
}

fn normalize_existing_parent(path: &Path) -> PathBuf {
    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };
    let Some(file_name) = path.file_name() else {
        return path.to_path_buf();
    };

    parent
        .canonicalize()
        .map(|value| value.join(file_name))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "源路径包含空字符"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "目标路径包含空字符"))?;
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "源路径包含空字符"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "目标路径包含空字符"))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "当前平台不支持无覆盖移动",
    ))
}

fn is_cross_device_error(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = error;
        false
    }
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
