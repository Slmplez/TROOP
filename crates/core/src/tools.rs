//! Local tools run in a separate, owned process. This is a host capability, not an OS sandbox.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub fn definitions() -> Vec<Value> {
    let specs = [
        ("list_directory", "List a workspace directory (maximum 100 entries).", json!({"path":{"type":"string"}}), vec!["path"]),
        ("read_file", "Read a UTF-8 workspace file up to 8KB and its SHA-256 for subsequent writes.", json!({"path":{"type":"string"}}), vec!["path"]),
        ("search_text", "Search literal text in workspace UTF-8 files; bounded, excludes .git and reparse points.", json!({"path":{"type":"string"},"text":{"type":"string"}}), vec!["path","text"]),
        ("write_file", "Create/update a UTF-8 workspace file up to 8KB. expected_hash must be the previous SHA-256, or 'missing' for a new file. Requires user approval.", json!({"path":{"type":"string"},"content":{"type":"string"},"expected_hash":{"type":"string"}}), vec!["path","content","expected_hash"]),
        ("run_command", "Execute a Windows PowerShell command in the workspace, up to 60 seconds. Host access is not sandboxed. Requires approval of this exact command.", json!({"command":{"type":"string"}}), vec!["command"]),
        ("git_status", "Run Git status using the workspace's configuration. Repository filters may run host programs. Requires approval of this operation.", json!({}), vec![]),
    ];
    specs.into_iter().map(|(name,description,properties,required)|json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub fn needs_approval(name: &str) -> bool {
    matches!(name, "write_file" | "run_command" | "git_status")
}
const GIT_STATUS_ARGS: &[&str] = &[
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignore-submodules=all",
];
pub fn git_preview() -> Value {
    json!({"program":"Git（工作区外的 PATH 程序）","arguments":GIT_STATUS_ARGS})
}
pub fn validate(name: &str, args: &Value) -> Result<(), String> {
    let spec = definitions()
        .into_iter()
        .find(|v| v["name"] == name)
        .ok_or("未知工具。")?;
    let object = args.as_object().ok_or("工具参数必须是对象。")?;
    let properties = spec["parameters"]["properties"].as_object().unwrap();
    if object.len() != properties.len()
        || object
            .iter()
            .any(|(k, v)| !properties.contains_key(k) || !v.is_string())
        || args.to_string().len() > 12_000
    {
        return Err("工具参数不完整或超过限制。".into());
    }
    if name == "run_command"
        && (args["command"].as_str().unwrap().trim().is_empty()
            || args["command"].as_str().unwrap().len() > 4000)
    {
        return Err("命令应为 1–4000 字节。".into());
    }
    Ok(())
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取路径信息。")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(metadata.file_type().is_symlink())
    }
}
fn target(root: &Path, input: &str, new: bool) -> Result<PathBuf, String> {
    if input.len() > 2000 || input.contains(':') || input.contains('\0') {
        return Err("工作区路径无效。".into());
    }
    let relative = Path::new(input);
    if relative.is_absolute() {
        return Err("工具只接受工作区内相对路径。".into());
    }
    let mut path = root.to_path_buf();
    let parts: Vec<_> = relative.components().collect();
    for (index, part) in parts.iter().enumerate() {
        match part {
            Component::CurDir => continue,
            Component::Normal(segment) => {
                let s = segment.to_string_lossy();
                let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
                if s.eq_ignore_ascii_case(".git")
                    || s.ends_with(['.', ' '])
                    || s.contains(['*', '?'])
                    || matches!(
                        stem.as_str(),
                        "CON"
                            | "PRN"
                            | "AUX"
                            | "NUL"
                            | "COM1"
                            | "COM2"
                            | "COM3"
                            | "COM4"
                            | "COM5"
                            | "COM6"
                            | "COM7"
                            | "COM8"
                            | "COM9"
                            | "LPT1"
                            | "LPT2"
                            | "LPT3"
                            | "LPT4"
                            | "LPT5"
                            | "LPT6"
                            | "LPT7"
                            | "LPT8"
                            | "LPT9"
                    )
                {
                    return Err("此路径不允许直接访问。".into());
                }
                path.push(segment);
            }
            _ => return Err("路径不能离开所选工作区。".into()),
        }
        if path.exists() || fs::symlink_metadata(&path).is_ok() {
            if reparse(&path)? {
                return Err("拒绝符号链接或 Windows 重解析路径。".into());
            }
        } else if !(new && index + 1 == parts.len()) {
            return Err("路径不存在。".into());
        }
    }
    if !path.starts_with(root) {
        return Err("路径离开工作区。".into());
    }
    Ok(path)
}
fn bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "无法打开文件。")?
        .take(8001)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取文件。")?;
    if bytes.len() > 8000 {
        return Err("文件超过 8KB，本工具未读取其内容。".into());
    }
    Ok(bytes)
}
struct Capture {
    data: Arc<Mutex<(Vec<u8>, bool)>>,
    done: Arc<AtomicBool>,
}
fn collect(reader: impl Read + Send + 'static) -> Capture {
    let state = Arc::new(Mutex::new((Vec::new(), false)));
    let copy = state.clone();
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut b = [0u8; 1024];
        while let Ok(n) = reader.read(&mut b) {
            if n == 0 {
                break;
            }
            let mut data = copy.lock().unwrap();
            let keep = (3000 - data.0.len()).min(n);
            data.0.extend_from_slice(&b[..keep]);
            data.1 |= keep < n;
        }
        finished.store(true, Ordering::SeqCst);
    });
    Capture { data: state, done }
}
fn command(mut command: Command) -> Result<Value, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动命令，请检查程序是否已安装。")?;
    let stdout = collect(child.stdout.take().unwrap());
    let stderr = collect(child.stderr.take().unwrap());
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "无法核对命令状态。")? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(
                json!({"effect_unknown":true,"error":"命令达到 60 秒上限；请核对已发生的效果。"}),
            );
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let drain = Instant::now();
    while (!stdout.done.load(Ordering::SeqCst) || !stderr.done.load(Ordering::SeqCst))
        && drain.elapsed() < Duration::from_millis(200)
    {
        std::thread::sleep(Duration::from_millis(2));
    }
    let out = stdout.data.lock().unwrap();
    let err = stderr.data.lock().unwrap();
    Ok(
        json!({"exit_code":status.code(),"stdout":String::from_utf8_lossy(&out.0),"stderr":String::from_utf8_lossy(&err.0),"truncated":out.1||err.1||!stdout.done.load(Ordering::SeqCst)||!stderr.done.load(Ordering::SeqCst)}),
    )
}
fn trusted_git(root: &Path) -> Result<PathBuf, String> {
    let root_key = format!(
        "{}{}",
        root.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase(),
        std::path::MAIN_SEPARATOR
    );
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !directory.is_absolute() {
            continue;
        }
        if let Ok(executable) = fs::canonicalize(directory.join("git.exe")) {
            if executable.is_file()
                && !executable
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&root_key)
            {
                return Ok(executable);
            }
        }
    }
    Err("没有工作区外的可信 PATH Git 程序，请安装 Git 或使用经批准的命令。".into())
}
fn perform(workspace: &str, name: &str, args: &Value) -> Result<Value, String> {
    validate(name, args)?;
    let root = fs::canonicalize(workspace).map_err(|_| "工作区不再可用。")?;
    if !root.is_dir() {
        return Err("工作区不是目录。".into());
    }
    let path = || {
        target(
            &root,
            args["path"].as_str().unwrap_or("."),
            name == "write_file",
        )
    };
    match name {
        "list_directory" => {
            let mut entries = Vec::new();
            let mut bytes = 0;
            let mut truncated = false;
            for entry in fs::read_dir(path()?).map_err(|_| "无法列目录。")?.take(101) {
                let entry = entry.map_err(|_| "无法读取目录项。")?;
                let item = json!({"name":entry.file_name().to_string_lossy(),"directory":entry.file_type().map_err(|_| "无法读取目录类型。")?.is_dir()});
                bytes += item.to_string().len();
                if bytes > 6000 || entries.len() >= 100 {
                    truncated = true;
                    break;
                }
                entries.push(item);
            }
            Ok(json!({"entries":entries,"truncated":truncated}))
        }
        "read_file" => {
            let bytes = bounded_file(&path()?)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| "文件不是 UTF-8 文本。")?;
            Ok(json!({"content":text,"sha256":hash(&bytes)}))
        }
        "write_file" => {
            let path = path()?;
            let content = args["content"].as_str().unwrap();
            let expected = args["expected_hash"].as_str().unwrap();
            if content.len() > 8000 {
                return Err("写入内容超过 8KB。".into());
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1);
            }
            if expected == "missing" {
                options.create_new(true);
            }
            let mut file = options
                .open(path)
                .map_err(|_| "文件版本冲突、被占用或无法写入；未覆盖。")?;
            if expected != "missing" {
                let mut old = Vec::new();
                (&mut file)
                    .take(8001)
                    .read_to_end(&mut old)
                    .map_err(|_| "无法核对旧文件。")?;
                if old.len() > 8000 || hash(&old) != expected {
                    return Err("文件版本冲突；请重新读取后再计划写入。".into());
                }
            }
            if file
                .seek(SeekFrom::Start(0))
                .and_then(|_| file.set_len(0))
                .and_then(|_| file.write_all(content.as_bytes()))
                .and_then(|_| file.sync_all())
                .is_err()
            {
                return Ok(json!({"effect_unknown":true,"error":"写入结果不明，需要核对文件。"}));
            }
            Ok(json!({"bytes":content.len(),"sha256":hash(content.as_bytes())}))
        }
        "search_text" => {
            let needle = args["text"].as_str().unwrap();
            if needle.is_empty() || needle.len() > 500 {
                return Err("搜索文字应为 1–500 字节。".into());
            }
            let mut stack = vec![path()?];
            let mut results = Vec::new();
            let mut scanned = 0;
            let mut bytes = 0;
            let mut truncated = false;
            while let Some(p) = stack.pop() {
                scanned += 1;
                if scanned > 1000 {
                    truncated = true;
                    break;
                }
                if reparse(&p)?
                    || p.file_name()
                        .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
                {
                    continue;
                }
                if p.is_dir() {
                    for entry in fs::read_dir(p)
                        .map_err(|_| "搜索目录不可读。")?
                        .take(1000)
                        .flatten()
                    {
                        if stack.len() >= 1000 {
                            truncated = true;
                            break;
                        }
                        stack.push(entry.path());
                    }
                } else if let Ok(data) = bounded_file(&p) {
                    if let Ok(text) = std::str::from_utf8(&data) {
                        for (line, text) in text.lines().enumerate() {
                            if text.contains(needle) {
                                let result = json!({"path":p.strip_prefix(&root).unwrap_or(&p).to_string_lossy(),"line":line+1,"text":text.chars().take(160).collect::<String>()});
                                bytes += result.to_string().len();
                                if bytes > 6000 || results.len() >= 30 {
                                    truncated = true;
                                    break;
                                }
                                results.push(result);
                            }
                        }
                    }
                }
                if truncated {
                    break;
                }
            }
            Ok(json!({"matches":results,"truncated":truncated}))
        }
        "run_command" => {
            let system = std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?;
            let mut c = Command::new(
                Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            );
            let script=format!("$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n{}",args["command"].as_str().unwrap());
            c.current_dir(root).args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ]);
            command(c)
        }
        "git_status" => {
            let executable = trusted_git(&root)?;
            let mut c = Command::new(executable);
            c.current_dir(root)
                .env("GIT_OPTIONAL_LOCKS", "0")
                .args(GIT_STATUS_ARGS);
            command(c)
        }
        _ => Err("未知工具。".into()),
    }
}
#[derive(Serialize, Deserialize)]
pub struct Work {
    pub id: i64,
    pub epoch: i64,
    pub workspace: String,
    pub name: String,
    pub arguments: Value,
    pub receipt: PathBuf,
    pub job_handle: isize,
}
fn receipt(work: &Work, status: &str, result: Option<&Value>) -> Result<(), String> {
    let mut file = File::create(&work.receipt).map_err(|_| "无法保存 Worker 账本。")?;
    file.write_all(
        json!({"id":work.id,"epoch":work.epoch,"status":status,"result":result})
            .to_string()
            .as_bytes(),
    )
    .and_then(|_| file.sync_all())
    .map_err(|_| "无法提交 Worker 账本。".into())
}
#[cfg(windows)]
fn create_job() -> Result<isize, String> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("无法创建 Windows 作业。".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err("无法建立进程树停止边界；未执行。".into());
        }
        Ok(job as isize)
    }
}
struct Job {
    handle: isize,
}
impl Job {
    fn new() -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self {
                handle: create_job()?,
            })
        }
        #[cfg(not(windows))]
        {
            Err("本机工具只支持 Windows。".into())
        }
    }
    fn duplicate(&self, child: &std::process::Child) -> Result<isize, String> {
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::*, System::Threading::GetCurrentProcess};
            let mut target = std::ptr::null_mut();
            if DuplicateHandle(
                GetCurrentProcess(),
                self.handle as HANDLE,
                child.as_raw_handle(),
                &mut target,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) == 0
            {
                return Err("无法传递受管作业句柄，未执行工具。".into());
            }
            Ok(target as isize)
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Err("本机工具只支持 Windows。".into())
        }
    }
    fn terminate(&self) {
        #[cfg(windows)]
        unsafe {
            let _ =
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 125);
        }
    }
    fn empty(&self) -> bool {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let start = Instant::now();
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.handle as _,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return false;
                }
                if info.ActiveProcesses == 0 {
                    return true;
                }
                if start.elapsed() > Duration::from_secs(2) {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.terminate();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}
