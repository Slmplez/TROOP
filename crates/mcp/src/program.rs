//! Executable identity admission. Callers establish authorization before using this boundary.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
};

pub fn execution_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(path).into()
    }
}

#[cfg(windows)]
pub fn check_write_aliases(roots: &[String]) -> Result<(), String> {
    use std::{
        collections::BTreeSet,
        fs,
        os::windows::{fs::MetadataExt, io::AsRawHandle},
        path::PathBuf,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut pending = roots.iter().map(PathBuf::from).collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    while let Some(path) = pending.pop() {
        if !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > 20_000 {
            return Err("Shell 写入树超过文件身份检查上限，请缩小授权写入目录。".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| "无法核验原生写入树。")?;
        if metadata.file_attributes() & 0x400 != 0 {
            continue;
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|_| "无法枚举原生写入树。")? {
                if pending.len() + visited.len() >= 20_000 {
                    return Err("Shell 写入树超过文件身份检查上限，请缩小授权写入目录。".into());
                }
                pending.push(entry.map_err(|_| "无法核验原生写入树。")?.path());
            }
        } else if metadata.is_file() {
            let file = fs::File::open(&path).map_err(|_| "无法核验原生文件身份。")?;
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
                return Err("无法核验原生文件链接数量。".into());
            }
            if info.nNumberOfLinks != 1 {
                return Err("原生写入范围包含硬链接文件，无法确认全部别名范围，请移除硬链接或缩小授权目录。".into());
            }
        } else {
            return Err("原生写入树包含未支持的文件类型。".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn check_write_aliases(_roots: &[String]) -> Result<(), String> {
    Err("Native file identity checks require Windows".into())
}

fn digest(file: &mut File) -> Result<String, String> {
    const LIMIT: u64 = 512 * 1024 * 1024;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect native program")?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err("Native program exceeds admission limits".into());
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot read native program")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > LIMIT {
            return Err("Native program exceeds admission limits".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn fingerprint(path: &Path) -> Result<String, String> {
    digest(&mut File::open(path).map_err(|_| "Cannot read native program")?)
}
pub fn admit(path: &Path, expected: &str) -> Result<File, String> {
    if !path.is_absolute()
        || path.canonicalize().ok().as_deref() != Some(path)
        || expected.len() != 64
        || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Native program identity is invalid".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot pin native program")?;
    if digest(&mut file)? != expected {
        return Err("Native program changed since authorization".into());
    }
    Ok(file)
}
