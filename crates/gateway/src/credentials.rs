//! Only TROOP-owned references are accepted; secrets never appear in serializable DTOs.
fn valid(reference: &str) -> bool {
    reference.starts_with("TROOP/model/") && reference.len() < 200 && !reference.contains('\0')
}
pub mod events {
    fn valid(reference: &str) -> bool {
        let parts = reference.split('/').collect::<Vec<_>>();
        parts.len() == 5
            && parts[0] == "TROOP"
            && parts[1] == "events"
            && parts[2..].iter().all(|part| {
                matches!(part.len(), 32 | 36)
                    && part.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            })
    }
    pub fn write(reference: &str, value: &str) -> Result<(), String> {
        if !valid(reference) || value.len() > 2500 || value.contains('\0') {
            return Err("事件凭据无效。".into());
        }
        #[cfg(windows)]
        {
            super::platform::write(reference, value)
                .map_err(|error| format!("事件凭据保存失败。{error}"))
        }
        #[cfg(not(windows))]
        {
            Err("事件凭据需要 Windows 凭据库。".into())
        }
    }
    pub fn read(reference: &str) -> Result<String, String> {
        if !valid(reference) {
            return Err("事件凭据引用无效。".into());
        }
        #[cfg(windows)]
        {
            super::platform::read(reference).map_err(|_| "事件凭据不可用。".into())
        }
        #[cfg(not(windows))]
        {
            Err("事件凭据需要 Windows 凭据库。".into())
        }
    }
    pub fn delete(reference: &str) -> Result<(), String> {
        if !valid(reference) {
            return Err("事件凭据引用无效。".into());
        }
        #[cfg(windows)]
        {
            super::platform::delete(reference).map_err(|_| "事件凭据删除失败。".into())
        }
        #[cfg(not(windows))]
        {
            Err("事件凭据需要 Windows 凭据库。".into())
        }
    }
}
/// Separate namespace: MCP credentials cannot be substituted for model credentials.
pub mod mcp {
    fn valid(r: &str) -> bool {
        let p = r.split('/').collect::<Vec<_>>();
        p.len() == 4
            && p[0] == "TROOP"
            && p[1] == "mcp"
            && p[2..]
                .iter()
                .all(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
    }
    pub fn write(r: &str, value: &str) -> Result<(), String> {
        if !valid(r) || value.len() > 2500 || value.contains('\0') {
            return Err("Invalid MCP credential reference or value".into());
        }
        #[cfg(windows)]
        {
            let mut framed = format!("v1:{value}");
            let result = super::platform::write(r, &framed)
                .map_err(|error| format!("Cannot save MCP credential. {error}"));
            zeroize::Zeroize::zeroize(&mut framed);
            result
        }
        #[cfg(not(windows))]
        {
            Err("MCP credentials require Windows vault".into())
        }
    }
    pub fn read(r: &str) -> Result<String, String> {
        if !valid(r) {
            return Err("Invalid MCP credential reference".into());
        }
        #[cfg(windows)]
        {
            let mut framed = super::platform::read(r).map_err(|error| {
                format!("MCP credential unavailable; check the saved connection. {error}")
            })?;
            let result = framed
                .strip_prefix("v1:")
                .map(str::to_owned)
                .ok_or("MCP credential encoding invalid; reconnect in settings".into());
            zeroize::Zeroize::zeroize(&mut framed);
            result
        }
        #[cfg(not(windows))]
        {
            Err("MCP credentials require Windows vault".into())
        }
    }
    pub fn delete(r: &str) -> Result<(), String> {
        if !valid(r) {
            return Err("Invalid MCP credential reference".into());
        }
        #[cfg(windows)]
        {
            super::platform::delete(r).map_err(|_| "Cannot remove MCP credential".into())
        }
        #[cfg(not(windows))]
        {
            Err("MCP credentials require Windows vault".into())
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Security::Credentials::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0},
        Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::Threading::{
            CreateMutexW, GetCurrentProcess, OpenProcessToken, ReleaseMutex, WaitForSingleObject,
        },
    };

    struct VaultLock(HANDLE);
    impl VaultLock {
        fn acquire() -> Result<Self, String> {
            // Independent Core processes share a user's native vault. Concurrent native
            // mutations reproduced lost entries even with distinct credential targets.
            // Use the account SID so all TROOP data directories and sessions share a lock.
            let mut token = std::ptr::null_mut();
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
                return Err("无法核对 Windows 凭据库用户。".into());
            }
            let mut buffer = [0usize; 128];
            let mut required = 0;
            let ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    std::mem::size_of_val(&buffer) as u32,
                    &mut required,
                )
            };
            unsafe { CloseHandle(token) };
            if ok == 0 {
                return Err("无法核对 Windows 凭据库用户。".into());
            }
            let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
            let length = unsafe { GetLengthSid(sid) } as usize;
            if !(8..=68).contains(&length) {
                return Err("Windows 凭据库用户身份无效。".into());
            }
            let identity = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) }
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let name = wide(&format!("Global\\TROOP.CredentialVault.v1.{identity}"));
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                return Err("Windows 凭据同步不可用。".into());
            }
            match unsafe { WaitForSingleObject(handle, 5000) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
                _ => {
                    unsafe { CloseHandle(handle) };
                    Err("Windows 凭据库繁忙或同步失败，请稍后重试。".into())
                }
            }
        }
    }
    impl Drop for VaultLock {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    pub fn write(reference: &str, secret: &str) -> Result<(), String> {
        let _lock = VaultLock::acquire()?;
        let mut target = wide(reference);
        let mut user = wide("TROOP");
        let mut bytes = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: user.as_mut_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        // All pointers remain valid for this synchronous call; Windows copies the blob.
        let ok = unsafe { CredWriteW(&credential, 0) };
        let code = (ok == 0).then(|| std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
        bytes.fill(0);
        if let Some(code) = code {
            Err(format!("Windows 凭据保存失败，系统错误码 {code}。"))
        } else {
            Ok(())
        }
    }
    pub fn read(reference: &str) -> Result<String, String> {
        let _lock = VaultLock::acquire()?;
        let target = wide(reference);
        let mut credential = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            return Err(format!("Windows 凭据读取失败，系统错误码 {code}。"));
        }
        // CredReadW owns this allocation; copy the bounded blob, then release it with CredFree.
        let result = unsafe {
            let c = &*credential;
            if c.CredentialBlobSize == 0 || c.CredentialBlobSize > CRED_MAX_CREDENTIAL_BLOB_SIZE {
                Err("Windows 凭据内容无效，请重新保存。".into())
            } else {
                String::from_utf8(
                    std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                        .to_vec(),
                )
                .map_err(|_| "Windows 凭据编码无效。".into())
            }
        };
        unsafe {
            CredFree(credential.cast());
        }
        result
    }
    pub fn delete(reference: &str) -> Result<(), String> {
        let _lock = VaultLock::acquire()?;
        let target = wide(reference);
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1168) {
                return Err("Windows 凭据清理失败。".into());
            }
        }
        Ok(())
    }
}

pub fn write(reference: &str, secret: &str) -> Result<(), String> {
    if !valid(reference)
        || secret.is_empty()
        || secret.len() > 2500
        || secret.chars().any(char::is_control)
    {
        return Err("API 密钥或凭据引用无效。".into());
    }
    #[cfg(windows)]
    {
        platform::write(reference, secret)
    }
    #[cfg(not(windows))]
    {
        Err("当前构建只支持 Windows 系统凭据存储。".into())
    }
}
pub fn read(reference: &str) -> Result<String, String> {
    if !valid(reference) {
        return Err("凭据引用无效。".into());
    }
    #[cfg(windows)]
    {
        platform::read(reference)
    }
    #[cfg(not(windows))]
    {
        Err("当前构建只支持 Windows 系统凭据存储。".into())
    }
}
pub fn delete(reference: &str) -> Result<(), String> {
    if !valid(reference) {
        return Err("凭据引用无效。".into());
    }
    #[cfg(windows)]
    {
        platform::delete(reference)
    }
    #[cfg(not(windows))]
    {
        Err("当前构建只支持 Windows 系统凭据存储。".into())
    }
}
