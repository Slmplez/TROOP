//! Explicit local imports. A skill is instruction data, never execution authority.
use super::*;
use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

pub(crate) fn definitions() -> Vec<Value> {
    vec![
        json!({"name":"read_skill","description":"Load an enabled skill from this Run's frozen library. Returns paged instructions, version and auxiliary file manifest. Does not grant command authority. skill_id is the catalog ID; offset is a decimal byte offset and file_offset pages the manifest (32 files per page).", "parameters":{"type":"object","properties":{"skill_id":{"type":"string"},"offset":{"type":"string"},"file_offset":{"type":"string"}},"required":["skill_id"],"additionalProperties":false}}),
        json!({"name":"read_skill_file","description":"Read a file from a frozen, enabled skill version. Relative path from its manifest; optional decimal byte offset. UTF-8 text is paged; binary files are identified by size/hash. Scripts are not executed. An approved run_command may use the returned materialized Windows directory.","parameters":{"type":"object","properties":{"skill_id":{"type":"string"},"path":{"type":"string"},"offset":{"type":"string"}},"required":["skill_id","path"],"additionalProperties":false}}),
    ]
}
pub(crate) fn validate(name: &str, args: &Value) -> Result<(), String> {
    let spec = definitions()
        .into_iter()
        .find(|d| d["name"] == name)
        .ok_or("Unknown skill tool")?;
    let map = args
        .as_object()
        .ok_or("Skill arguments must be an object")?;
    if args.to_string().len() > 2000
        || map
            .iter()
            .any(|(k, v)| !v.is_string() || spec["parameters"]["properties"].get(k).is_none())
        || spec["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|k| !map.contains_key(k.as_str().unwrap()))
    {
        return Err("Invalid skill arguments".into());
    }
    if !troop_storage::memory::slug(args["skill_id"].as_str().unwrap_or("")) {
        return Err("Invalid skill ID".into());
    }
    offset(args)?;
    file_offset(args)?;
    Ok(())
}
fn file_offset(v: &Value) -> Result<usize, String> {
    v["file_offset"]
        .as_str()
        .unwrap_or("0")
        .parse::<usize>()
        .ok()
        .filter(|n| *n <= 128)
        .ok_or("Invalid manifest offset".into())
}
fn manifest(doc: &Value, start: usize) -> Value {
    let files = doc["manifest"].as_array().unwrap();
    let items = files
        .iter()
        .skip(start)
        .take(32)
        .cloned()
        .collect::<Vec<_>>();
    json!({"items":items,"total":files.len(),"next_offset":if start+32<files.len(){Some(start+32)}else{None}})
}
fn offset(v: &Value) -> Result<usize, String> {
    v["offset"]
        .as_str()
        .unwrap_or("0")
        .parse::<usize>()
        .ok()
        .filter(|n| *n <= 256_000)
        .ok_or("Invalid skill page offset".into())
}
fn page(bytes: &[u8], start: usize) -> Result<Value, String> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(json!({"binary":true,"bytes":bytes.len(),"sha256":tools::hash(bytes)}));
    };
    if start > bytes.len() || !text.is_char_boundary(start) {
        return Err("Offset must be a UTF-8 boundary within this file".into());
    }
    let mut end = (start + 4000).min(bytes.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"text":&text[start..end],"bytes":bytes.len(),"sha256":tools::hash(bytes),"next_offset":if end<bytes.len(){Some(end)}else{None}}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    path: String,
    #[serde(default = "copy_mode")]
    mode: String,
    #[serde(default = "local_source")]
    source_kind: String,
    #[serde(default)]
    id: String,
}
fn copy_mode() -> String {
    "copy".into()
}
fn local_source() -> String {
    "local".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    source: Source,
    preview_hash: String,
    expected_revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    #[serde(default = "default_agent")]
    agent_id: i64,
    #[serde(default)]
    offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillId {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillPage {
    id: String,
    #[serde(default)]
    offset: usize,
    version_id: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Toggle {
    id: String,
    agent_id: i64,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    id: String,
    expected_revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    id: String,
    expected_revision: i64,
    raw: String,
}
struct Bundle {
    id: String,
    doc: Value,
    files: Vec<(String, Vec<u8>)>,
}
fn guard(path: &Path) -> Result<(), String> {
    let mut part = PathBuf::new();
    for c in path.components() {
        part.push(c);
        if matches!(c, Component::Prefix(_)) {
            continue;
        }
        let m = fs::symlink_metadata(&part).map_err(|_| "Skill path is unavailable")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("Skill paths cannot contain Windows reparse points".into());
            }
        }
        if m.file_type().is_symlink() {
            return Err("Skill paths cannot contain symbolic links".into());
        }
    }
    Ok(())
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 200
        && !path
            .chars()
            .any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
        && Path::new(path)
            .components()
            .all(|c| matches!(c,Component::Normal(s) if !s.to_string_lossy().ends_with(['.',' '])))
        && !path
            .split('/')
            .any(|s| s == ".." || s == "." || s.is_empty())
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    guard(path)?;
    let mut b = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Cannot open skill file")?
        .take(256_001)
        .read_to_end(&mut b)
        .map_err(|_| "Cannot read skill file")?;
    if b.len() > 256_000 {
        return Err("Skill file exceeds 256KB".into());
    }
    Ok(b)
}
fn gather(
    root: &Path,
    dir: &Path,
    depth: usize,
    files: &mut Vec<(String, Vec<u8>)>,
    bytes: &mut usize,
    nodes: &mut usize,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Skill tree exceeds eight directory levels".into());
    }
    guard(dir)?;
    for item in fs::read_dir(dir).map_err(|_| "Cannot list skill directory")? {
        *nodes += 1;
        if *nodes > 256 {
            return Err("Skill exceeds 256 directory entries".into());
        }
        let item = item.map_err(|_| "Cannot read skill directory entry")?;
        if matches!(
            item.file_name().to_str(),
            Some(".git" | "node_modules" | "__pycache__")
        ) {
            continue;
        }
        guard(&item.path())?;
        if item
            .file_type()
            .map_err(|_| "Cannot inspect skill entry")?
            .is_dir()
        {
            gather(root, &item.path(), depth + 1, files, bytes, nodes)?;
        } else {
            let p = item.path();
            let name = p
                .strip_prefix(root)
                .map_err(|_| "Skill path escaped source")?
                .to_str()
                .ok_or("Skill path must be Unicode")?
                .replace('\\', "/");
            if !relative(&name) {
                return Err("Invalid auxiliary file path".into());
            }
            let data = read_bounded(&p)?;
            *bytes += data.len();
            files.push((name, data));
            if files.len() > 128 || *bytes > 2_000_000 {
                return Err("Skill exceeds 128 files or 2MB".into());
            }
        }
    }
    Ok(())
}
fn scalar(s: &str) -> Value {
    let s = s.trim();
    if s.starts_with('"') {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return v;
        }
    }
    if s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2 {
        return json!(s[1..s.len() - 1].replace("''", "'"));
    }
    match s {
        "true" => json!(true),
        "false" => json!(false),
        "null" | "~" => Value::Null,
        _ => json!(s),
    }
}
// The old format is a small mapping/scalar subset of frontmatter, not arbitrary YAML.
fn matter(lines: &[&str], cursor: &mut usize, indent: usize) -> Value {
    let mut map = serde_json::Map::new();
    while *cursor < lines.len() {
        let raw = lines[*cursor];
        if raw.trim().is_empty() || raw.trim_start().starts_with('#') {
            *cursor += 1;
            continue;
        }
        let level = raw.len() - raw.trim_start().len();
        if level < indent {
            break;
        }
        if level > indent {
            *cursor += 1;
            continue;
        }
        *cursor += 1;
        let Some((key, tail)) = raw.trim().split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = if tail.trim().is_empty() {
            let next = lines
                .get(*cursor)
                .map(|s| s.len() - s.trim_start().len())
                .unwrap_or(0);
            if next > indent {
                matter(lines, cursor, next)
            } else {
                json!({})
            }
        } else {
            scalar(tail)
        };
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}
fn parse(raw: &str, fallback: &str) -> Result<Value, String> {
    if raw.len() > 128_000 || raw.contains('\0') {
        return Err("SKILL.md must be UTF-8 text up to 128KB".into());
    }
    let text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (data, body) = if let Some(stripped) = text.strip_prefix("---\n") {
        let end = stripped.find("\n---").ok_or("Unclosed skill frontmatter")? + 4;
        let lines = text[4..end].lines().collect::<Vec<_>>();
        (matter(&lines, &mut 0, 0), text[end + 4..].trim().to_owned())
    } else {
        (json!({}), text.trim().to_owned())
    };
    if body.is_empty() || body.chars().count() > 100_000 {
        return Err("Skill body must contain 1–100000 characters".into());
    }
    let name = data["name"]
        .as_str()
        .unwrap_or(fallback)
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    if name.is_empty() {
        return Err("Skill needs a name".into());
    }
    let description = data["description"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(1536)
        .collect::<String>();
    let trigger = data["trigger"]["schedule"].as_str().filter(|s| !s.trim().is_empty()).map(|s| json!({"schedule":s.trim().chars().take(500).collect::<String>(),"enabled":data["trigger"]["enabled"]!=false})).unwrap_or(Value::Null);
    let source = data["metadata"]["source"]
        .as_str()
        .or(data["source"].as_str())
        .unwrap_or("")
        .chars()
        .take(256)
        .collect::<String>();
    Ok(
        json!({"name":name,"description":description,"body":body,"raw":raw,"frontmatter":data,"source_ref":source,"automation":trigger["schedule"].as_str().is_some_and(|s|!s.trim().is_empty()),"trigger":trigger,"disable_model_invocation":data["disable-model-invocation"]==true}),
    )
}
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 64 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "skill".into()
    } else {
        out.into()
    }
}
fn finish_bundle(
    id: String,
    mut doc: Value,
    mut files: Vec<(String, Vec<u8>)>,
) -> Result<Bundle, String> {
    if !troop_storage::memory::slug(&id) {
        return Err("Skill ID must be 1–80 letters, digits, hyphens or underscores".into());
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let manifest = files
        .iter()
        .map(|(p, b)| json!({"path":p,"bytes":b.len(),"sha256":tools::hash(b)}))
        .collect::<Vec<_>>();
    doc["manifest"] = json!(manifest);
    doc["digest"]=json!(tools::hash(json!({"id":id,"mode":doc["mode"],"source_path":doc["source_path"],"source_kind":doc["source_kind"],"manifest":manifest}).to_string().as_bytes()));
    Ok(Bundle { id, doc, files })
}
fn bundle(s: &Source) -> Result<Bundle, String> {
    if !matches!(s.mode.as_str(), "copy" | "live")
        || !matches!(s.source_kind.as_str(), "local" | "managed" | "plugin")
    {
        return Err("Invalid skill import mode or provenance".into());
    }
    let input = Path::new(&s.path);
    if !input.is_absolute()
        || s.path.len() > 2000
        || (s.path.starts_with("\\\\") && !s.path.starts_with("\\\\?\\"))
        || s.path.to_ascii_lowercase().starts_with("\\\\?\\unc\\")
    {
        return Err("Choose an absolute local skill path".into());
    }
    guard(input)?;
    let path = fs::canonicalize(input).map_err(|_| "Skill source unavailable")?;
    let entry = if path.is_dir() {
        if path.join("SKILL.md").is_file() {
            path.join("SKILL.md")
        } else {
            path.join("workflow.md")
        }
    } else {
        path.clone()
    };
    let file_name = entry
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid skill filename")?;
    let root = entry.parent().ok_or("Invalid skill root")?;
    let fallback = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported skill");
    let mut files = Vec::new();
    if matches!(file_name, "SKILL.md" | "workflow.md") {
        gather(root, root, 0, &mut files, &mut 0, &mut 0)?;
    } else {
        files.push((file_name.to_owned(), read_bounded(&entry)?));
    }
    let bytes = files
        .iter()
        .find(|(p, _)| p == file_name)
        .map(|(_, b)| b)
        .ok_or("SKILL.md or workflow.md not found")?;
    let mut doc = parse(
        std::str::from_utf8(bytes).map_err(|_| "Skill instructions must be UTF-8")?,
        fallback,
    )?;
    let id = if s.id.is_empty() {
        doc["frontmatter"]["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| slug(doc["name"].as_str().unwrap()))
    } else {
        s.id.clone()
    };
    doc["mode"] = json!(s.mode);
    doc["source_kind"] = json!(s.source_kind);
    doc["source_path"] = json!(entry.to_str().ok_or("Source path must be Unicode")?);
    doc["entry"] = json!(file_name);
    doc["locally_modified"] = json!(false);
    finish_bundle(id, doc, files)
}
fn brief(doc: &Value) -> Value {
    let mut result = json!({});
    for k in [
        "id",
        "version_id",
        "revision",
        "deleted",
        "name",
        "description",
        "digest",
        "mode",
        "source_kind",
        "source_path",
        "source_ref",
        "created_at",
        "automation",
        "trigger",
        "disable_model_invocation",
        "locally_modified",
    ] {
        result[k] = doc[k].clone();
    }
    result["description"] = json!(doc["description"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(256)
        .collect::<String>());
    result
}
impl Manager {
    pub(super) fn skills_rpc(
        &mut self,
        store: &mut Store,
        method: &str,
        p: Value,
    ) -> Result<Value, String> {
        match method {
            "skills.preview" => {
                let s = params::<Source>(p)?;
                let b = bundle(&s)?;
                let old = store.skill_current(&b.id)?;
                Ok(
                    json!({"id":b.id,"preview_hash":b.doc["digest"],"skill":brief(&b.doc),"files":b.doc["manifest"],"existing":old.as_ref().map(brief),"expected_revision":old.as_ref().and_then(|d|d["revision"].as_i64()).unwrap_or(0)}),
                )
            }
            "skills.import" => {
                let a = params::<Import>(p)?;
                let b = bundle(&a.source)?;
                if b.doc["digest"] != a.preview_hash {
                    return Err("Skill source changed since preview; preview again".into());
                }
                Ok(brief(&store.skill_put(
                    &b.id,
                    a.expected_revision,
                    &b.doc,
                    &b.files,
                )?))
            }
            "skills.list" => {
                let a = params::<Query>(p)?;
                store.memory_agent(a.agent_id)?;
                if a.offset > 100 {
                    return Err("Invalid skill offset".into());
                }
                let ids = store.skill_ids()?;
                let mut rows = Vec::new();
                let mut bytes = 0;
                for id in ids.iter().skip(a.offset).take(15) {
                    let doc = store.skill_current(id)?.unwrap();
                    let mut row = brief(&doc);
                    row["enabled"] = json!(store.skill_allowed(a.agent_id, id)?);
                    row["source_status"] = json!(if doc["mode"] == "live" {
                        match bundle(&Source {
                            path: doc["source_path"].as_str().unwrap().into(),
                            mode: "live".into(),
                            source_kind: doc["source_kind"].as_str().unwrap().into(),
                            id: id.clone(),
                        }) {
                            Ok(b) if b.doc["digest"] == doc["digest"] => "ready",
                            Ok(_) => "changed",
                            Err(_) => "unavailable",
                        }
                    } else {
                        "snapshot"
                    });
                    bytes += row.to_string().len();
                    if bytes > 40_000 {
                        break;
                    }
                    rows.push(row);
                }
                Ok(
                    json!({"items":rows,"total":ids.len(),"next_offset":if a.offset+rows.len()<ids.len(){Some(a.offset+rows.len())}else{None}}),
                )
            }
            "skills.get" => {
                let a = params::<SkillPage>(p)?;
                let doc = if let Some(v) = a.version_id {
                    let d = store.skill_version(v)?;
                    if d["id"] != a.id {
                        return Err("Skill/version mismatch".into());
                    }
                    d
                } else {
                    store.skill_current(&a.id)?.ok_or("Skill not found")?
                };
                let mut result = brief(&doc);
                result["content"] = page(doc["raw"].as_str().unwrap().as_bytes(), a.offset)?;
                result["manifest"] = manifest(&doc, 0);
                Ok(result)
            }
            "skills.versions" => {
                let a = params::<SkillPage>(p)?;
                if a.offset > 1000 {
                    return Err("Invalid version offset".into());
                }
                store.skill_versions(&a.id, a.offset)
            }
            "skills.enable" => {
                let a = params::<Toggle>(p)?;
                store.skill_enable(a.agent_id, &a.id, a.enabled)?;
                Ok(json!({"saved":true}))
            }
            "skills.remove" => {
                let a = params::<Remove>(p)?;
                store.skill_remove(&a.id, a.expected_revision)?;
                Ok(json!({"deleted":true}))
            }
            "skills.edit" => {
                let a = params::<Edit>(p)?;
                if a.raw.len() > 48_000 {
                    return Err("Editor input exceeds 48KB; import a file instead".into());
                }
                let old = store.skill_current(&a.id)?.unwrap_or(json!({"name":a.id,"source_kind":"local","source_path":"","entry":"SKILL.md","version_id":null}));
                if old["deleted"] == true {
                    return Err("Skill was deleted; use import to restore explicitly".into());
                }
                let mut doc = parse(&a.raw, old["name"].as_str().unwrap())?;
                for k in ["source_kind", "source_path", "entry"] {
                    doc[k] = old[k].clone();
                }
                doc["mode"] = json!("copy");
                doc["locally_modified"] = json!(true);
                let mut files = if let Some(v) = old["version_id"].as_i64() {
                    store.skill_files(v)?
                } else {
                    vec![("SKILL.md".into(), vec![])]
                };
                for (p, b) in &mut files {
                    if p == old["entry"].as_str().unwrap() {
                        *b = a.raw.as_bytes().to_vec();
                    }
                }
                let b = finish_bundle(a.id, doc, files)?;
                Ok(brief(&store.skill_put(
                    &b.id,
                    a.expected_revision,
                    &b.doc,
                    &b.files,
                )?))
            }
            "skills.refresh" => {
                let a = params::<SkillId>(p)?;
                let doc = store.skill_current(&a.id)?.ok_or("Skill not found")?;
                if doc["mode"] != "live" || doc["deleted"] == true {
                    return Err(
                        "Only active live sources can refresh; copy imports need a new preview"
                            .into(),
                    );
                }
                self.refresh_skill(store, &doc).map(|d| brief(&d))
            }
            _ => Err("Unknown skill method".into()),
        }
    }
    fn refresh_skill(&self, store: &mut Store, old: &Value) -> Result<Value, String> {
        let b = bundle(&Source {
            path: old["source_path"].as_str().unwrap().into(),
            mode: "live".into(),
            source_kind: old["source_kind"].as_str().unwrap().into(),
            id: old["id"].as_str().unwrap().into(),
        })?;
        if b.doc["digest"] == old["digest"] {
            return Ok(old.clone());
        }
        store.skill_put(&b.id, old["revision"].as_i64().unwrap(), &b.doc, &b.files)
    }
    pub(super) fn prepare_skills(&self, store: &mut Store, doc: &mut Value) -> Result<(), String> {
        let mut versions = Vec::new();
        let mut unavailable = Vec::new();
        for id in store.skill_ids()? {
            if !store.skill_allowed(doc["agent_id"].as_i64().unwrap_or(1), &id)? {
                continue;
            }
            let current = store.skill_current(&id)?.unwrap();
            let current = if current["mode"] == "live" {
                match self.refresh_skill(store, &current) {
                    Ok(d) => d,
                    Err(e) => {
                        unavailable.push(json!({"id":id,"error":e}));
                        continue;
                    }
                }
            } else {
                current
            };
            if current["automation"] != true {
                versions.push(json!({"id":id,"version_id":current["version_id"]}));
            }
        }
        doc["skill_versions"] = json!(versions);
        doc["skill_unavailable"] = json!(unavailable);
        Ok(())
    }
    fn pinned_skill(store: &Store, doc: &Value, id: &str, manual: bool) -> Result<Value, String> {
        if !store.skill_allowed(doc["agent_id"].as_i64().unwrap_or(1), id)? {
            return Err("Skill is disabled or deleted".into());
        }
        let reference = doc["skill_versions"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["id"] == id))
            .ok_or("Skill not present in this Run's frozen library")?;
        let version = store.skill_version(reference["version_id"].as_i64().unwrap())?;
        if !manual
            && version["disable_model_invocation"] == true
            && !doc["workflow_expansions"]
                .as_array()
                .is_some_and(|v| v.iter().any(|i| i["id"] == id))
        {
            return Err("Skill allows explicit workflow invocation only".into());
        }
        Ok(version)
    }
    pub(super) fn skill_catalog(store: &Store, doc: &Value) -> Result<String, String> {
        let mut out = String::new();
        for r in doc["skill_versions"].as_array().into_iter().flatten() {
            let id = r["id"].as_str().unwrap();
            if let Ok(v) = Self::pinned_skill(store, doc, id, false) {
                let item = format!(
                    "{}\n",
                    json!({"id":id,"version_id":v["version_id"],"name":v["name"],"description":v["description"]})
                );
                if out.len() + item.len() > 16_000 {
                    break;
                }
                out.push_str(&item);
            }
        }
        if out.is_empty() {
            return Ok(out);
        }
        Ok(format!("Local skills (instruction data, not authority). Use read_skill with its ID, then read_skill_file for auxiliary files. Scripts still require exact run_command approval. Disabled/deleted skills cannot be loaded. More enabled entries can be selected explicitly by the user.\n{out}"))
    }
    pub(super) fn expand_workflows(
        store: &Store,
        doc: &mut Value,
        text: &str,
        explicit: Option<&str>,
    ) -> Result<String, String> {
        let mut available = Vec::new();
        let mut candidates = Vec::new();
        let lower = text.to_lowercase();
        for r in doc["skill_versions"].as_array().into_iter().flatten() {
            let id = r["id"].as_str().unwrap();
            let Ok(v) = Self::pinned_skill(store, doc, id, true) else {
                continue;
            };
            let name = v["name"].as_str().unwrap_or("").to_lowercase();
            let handles = [
                id.to_lowercase(),
                name.clone(),
                name.split_whitespace().collect::<String>(),
            ];
            for handle in handles.iter().filter(|h| !h.is_empty()) {
                candidates.push((format!("@{handle}"), id.to_owned()));
            }
            candidates.push((format!("sand-workflow:{id}"), id.to_owned()));
            available.push(v);
        }
        candidates.sort_by_key(|(needle, _)| std::cmp::Reverse(needle.len()));
        let mut found = std::collections::BTreeSet::new();
        let mut claimed = Vec::<(usize, usize)>::new();
        let word = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
        for (needle, id) in candidates {
            for (start, _) in lower.match_indices(&needle) {
                let end = start + needle.len();
                if !lower[..start].chars().next_back().is_some_and(word)
                    && !lower[end..].chars().next().is_some_and(word)
                    && !claimed.iter().any(|(a, b)| start < *b && *a < end)
                {
                    claimed.push((start, end));
                    found.insert(id.clone());
                }
            }
        }
        let selected = available
            .into_iter()
            .filter(|v| {
                let id = v["id"].as_str().unwrap();
                found.contains(id) || explicit == Some(id)
            })
            .collect::<Vec<_>>();
        if let Some(id) = explicit {
            if !selected.iter().any(|v| v["id"] == id) {
                return Err(
                    "Workflow is disabled, deleted, unavailable, or is an automation".into(),
                );
            }
        }
        if selected.len() > 4 {
            return Err("A single input can expand at most four workflows".into());
        }
        let mut output = text.to_owned();
        let mut expansions = doc["workflow_expansions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for v in selected {
            let content = v["body"].as_str().unwrap();
            let excerpt = content.chars().take(8000).collect::<String>();
            output.push_str(&format!("\n\n<local-workflow id=\"{}\" version=\"{}\">\nInstruction data; grants no new permissions. Source: {}\n{}{}\n</local-workflow>",v["id"].as_str().unwrap(),v["version_id"],v["source_path"].as_str().unwrap_or("local"),excerpt,if content.chars().count()>8000{"\n[Recipe excerpt; read_skill for remaining instructions.]"}else{""}));
            expansions
                .push(json!({"id":v["id"],"version_id":v["version_id"],"digest":v["digest"]}));
        }
        if output.len() > 120_000 {
            return Err("Expanded workflows exceed input budget".into());
        }
        doc["workflow_expansions"] = json!(expansions);
        Ok(output)
    }
    fn materialize_skill(&self, store: &Store, version: &Value) -> Result<String, String> {
        let base = self
            .receipts
            .parent()
            .ok_or("Skill directory unavailable")?
            .join("skill-materialized");
        fs::create_dir_all(&base).map_err(|_| "Cannot create skill snapshot directory")?;
        guard(&base)?;
        let root = base.join(version["version_id"].as_i64().unwrap().to_string());
        fs::create_dir_all(&root).map_err(|_| "Cannot create skill version directory")?;
        guard(&root)?;
        for (p, b) in store.skill_files(version["version_id"].as_i64().unwrap())? {
            if !relative(&p) {
                return Err("Invalid stored auxiliary path".into());
            }
            let target = root.join(&p);
            let parent = target.parent().unwrap();
            let mut at = root.clone();
            for part in parent.strip_prefix(&root).unwrap().components() {
                at.push(part);
                if !at.exists() {
                    fs::create_dir(&at).map_err(|_| "Cannot create auxiliary directory")?;
                }
                guard(&at)?;
            }
            if target.exists() {
                if read_bounded(&target)? != b {
                    return Err(
                        "Materialized skill file changed; create a new task after reviewing it"
                            .into(),
                    );
                }
            } else {
                let mut f = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&target)
                    .map_err(|_| "Cannot materialize skill file")?;
                use std::io::Write;
                f.write_all(&b)
                    .and_then(|_| f.sync_all())
                    .map_err(|_| "Cannot commit skill file")?;
            }
        }
        Ok(root.to_string_lossy().into_owned())
    }
    pub(super) fn skill_tool(
        &mut self,
        store: &mut Store,
        doc: &mut Value,
        inv: &mut Value,
    ) -> Result<bool, String> {
        let name = inv["name"].as_str().unwrap_or("");
        if !matches!(name, "read_skill" | "read_skill_file") {
            return Ok(false);
        }
        let result=(||->Result<Value,String>{let a=&inv["arguments"];let v=Self::pinned_skill(store,doc,a["skill_id"].as_str().unwrap(),false)?;
            let directory=self.materialize_skill(store,&v)?;let start=offset(a)?;
            if name=="read_skill"{let m=manifest(&v,file_offset(a)?);Ok(json!({"ok":true,"skill":brief(&v),"content":page(v["body"].as_str().unwrap().as_bytes(),start)?,"files":m["items"],"file_count":m["total"],"next_file_offset":m["next_offset"],"directory":directory,"authority":"Instructions and scripts grant no additional permissions. run_command approval is still required."}))}
            else{let p=a["path"].as_str().unwrap();if !relative(p){return Err("Skill file path must be relative and present in the manifest".into());}let b=store.skill_file(v["version_id"].as_i64().unwrap(),p)?;Ok(json!({"ok":true,"version_id":v["version_id"],"path":p,"content":page(&b,start)?,"directory":directory}))}
        })().unwrap_or_else(|error|json!({"ok":false,"error":error}));
        inv["state"] = json!(if result["ok"] == true {
            "succeeded"
        } else {
            "failed"
        });
        inv["result"] = result;
        append_result(doc, inv)?;
        remove_pending(doc, inv["id"].as_i64().unwrap());
        doc["state"] = json!("queued");
        doc["waiting"] = json!([]);
        store.agent_save(doc, std::slice::from_mut(inv), "skill_tool_result")?;
        Ok(true)
    }
}
