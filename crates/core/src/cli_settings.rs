//! Fingerprinted, bounded source configuration. Credentials never enter a binding.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs::OpenOptions, io::Read, path::Path};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Binding {
    pub file: String,
    #[serde(default)]
    pub sha256: String,
}
impl Binding {
    fn contents(&self) -> Result<(Value, String), String> {
        let path = Path::new(&self.file);
        if !path.is_absolute()
            || !path.is_file()
            || path.canonicalize().ok().as_deref() != Some(path)
            || crate::tools::reparse(path)?
        {
            return Err("模型配置文件身份无效。".into());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut bytes = Vec::new();
        options
            .open(path)
            .map_err(|_| "无法读取模型配置文件。")?
            .take(64_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取模型配置文件。")?;
        if bytes.len() > 64_000 {
            return Err("模型配置超过 64KB。".into());
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "模型配置需要有效 JSON。")?;
        Ok((value, crate::tools::hash(&bytes)))
    }
    pub(crate) fn freeze(&mut self) -> Result<(), String> {
        self.file = Path::new(&self.file)
            .canonicalize()
            .map_err(|_| "模型配置不存在。")?
            .to_str()
            .ok_or("配置文件编码无效。")?
            .into();
        self.sha256 = self.contents()?.1;
        Ok(())
    }
    pub(crate) fn read(&self) -> Result<Value, String> {
        let (value, sha256) = self.contents()?;
        if self.sha256 != sha256 {
            return Err("模型配置已变化，请重新保存启动授权。".into());
        }
        Ok(value)
    }
}
