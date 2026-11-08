//! Runs in a separate process. The Job is established before any configured program starts.
use crate::{StdioConfig, LIMIT};
use std::io::{BufRead, BufReader, Read, Write};

#[cfg(windows)]
enum Process {
    Host(std::process::Child),
    Contained(mxc_sdk::v1::MxcProcess),
}
#[cfg(windows)]
impl Drop for Process {
    fn drop(&mut self) {
        match self {
            Self::Host(child) => {
                let _ = child.kill();
            }
            Self::Contained(child) => {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(windows)]
fn enter_job() -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{JobObjects::*, Threading::GetCurrentProcess},
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("Cannot create MCP process Job".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            CloseHandle(job);
            return Err("Cannot establish MCP process tree ownership".into());
        }
        // Non-inheritable handle deliberately lives until Worker process exit.
    }
    Ok(())
}

pub fn run() -> Result<(), String> {
    #[cfg(not(windows))]
    return Err("Native MCP Worker currently requires Windows".into());
    #[cfg(windows)]
    {
        enter_job()?;
        let mut input = BufReader::new(std::io::stdin());
        let mut first = String::new();
        input
            .by_ref()
            .take((LIMIT + 1) as u64)
            .read_line(&mut first)
            .map_err(|_| "Cannot read MCP startup")?;
        if first.len() > LIMIT || !first.ends_with('\n') {
            return Err("Invalid MCP startup frame".into());
        }
        let config: StdioConfig =
            serde_json::from_str(&first).map_err(|_| "Invalid MCP startup")?;
        use zeroize::Zeroize;
        first.zeroize();
        config.validate()?;
        let _program = config
            .program_sha256
            .as_deref()
            .map(|hash| crate::program::admit(&config.command, hash))
            .transpose()?;
        use std::os::windows::process::CommandExt;
        let mut environment = std::collections::BTreeMap::<String, std::ffi::OsString>::new();
        // Minimal OS execution environment; no model or application secrets inherited.
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "PATH",
            "PATHEXT",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some(v) = std::env::var_os(key) {
                environment.insert(key.into(), v);
            }
        }
        environment.extend(
            config
                .env
                .iter()
                .map(|(key, value)| (key.clone(), value.into())),
        );
        let (mut stdin, stdout, _process): (Box<dyn Write + Send>, Box<dyn Read + Send>, Process) =
            if let Some(policy) = &config.sandbox {
                let env = environment
                    .into_iter()
                    .map(|(key, value)| {
                        value
                            .into_string()
                            .map(|value| (key, value))
                            .map_err(|_| "Invalid containment environment encoding")
                    })
                    .collect::<Result<_, _>>()?;
                let mut child = crate::containment::spawn(&config, policy, env)?;
                let stdin = child.take_stdin().ok_or("Missing contained MCP stdin")?;
                let stdout = child.take_stdout().ok_or("Missing contained MCP stdout")?;
                if let Some(mut stderr) = child.take_stderr() {
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
                    });
                }
                (stdin, stdout, Process::Contained(child))
            } else {
                let mut command = std::process::Command::new(&config.command);
                command
                    .creation_flags(0x08000000)
                    .args(&config.args)
                    .current_dir(&config.cwd)
                    .env_clear()
                    .envs(environment)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null());
                let mut child = command
                    .spawn()
                    .map_err(|_| "Cannot start configured MCP command")?;
                let stdin = child.stdin.take().ok_or("Missing MCP stdin")?;
                let stdout = child.stdout.take().ok_or("Missing MCP stdout")?;
                (Box::new(stdin), Box::new(stdout), Process::Host(child))
            };
        // EOF or parent termination ends this Worker and therefore its entire Job.
        std::thread::spawn(move || {
            let copy = || -> std::io::Result<()> {
                loop {
                    let mut line = Vec::new();
                    let n = input
                        .by_ref()
                        .take((LIMIT + 1) as u64)
                        .read_until(b'\n', &mut line)?;
                    if n == 0 || n > LIMIT || line.last() != Some(&b'\n') {
                        break;
                    }
                    stdin.write_all(&line)?;
                    stdin.flush()?;
                }
                Ok(())
            };
            let mut copy = copy;
            let _ = copy();
            std::process::exit(0);
        });
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let n = reader
                .by_ref()
                .take((LIMIT + 1) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|_| "Cannot read MCP output")?;
            if n == 0 {
                break;
            }
            if n > LIMIT || line.last() != Some(&b'\n') {
                return Err("Invalid MCP output frame".into());
            }
            serde_json::from_slice::<serde_json::Value>(&line)
                .map_err(|_| "Invalid MCP JSON output")?;
            std::io::stdout()
                .write_all(&line)
                .and_then(|_| std::io::stdout().flush())
                .map_err(|_| "MCP parent disconnected")?;
        }
        Ok(())
    }
}
