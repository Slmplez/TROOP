//! Only TROOP-owned references are accepted; secrets never appear in serializable DTOs.
fn valid(reference: &str) -> bool {
    reference.starts_with("TROOP/model/") && reference.len() < 200 && !reference.contains('\0')
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Security::Credentials::*;
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    pub fn write(reference: &str, secret: &str) -> Result<(), String> {
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
        bytes.fill(0);
        if ok == 0 {
            Err("Windows 凭据保存失败；请检查当前用户会话。".into())
        } else {
            Ok(())
        }
    }
    pub fn read(reference: &str) -> Result<String, String> {
        let target = wide(reference);
        let mut credential = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            return Err("找不到 API 密钥，请在模型设置中重新保存。".into());
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
