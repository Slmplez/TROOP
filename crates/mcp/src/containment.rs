//! Fixed native execution policy. Callers own authorization and the parent Job.
#[cfg(windows)]
pub use mxc_sdk::v1::MxcProcess;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// Change this identity when the policy compiler or SDK changes.
pub const ADAPTER: &str = "mxc-stdio-v1-sdk-1.0.1";
const SOURCE_SHA256: &str = "7c9e2d05b3953fdb34c44e4de8d8f2b447f4444534cb95294b72fb297a468f61";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub adapter: String,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub network: String,
}

fn canonical_roots(roots: &[String]) -> Result<(), String> {
    if roots.len() > 8 {
        return Err("Too many containment roots".into());
    }
    for root in roots {
        let path = Path::new(root);
        if root.len() > 4000
            || !path.is_absolute()
            || !path.is_dir()
            || path.canonicalize().ok().as_deref() != Some(path)
        {
            return Err("Containment directory target changed".into());
        }
    }
    Ok(())
}

fn runtime_root() -> Result<String, String> {
    let path = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows runtime unavailable")?)
        .canonicalize()
        .map_err(|_| "Windows runtime unavailable")?;
    path.to_str()
        .map(str::to_owned)
        .ok_or("Invalid Windows runtime path".into())
}

fn metadata_roots(config: &Config, program: &Path, cwd: &Path) -> Result<Vec<String>, String> {
    let mut roots = std::collections::BTreeSet::new();
    let runtime = runtime_root()?;
    let bases = config
        .read_roots
        .iter()
        .chain(&config.write_roots)
        .map(Path::new)
        .chain([
            program.parent().ok_or("Native program has no directory")?,
            cwd,
        ]);
    for base in bases {
        let resolved = base
            .canonicalize()
            .map_err(|_| "Native metadata directory changed")?;
        for ancestor in resolved.ancestors() {
            // An equal metadata-only entry masks a data grant in BaseContainer.
            if config
                .read_roots
                .iter()
                .chain(&config.write_roots)
                .chain(std::iter::once(&runtime))
                .any(|root| ancestor.starts_with(root))
            {
                continue;
            }
            roots.insert(
                ancestor
                    .to_str()
                    .ok_or("Invalid metadata directory")?
                    .to_owned(),
            );
        }
    }
    let roots = roots.into_iter().collect::<Vec<_>>();
    if roots.len() > 128 || roots.iter().map(String::len).sum::<usize>() > 12_000 {
        return Err("Native runtime ancestor visibility exceeds its bounded policy".into());
    }
    Ok(roots)
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !cfg!(all(windows, target_arch = "x86_64"))
            || self.adapter != ADAPTER
            || !matches!(self.network.as_str(), "none" | "any")
        {
            return Err("Unsupported native containment plan".into());
        }
        canonical_roots(&self.read_roots)?;
        canonical_roots(&self.write_roots)?;
        Ok(())
    }

    pub fn evidence(&self, program: &Path, cwd: &Path) -> Result<Value, String> {
        self.validate()?;
        Ok(json!({
            "adapter": self.adapter, "version": "1.0.1", "sdk_source_sha256": SOURCE_SHA256,
            "contract_version": "1.0.0", "read_roots": self.read_roots,
            "write_roots": self.write_roots, "network": self.network,
            "runtime_read_roots": [runtime_root()?], "host_acl_fallback": false, "telemetry": false,
            "runtime_metadata_roots": metadata_roots(self, program, cwd)?,
            "write_alias_policy": "reject_existing_hardlinks", "write_tree_scan_limit": 20_000
        }))
    }
}

pub fn available() -> Result<(), String> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let support = mxc_sdk::v1::probe(None).map_err(|_| "Native containment probe failed")?;
        if support.tier == Some("base-container")
            && support.probes.base_container_supports_enumerate_paths
        {
            return Ok(());
        }
    }
    Err("Verified BaseContainer support is unavailable".into())
}

#[cfg(windows)]
fn quote_argument(argument: &str) -> String {
    // Windows CRT parsing, including embedded quotes and trailing backslashes.
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        let count = if character == '"' {
            slashes * 2 + 1
        } else {
            slashes
        };
        result.extend(std::iter::repeat_n('\\', count));
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

#[cfg(windows)]
pub fn spawn(
    config: &crate::StdioConfig,
    policy: &Config,
    mut env: std::collections::BTreeMap<String, String>,
) -> Result<mxc_sdk::v1::MxcProcess, String> {
    use crate::program::execution_path;
    use zeroize::Zeroize;
    policy.validate()?;
    available()?;
    crate::program::check_write_aliases(&policy.write_roots)?;
    let program = execution_path(
        config
            .command
            .to_str()
            .ok_or("Invalid native program path")?,
    );
    let command = std::iter::once(program.as_str())
        .chain(config.args.iter().map(String::as_str))
        .map(quote_argument)
        .collect::<Vec<_>>()
        .join(" ");
    let write = policy
        .write_roots
        .iter()
        .map(|root| execution_path(root))
        .collect::<Vec<_>>();
    let mut read = policy
        .read_roots
        .iter()
        .map(|root| execution_path(root))
        .collect::<Vec<_>>();
    read.extend([execution_path(&runtime_root()?), program]);
    read.retain(|read| !write.iter().any(|write| Path::new(read).starts_with(write)));
    let network = if policy.network == "any" {
        "allow"
    } else {
        "deny"
    };
    let metadata = metadata_roots(policy, &config.command, &config.cwd)?
        .iter()
        .map(|path| execution_path(path))
        .collect::<Vec<_>>();
    let mut request = json!({
        "version": "1.0.0", "containment": "processcontainer",
        "fallback": {"allowDaclMutation": false},
        "process": {
            "commandLine": command,
            "cwd": execution_path(config.cwd.to_str().ok_or("Invalid native cwd")?),
            "env": env.iter().map(|(key,value)|format!("{key}={value}")).collect::<Vec<_>>()
        },
        "filesystem": {"readonlyPaths": read, "readwritePaths": write},
        "network": {"egress": {"default": network}, "ingress": {"default": "deny", "hostLoopback": network}},
        "ui": {"disable": false, "clipboard": "none", "injection": false},
        "processContainer": {
            "filesystem": {"enumeratePaths": metadata},
            "ui": {"isolation": "container", "desktopSystemControl": false, "systemSettings": "none", "ime": false}
        },
        "telemetry": {"enabled": false}, "lifecycle": {"destroyOnExit": true, "preservePolicy": false}
    });
    let mut payload = request.to_string();
    // The pinned SDK's exact-contract adapter preserves explicit ACL-fallback
    // refusal. Its public typed V1 request omits that control in release 1.0.1.
    // Credentials stay in this Worker, without policy files or command-line data.
    let result = mxc_sdk::__ffi::spawn_container_json(&payload, false)
        .map_err(|_| "Cannot create contained MCP command".to_string());
    payload.zeroize();
    for value in env.values_mut() {
        value.zeroize();
    }
    if let Some(values) = request["process"]["env"].as_array_mut() {
        for value in values {
            if let Value::String(text) = value {
                text.zeroize();
            }
        }
    }
    result
}
