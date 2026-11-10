use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
mod tests;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Scope {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subject_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Limits {
    max_depth: i64,
    max_writes_per_hour: i64,
    cooldown_seconds: i64,
}

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE causal_limit_policies(scope_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE TABLE causal_limit_history(scope_key TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(scope_key,revision));
        CREATE TABLE causal_writes(effect_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,subject_id TEXT NOT NULL,action TEXT NOT NULL,run_id INTEGER NOT NULL,created_at INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE INDEX causal_object_window ON causal_writes(source_id,subject_id,created_at);
        PRAGMA user_version=35;").map_err(|e|e.to_string())?;
    let scope = json!({"kind":"global"});
    let document = json!({"scope":scope,"revision":1,"limits":{"max_depth":8,"max_writes_per_hour":3,"cooldown_seconds":60}});
    tx.execute(
        "INSERT INTO causal_limit_policies VALUES(?1,1,?2)",
        params![scope.to_string(), document.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO causal_limit_history VALUES(?1,1,?2)",
        params![scope.to_string(), document.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

impl Store {
    fn causal_scope_key(&self, input: &Value) -> Result<String, String> {
        let scope: Scope = serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
        let valid = match scope.kind.as_str() {
            "global" => {
                scope.workspace_id.is_none()
                    && scope.source_id.is_none()
                    && scope.subject_id.is_none()
            }
            "workspace" => {
                scope.workspace_id.is_some()
                    && scope.source_id.is_none()
                    && scope.subject_id.is_none()
            }
            "source" => {
                scope.workspace_id.is_none()
                    && scope.source_id.is_some()
                    && scope.subject_id.is_none()
            }
            "object" => {
                scope.workspace_id.is_none()
                    && scope.source_id.is_some()
                    && scope
                        .subject_id
                        .as_ref()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 1024)
            }
            _ => false,
        };
        if !valid {
            return Err("回流限额范围无效。".into());
        }
        if let Some(id) = scope.workspace_id {
            self.workspace_path(id)?;
        }
        if let Some(id) = &scope.source_id {
            self.event_source(id)?;
        }
        serde_json::to_value(scope)
            .map(|s| s.to_string())
            .map_err(|e| e.to_string())
    }

    pub fn causal_policy_get(&self, scope: &Value) -> Result<Value, String> {
        let key = self.causal_scope_key(scope)?;
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT document FROM causal_limit_policies WHERE scope_key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
            None => Ok(json!({"scope":scope,"revision":0,"limits":null})),
        }
    }

    pub fn causal_policy_save(&self, input: &Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Save {
            scope: Scope,
            expected_revision: i64,
            limits: Limits,
        }
        let save: Save = serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
        if !(1..=64).contains(&save.limits.max_depth)
            || !(1..=10000).contains(&save.limits.max_writes_per_hour)
            || !(0..=3600).contains(&save.limits.cooldown_seconds)
        {
            return Err("回流限额超出支持范围。".into());
        }
        let scope = serde_json::to_value(save.scope).map_err(|e| e.to_string())?;
        let key = self.causal_scope_key(&scope)?;
        let current = self.causal_policy_get(&scope)?;
        if current["revision"] != save.expected_revision {
            return Err("回流限额修订已变化，请刷新。".into());
        }
        let revision = save.expected_revision + 1;
        let document = json!({"scope":scope,"revision":revision,"limits":save.limits});
        self.db.execute("INSERT INTO causal_limit_policies VALUES(?1,?2,?3) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,document=excluded.document",params![key,revision,document.to_string()]).map_err(|e|e.to_string())?;
        self.db
            .execute(
                "INSERT INTO causal_limit_history VALUES(?1,?2,?3)",
                params![key, revision, document.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(document)
    }

    pub fn causal_policy_history(&self, scope: &Value) -> Result<Value, String> {
        let key = self.causal_scope_key(scope)?;
        let mut q=self.db.prepare("SELECT document FROM causal_limit_history WHERE scope_key=?1 ORDER BY revision DESC LIMIT 100").map_err(|e|e.to_string())?;
        let items = q
            .query_map([key], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|raw| {
                raw.map_err(|e| e.to_string())
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items}))
    }

    pub fn causal_policy_resolve(&self, context: &Value) -> Result<Value, String> {
        let mut selected = self.causal_policy_get(&json!({"kind":"global"}))?;
        let scopes = [
            json!({"kind":"workspace","workspace_id":context["workspace_id"]}),
            json!({"kind":"source","source_id":context["source_id"]}),
            json!({"kind":"object","source_id":context["source_id"],"subject_id":context["subject_id"]}),
        ];
        for scope in scopes {
            // Internal origins have a durable synthetic source identity, without an
            // external source configuration. Workspace and global policies apply.
            if scope["source_id"]
                .as_str()
                .is_some_and(|s| s.starts_with("internal:"))
            {
                continue;
            }
            let candidate = self.causal_policy_get(&scope)?;
            if candidate["revision"].as_i64().unwrap_or(0) > 0 {
                selected = candidate;
            }
        }
        Ok(selected)
    }

    pub fn causal_write_check(
        &self,
        context: &Value,
        action: &str,
        effect_id: &str,
    ) -> Result<Value, String> {
        let source = context["source_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("缺少回流来源身份。")?;
        let subject = context["subject_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("缺少回流对象身份。")?;
        let policy = self.causal_policy_resolve(context)?;
        let (count,last):(i64,i64)=self.db.query_row("SELECT COUNT(*),COALESCE(MAX(CASE WHEN action=?3 THEN created_at END),0) FROM causal_writes WHERE source_id=?1 AND subject_id=?2 AND effect_id<>?4 AND created_at>unixepoch()-3600",params![source,subject,action,effect_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        let now: i64 = self
            .db
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let allowed = count < policy["limits"]["max_writes_per_hour"].as_i64().unwrap()
            && (last == 0 || now - last >= policy["limits"]["cooldown_seconds"].as_i64().unwrap());
        Ok(
            json!({"allowed":allowed,"policy":policy,"source_id":source,"subject_id":subject,"action":action,"count":count,"last_write_at":last,"reason":if allowed {"回流写动作限额允许。"}else{"达到来源对象写动作限额或同类动作冷却门禁。"}}),
        )
    }

    /// An accepted write attempt consumes one slot even if its eventual external
    /// result is unknown. Retrying the same effect retains its original identity.
    pub fn causal_write_reserve(
        &self,
        context: &Value,
        action: &str,
        effect_id: &str,
        run: i64,
    ) -> Result<Value, String> {
        let existing: Option<String> = self
            .db
            .query_row(
                "SELECT document FROM causal_writes WHERE effect_id=?1",
                [effect_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(raw) = existing {
            let previous: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if previous["context"] != *context
                || previous["action"] != action
                || previous["run_id"] != run
            {
                return Err("回流写动作身份冲突。".into());
            }
            return Ok(previous);
        }
        let decision = self.causal_write_check(context, action, effect_id)?;
        if decision["allowed"] != true {
            return Err(decision["reason"].as_str().unwrap().to_owned());
        }
        let document = json!({"effect_id":effect_id,"context":context,"action":action,"run_id":run,"policy":decision["policy"]});
        self.db
            .execute(
                "INSERT INTO causal_writes VALUES(?1,?2,?3,?4,?5,unixepoch(),?6)",
                params![
                    effect_id,
                    context["source_id"].as_str(),
                    context["subject_id"].as_str(),
                    action,
                    run,
                    document.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(document)
    }
}