pub fn worker() -> Result<(), String> {
    let mut reader = BufReader::new(std::io::stdin());
    let mut line = String::new();
    reader
        .by_ref()
        .take(32_000)
        .read_line(&mut line)
        .map_err(|_| "无法读取工具请求。")?;
    let work: Work = serde_json::from_str(&line).map_err(|_| "工具请求无效。")?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::{
            JobObjects::AssignProcessToJobObject, Threading::GetCurrentProcess,
        };
        if work.job_handle == 0
            || unsafe { AssignProcessToJobObject(work.job_handle as _, GetCurrentProcess()) } == 0
        {
            return Err("Worker 无法加入指定受管作业，未执行。".into());
        }
    }
    #[cfg(not(windows))]
    return Err("此 Worker 只支持 Windows。".into());
    if work.receipt.exists() {
        return Err("Worker 已有该调用记录，不会重复执行。".into());
    }
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&work.receipt)
        .map_err(|_| "无法接受工具调用。")?;
    receipt(&work, "accepted", None)?;
    println!("{}", json!({"ready":true}));
    std::io::stdout().flush().map_err(|_| "回执失败。")?;
    line.clear();
    reader.read_line(&mut line).map_err(|_| "授权通道断开。")?;
    if line.trim() != "go" {
        return Err("未获得派发确认。".into());
    }
    receipt(&work, "running", None)?;
    std::thread::spawn(move || {
        let mut next = String::new();
        let _ = reader.read_line(&mut next);
        std::process::exit(125);
    });
    let result = match perform(&work.workspace, &work.name, &work.arguments) {
        Ok(value) if value["effect_unknown"] == true => {
            json!({"ok":false,"indeterminate":true,"value":value})
        }
        Ok(value) => json!({"ok":true,"value":value}),
        Err(message) => json!({"ok":false,"error":message}),
    };
    receipt(&work, "finished", Some(&result))?;
    println!("{result}");
    std::io::stdout().flush().map_err(|_| "结果回传失败。")?;
    Ok(())
}
pub fn execute(
    mut work: Work,
    cancel: Arc<AtomicBool>,
    ready: impl FnOnce(mpsc::Sender<bool>) + Send,
) -> Value {
    let mut child_slot = None;
    let mut job_slot = None;
    let mut accepted = false;
    let result = (|| -> Result<Value, String> {
        let job = Job::new()?;
        job_slot = Some(job);
        let mut command = Command::new(std::env::current_exe().map_err(|_| "无法定位 Worker。")?);
        command
            .arg("--tool-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = child_slot.insert(command.spawn().map_err(|_| "无法启动 Worker。")?);
        work.job_handle = job_slot.as_ref().unwrap().duplicate(child)?;
        let mut input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (lines, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            for _ in 0..2 {
                let mut line = String::new();
                let n = output.by_ref().take(65_536).read_line(&mut line);
                if !matches!(n,Ok(n) if n>0) {
                    break;
                }
                if lines
                    .send(serde_json::from_str::<Value>(&line).unwrap_or(Value::Null))
                    .is_err()
                {
                    break;
                }
            }
        });
        let payload = serde_json::to_string(&work).map_err(|_| "工具快照无效。")?;
        if writeln!(input, "{payload}")
            .and_then(|_| input.flush())
            .is_err()
        {
            return Err("Worker 未接收请求。".into());
        }
        let start = Instant::now();
        let mut permit = Some(ready);
        let mut gate: Option<mpsc::Receiver<bool>> = None;
        loop {
            if cancel.load(Ordering::SeqCst) || start.elapsed() > Duration::from_secs(70) {
                return Err("执行已停止或超时；已发生效果需要核对。".into());
            }
            if let Some(ref gate_rx) = gate {
                if let Ok(approved) = mpsc::Receiver::try_recv(gate_rx) {
                    if !approved {
                        return Err("派发确认被撤销。".into());
                    }
                    writeln!(input, "go")
                        .and_then(|_| input.flush())
                        .map_err(|_| "Worker 派发结果不明。")?;
                    gate = None;
                }
            }
            match rx.recv_timeout(Duration::from_millis(15)) {
                Ok(v) if v["ready"] == true => {
                    accepted = true;
                    let (tx, rx) = mpsc::channel();
                    gate = Some(rx);
                    if let Some(ready) = permit.take() {
                        ready(tx);
                    }
                }
                Ok(v) if v["ok"].is_boolean() => {
                    return Ok(v);
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Worker 退出，结果需要核对。".into());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    })();
    if let Some(job) = &job_slot {
        job.terminate();
    }
    if let Some(mut child) = child_slot.take() {
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
    }
    let stopped = job_slot.as_ref().is_none_or(Job::empty);
    let mut result =
        result.unwrap_or_else(|error| json!({"ok":false,"indeterminate":true,"error":error}));
    result["stopped"] = json!(stopped);
    if !stopped {
        result["ok"] = json!(false);
        result["indeterminate"] = json!(true);
        result["stop_unconfirmed"] = json!(true);
    }
    // Persist the Core's job-empty observation before the business result is committed.
    if accepted && receipt(&work, "finished", Some(&result)).is_err() {
        result["ok"] = json!(false);
        result["indeterminate"] = json!(true);
        result["error"] = json!("执行确认回执无法落盘，请核对已发生的效果。");
    }
    result
}
