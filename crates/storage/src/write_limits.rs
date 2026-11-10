//! Versioned write-back limits. Admitted writes are ledgered by source, object
//! and action, with the causal chain beside the workspace ceiling.
use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS write_limit_policies(
            revision INTEGER PRIMARY KEY,
            document TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS write_limit_ledger(
            source_key TEXT NOT NULL,
            object_key TEXT NOT NULL,
            action_key TEXT NOT NULL,
            event_key TEXT NOT NULL,
            chain_id TEXT NOT NULL,
            chain_depth INTEGER NOT NULL,
            workspace_id INTEGER NOT NULL,
            occurred_at INTEGER NOT NULL,
            policy_revision INTEGER NOT NULL,
            document TEXT NOT NULL,
            PRIMARY KEY (source_key, object_key, action_key, event_key)
        );
        CREATE INDEX IF NOT EXISTS write_limit_ledger_workspace
            ON write_limit_ledger(workspace_id, occurred_at);
        CREATE INDEX IF NOT EXISTS write_limit_ledger_chain
            ON write_limit_ledger(chain_id, chain_depth);",
    )
    .map_err(|e| e.to_string())?;
    let existing: i64 = tx
        .query_row("SELECT COUNT(*) FROM write_limit_policies", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    if existing == 0 {
        let document = policy_document(1, PolicyLimits::default());
        tx.execute(
            "INSERT INTO write_limit_policies(revision, document, created_at) VALUES(1,?1,unixepoch())",
            [document.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    backfill(&tx)?;
    tx.execute_batch("PRAGMA user_version=34;")
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[derive(Clone, Copy)]
struct PolicyLimits {
    max_writes: i64,
    workspace_max_writes: i64,
    window_seconds: i64,
    cooldown_seconds: i64,
    max_chain_depth: i64,
}

impl Default for PolicyLimits {
    fn default() -> Self {
        Self {
            max_writes: 3,
            workspace_max_writes: 3,
            window_seconds: 3600,
            cooldown_seconds: 60,
            max_chain_depth: 8,
        }
    }
}

fn policy_document(revision: i64, limits: PolicyLimits) -> Value {
    json!({
        "revision": revision,
        "max_writes": limits.max_writes,
        "workspace_max_writes": limits.workspace_max_writes,
        "window_seconds": limits.window_seconds,
        "cooldown_seconds": limits.cooldown_seconds,
        "max_chain_depth": limits.max_chain_depth
    })
}

fn backfill(tx: &Connection) -> Result<(), String> {
    let revision: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(revision),1) FROM write_limit_policies",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut query = tx
        .prepare(
            "SELECT d.rule_id, d.event_key, d.workspace_id, d.created_at, d.document,
                (SELECT r.document FROM automation_rules r WHERE r.id=d.rule_id ORDER BY r.revision DESC LIMIT 1)
             FROM automation_deliveries d
             WHERE json_extract(d.document,'$.state')='dispatched'",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut pending = Vec::new();
    for row in rows {
        pending.push(row.map_err(|e| e.to_string())?);
    }
    drop(query);
    for (rule_id, event_key, workspace, created, document, rule) in pending {
        let parsed: Value = serde_json::from_str(&document).unwrap_or_else(|_| json!({}));
        let (source, object, action) = rule
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .map(|mut value| {
                if value["id"].is_null() {
                    value["id"] = json!(rule_id);
                }
                if value["workspace_id"].is_null() {
                    value["workspace_id"] = json!(workspace);
                }
                limit_identity(&value)
            })
            .unwrap_or_else(|| {
                (
                    format!("rule:{rule_id}"),
                    format!("workspace:{workspace}"),
                    "dispatch".to_owned(),
                )
            });
        tx.execute(
            "INSERT OR IGNORE INTO write_limit_ledger(
                source_key, object_key, action_key, event_key, chain_id, chain_depth,
                workspace_id, occurred_at, policy_revision, document
            ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                source,
                object,
                action,
                event_key,
                parsed["chain_id"].as_str().unwrap_or(""),
                parsed["chain_depth"].as_i64().unwrap_or(0),
                workspace,
                created,
                revision,
                document
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn limit_identity(rule: &Value) -> (String, String, String) {
    let workspace = rule["workspace_id"].as_i64().unwrap_or(0);
    let source = format!("rule:{}", rule["id"].as_str().unwrap_or(""));
    let object = match rule["work_item_id"].as_i64() {
        Some(id) => format!("work_item:{id}"),
        None => format!("workspace:{workspace}"),
    };
    let action = if let Some(name) = rule["start"]["action"]["name"]
        .as_str()
        .filter(|name| !name.is_empty())
    {
        format!("tool:{name}")
    } else if let Some(engine) = rule["start"]["engine_id"]
        .as_str()
        .filter(|engine| !engine.is_empty())
    {
        format!("cli:{engine}")
    } else {
        "agent.start".to_owned()
    };
    (source, object, action)
}

pub(crate) fn chain_parts(event: &Value) -> (String, u64) {
    let id = match &event["id"] {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => "0".to_owned(),
    };
    let chain_id = event["chain_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("run-{id}"));
    (chain_id, event["chain_depth"].as_u64().unwrap_or(0))
}

pub(crate) struct WriteLimitWrite {
    pub source: String,
    pub object: String,
    pub action: String,
    pub event_key: String,
    pub chain_id: String,
    pub chain_depth: i64,
    pub workspace_id: i64,
    pub document: Value,
}

const DEFAULT_RATE_REASON: &str = "达到工作区每小时三次或六十秒冷却门禁。";
const CHAIN_REASON: &str = "达到自动链深度上限。";
const POLICY_FIELDS: &[&str] = &[
    "max_writes",
    "workspace_max_writes",
    "window_seconds",
    "cooldown_seconds",
    "max_chain_depth",
];

impl Store {
    pub fn write_limit_policy(&self) -> Result<Value, String> {
        let (revision, raw): (i64, String) = self
            .db
            .query_row(
                "SELECT revision, document FROM write_limit_policies ORDER BY revision DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("写回限额策略缺失。")?;
        let mut document: Value = serde_json::from_str(&raw).map_err(|_| "写回限额策略损坏。")?;
        document["revision"] = json!(revision);
        limits_from(&document)?;
        Ok(document)
    }

    pub fn save_write_limit_policy(
        &mut self,
        expected: i64,
        input: &Value,
    ) -> Result<Value, String> {
        let limits = checked_limits(input)?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let current: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision),0) FROM write_limit_policies",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if current != expected {
            return Err("写回限额修订冲突，请刷新。".into());
        }
        let document = policy_document(expected + 1, limits);
        tx.execute(
            "INSERT INTO write_limit_policies(revision, document, created_at) VALUES(?1,?2,unixepoch())",
            params![expected + 1, document.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(document)
    }

    pub(crate) fn record_write_limit(&self, write: &WriteLimitWrite) -> Result<(), String> {
        let revision = self.write_limit_policy()?["revision"]
            .as_i64()
            .ok_or("写回限额策略损坏。")?;
        self.db
            .execute(
                "INSERT OR IGNORE INTO write_limit_ledger(
                    source_key, object_key, action_key, event_key, chain_id, chain_depth,
                    workspace_id, occurred_at, policy_revision, document
                ) VALUES(?1,?2,?3,?4,?5,?6,?7,unixepoch(),?8,?9)",
                params![
                    write.source,
                    write.object,
                    write.action,
                    write.event_key,
                    write.chain_id,
                    write.chain_depth,
                    write.workspace_id,
                    revision,
                    write.document.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rule_frequency_blocked(&self, workspace: i64) -> Result<bool, String> {
        let policy = self.write_limit_policy()?;
        let limits = limits_from(&policy)?;
        rate_blocked(
            &self.db,
            "workspace_id=?3",
            params![
                limits.workspace_max_writes,
                limits.cooldown_seconds,
                workspace,
                limits.window_seconds
            ],
        )
    }

    pub fn automation_limit_reason(
        &self,
        rule: &Value,
        event: &Value,
    ) -> Result<Option<String>, String> {
        let policy = self.write_limit_policy()?;
        let limits = limits_from(&policy)?;
        let (source, object, action) = limit_identity(rule);
        let workspace = rule["workspace_id"].as_i64().unwrap_or(0);
        let (chain_id, cause) = chain_parts(event);
        let mut reason = None;
        if rate_blocked(
            &self.db,
            "source_key=?3 AND object_key=?4 AND action_key=?5",
            params![
                limits.max_writes,
                limits.cooldown_seconds,
                source,
                object,
                action,
                limits.window_seconds
            ],
        )? {
            reason = Some(format!(
                "达到工作区同一来源、对象与动作的写回上限（{} 次 / {} 秒，冷却 {} 秒）。",
                limits.max_writes, limits.window_seconds, limits.cooldown_seconds
            ));
        }
        if self.rule_frequency_blocked(workspace)? {
            reason = Some(if default_rate(&limits) {
                DEFAULT_RATE_REASON.to_owned()
            } else {
                format!(
                    "达到工作区写回上限（{} 次 / {} 秒，冷却 {} 秒）。",
                    limits.workspace_max_writes, limits.window_seconds, limits.cooldown_seconds
                )
            });
        }
        let max_depth = u64::try_from(limits.max_chain_depth).unwrap_or(u64::MAX);
        let stored: i64 = if chain_id.is_empty() {
            0
        } else {
            self.db
                .query_row(
                    "SELECT COALESCE(MAX(chain_depth),0) FROM write_limit_ledger WHERE chain_id=?1",
                    [&chain_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?
        };
        if cause >= max_depth || stored >= limits.max_chain_depth {
            reason = Some(CHAIN_REASON.to_owned());
        }
        Ok(reason)
    }
}

fn default_rate(limits: &PolicyLimits) -> bool {
    let defaults = PolicyLimits::default();
    limits.max_writes == defaults.max_writes
        && limits.workspace_max_writes == defaults.workspace_max_writes
        && limits.window_seconds == defaults.window_seconds
        && limits.cooldown_seconds == defaults.cooldown_seconds
}

fn limits_from(policy: &Value) -> Result<PolicyLimits, String> {
    Ok(PolicyLimits {
        max_writes: required_i64(policy, "max_writes")?,
        workspace_max_writes: required_i64(policy, "workspace_max_writes")?,
        window_seconds: required_i64(policy, "window_seconds")?,
        cooldown_seconds: required_i64(policy, "cooldown_seconds")?,
        max_chain_depth: required_i64(policy, "max_chain_depth")?,
    })
}

fn required_i64(policy: &Value, key: &str) -> Result<i64, String> {
    policy
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| "写回限额策略损坏。".to_owned())
}

fn checked_limits(input: &Value) -> Result<PolicyLimits, String> {
    let object = input.as_object().ok_or("写回限额策略无效。")?;
    if object
        .keys()
        .any(|key| !POLICY_FIELDS.contains(&key.as_str()))
    {
        return Err("写回限额策略包含未知字段。".into());
    }
    let limits = PolicyLimits {
        max_writes: bounded(input, "max_writes", 1, 100_000)?,
        workspace_max_writes: bounded(input, "workspace_max_writes", 1, 100_000)?,
        window_seconds: bounded(input, "window_seconds", 1, 31_622_400)?,
        cooldown_seconds: bounded(input, "cooldown_seconds", 0, 31_622_400)?,
        max_chain_depth: bounded(input, "max_chain_depth", 1, 10_000)?,
    };
    if limits.cooldown_seconds > limits.window_seconds {
        return Err("冷却时间不能超过统计窗口。".into());
    }
    Ok(limits)
}

fn bounded(input: &Value, key: &str, min: i64, max: i64) -> Result<i64, String> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(|| format!("写回限额字段 {key} 无效。"))
}

fn rate_blocked(
    db: &Connection,
    predicate: &str,
    params: impl rusqlite::Params,
) -> Result<bool, String> {
    // ?1 is the write ceiling and ?2 is the cooldown. Predicate placeholders
    // start at ?3, and the window is the next parameter.
    let window_index = predicate.matches('?').count() + 3;
    let sql = format!(
        "SELECT COUNT(*)>=?1 OR COALESCE(MAX(occurred_at),0)>unixepoch()-?2
         FROM write_limit_ledger WHERE {predicate} AND occurred_at>unixepoch()-?{window_index}"
    );
    db.query_row(&sql, params, |row| row.get(0))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        store: Option<Store>,
        dir: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "troop-write-limit-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            Self {
                store: Some(Store::open(&dir).unwrap()),
                dir,
            }
        }
        fn store(&self) -> &Store {
            self.store.as_ref().unwrap()
        }
        fn store_mut(&mut self) -> &mut Store {
            self.store.as_mut().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.store.take());
            assert!(self.dir.starts_with(std::env::temp_dir()));
            std::fs::remove_dir_all(&self.dir).unwrap();
        }
    }

    fn rule(action: &str, workspace: i64) -> Value {
        json!({
            "id": format!("rule-{action}"),
            "workspace_id": workspace,
            "start": {"action": {"name": action}}
        })
    }
    fn cause(chain: &str, depth: u64) -> Value {
        json!({"id": 7, "epoch": 1, "chain_id": chain, "chain_depth": depth})
    }
    fn admit(store: &Store, rule: &Value, event_key: &str, chain: &str, depth: i64) {
        let (source, object, action) = limit_identity(rule);
        store
            .record_write_limit(&WriteLimitWrite {
                source,
                object,
                action,
                event_key: event_key.to_owned(),
                chain_id: chain.to_owned(),
                chain_depth: depth,
                workspace_id: rule["workspace_id"].as_i64().unwrap(),
                document: json!({"state":"dispatched"}),
            })
            .unwrap();
    }
    fn age(store: &Store, event_key: &str, seconds: i64) {
        store
            .db
            .execute(
                "UPDATE write_limit_ledger SET occurred_at=unixepoch()-?1 WHERE event_key=?2",
                params![seconds, event_key],
            )
            .unwrap();
    }

    #[test]
    fn fresh_database_seeds_the_historical_default_policy() {
        let fixture = Fixture::new();
        let policy = fixture.store().write_limit_policy().unwrap();
        assert_eq!(policy["revision"], 1);
        assert_eq!(policy["max_writes"], 3);
        assert_eq!(policy["workspace_max_writes"], 3);
        assert_eq!(policy["window_seconds"], 3600);
        assert_eq!(policy["cooldown_seconds"], 60);
        assert_eq!(policy["max_chain_depth"], 8);
        let version: i64 = fixture
            .store()
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 34);
    }

    #[test]
    fn default_ceiling_matches_three_per_hour_and_sixty_second_cooldown() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let write = rule("write_file", 4);
        admit(store, &write, "once", "chain-cool", 1);
        assert_eq!(
            store
                .automation_limit_reason(&write, &cause("chain-other", 0))
                .unwrap()
                .as_deref(),
            Some(DEFAULT_RATE_REASON)
        );
        store
            .db
            .execute("DELETE FROM write_limit_ledger", [])
            .unwrap();
        for key in ["a", "b", "c"] {
            admit(store, &write, key, "chain-count", 1);
            age(store, key, 120);
        }
        assert_eq!(
            store
                .automation_limit_reason(&write, &cause("chain-fresh", 0))
                .unwrap()
                .as_deref(),
            Some(DEFAULT_RATE_REASON)
        );
        assert!(store.rule_frequency_blocked(4).unwrap());
        assert!(!store.rule_frequency_blocked(9).unwrap());
        let read = rule("read_file", 4);
        assert_eq!(
            store
                .automation_limit_reason(&read, &cause("chain-fresh", 0))
                .unwrap()
                .as_deref(),
            Some(DEFAULT_RATE_REASON)
        );
        for key in ["a", "b", "c"] {
            age(store, key, 4000);
        }
        assert_eq!(
            store
                .automation_limit_reason(&write, &cause("chain-fresh", 0))
                .unwrap(),
            None
        );
    }

    #[test]
    fn one_source_object_action_cannot_exceed_its_own_limit() {
        let mut fixture = Fixture::new();
        fixture
            .store_mut()
            .save_write_limit_policy(
                1,
                &json!({
                    "max_writes": 1,
                    "workspace_max_writes": 100,
                    "window_seconds": 3600,
                    "cooldown_seconds": 0,
                    "max_chain_depth": 8
                }),
            )
            .unwrap();
        let store = fixture.store();
        let write = rule("write_file", 4);
        admit(store, &write, "only", "chain-key", 1);
        age(store, "only", 120);
        let reason = store
            .automation_limit_reason(&write, &cause("chain-other", 0))
            .unwrap()
            .unwrap();
        assert!(reason.contains("同一来源、对象与动作"));
        assert_eq!(
            store
                .automation_limit_reason(&rule("read_file", 4), &cause("chain-other", 0))
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .automation_limit_reason(&rule("write_file", 8), &cause("chain-other", 0))
                .unwrap(),
            None
        );
        admit(store, &write, "only", "chain-key", 1);
        let count: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM write_limit_ledger", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn causal_chain_depth_comes_from_the_policy_and_the_ledger() {
        let mut fixture = Fixture::new();
        let write = rule("write_file", 4);
        assert_eq!(
            fixture
                .store()
                .automation_limit_reason(&write, &cause("chain-z", 7))
                .unwrap(),
            None
        );
        assert_eq!(
            fixture
                .store()
                .automation_limit_reason(&write, &cause("chain-z", 8))
                .unwrap()
                .as_deref(),
            Some(CHAIN_REASON)
        );
        admit(fixture.store(), &write, "deep", "chain-z", 8);
        age(fixture.store(), "deep", 4000);
        assert_eq!(
            fixture
                .store()
                .automation_limit_reason(&write, &cause("chain-z", 0))
                .unwrap()
                .as_deref(),
            Some(CHAIN_REASON)
        );
        fixture
            .store_mut()
            .save_write_limit_policy(
                1,
                &json!({
                    "max_writes": 3,
                    "workspace_max_writes": 3,
                    "window_seconds": 3600,
                    "cooldown_seconds": 60,
                    "max_chain_depth": 2
                }),
            )
            .unwrap();
        assert_eq!(
            fixture
                .store()
                .automation_limit_reason(&rule("read_file", 9), &cause("unused", 2))
                .unwrap()
                .as_deref(),
            Some(CHAIN_REASON)
        );
    }

    #[test]
    fn policy_revisions_are_optimistic_and_survive_reopen() {
        let mut fixture = Fixture::new();
        let error = fixture
            .store_mut()
            .save_write_limit_policy(0, &json!({"max_writes":1,"workspace_max_writes":1,"window_seconds":10,"cooldown_seconds":1,"max_chain_depth":2}))
            .unwrap_err();
        assert!(error.contains("修订冲突"));
        assert!(fixture.store_mut().save_write_limit_policy(1, &json!({"max_writes":1,"workspace_max_writes":1,"window_seconds":10,"cooldown_seconds":11,"max_chain_depth":2})).unwrap_err().contains("冷却"));
        assert!(fixture.store_mut().save_write_limit_policy(1, &json!({"max_writes":0,"workspace_max_writes":1,"window_seconds":10,"cooldown_seconds":1,"max_chain_depth":2})).unwrap_err().contains("max_writes"));
        assert!(fixture.store_mut().save_write_limit_policy(1, &json!({"max_writes":1,"workspace_max_writes":1,"window_seconds":10,"cooldown_seconds":1,"max_chain_depth":2,"extra":true})).unwrap_err().contains("未知字段"));
        let saved = fixture.store_mut().save_write_limit_policy(1, &json!({"max_writes":2,"workspace_max_writes":4,"window_seconds":120,"cooldown_seconds":10,"max_chain_depth":5})).unwrap();
        assert_eq!(saved["revision"], 2);
        let kept: i64 = fixture
            .store()
            .db
            .query_row(
                "SELECT COUNT(*) FROM write_limit_policies WHERE revision=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1);
        let dir = fixture.dir.clone();
        drop(fixture.store.take());
        fixture.store = Some(Store::open(&dir).unwrap());
        assert_eq!(
            fixture.store().write_limit_policy().unwrap()["max_writes"],
            2
        );
        assert_eq!(fixture.store().write_limit_policy().unwrap()["revision"], 2);
    }

    #[test]
    fn dispatched_delivery_is_ledgered_once_and_waiting_is_not() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let rule =
            json!({"id":"rule-write","workspace_id":4,"start":{"action":{"name":"write_file"}}});
        let event = json!({"id":9,"epoch":1,"chain_id":"chain-a","chain_depth":2});
        store
            .rule_delivery(&rule, &event, &json!({"state":"waiting"}))
            .unwrap();
        store
            .rule_delivery(&rule, &event, &json!({"state":"dispatched"}))
            .unwrap();
        store
            .rule_delivery(&rule, &event, &json!({"state":"dispatched"}))
            .unwrap();
        let (count, depth, action): (i64, i64, String) = store
            .db
            .query_row(
                "SELECT COUNT(*), MAX(chain_depth), MAX(action_key) FROM write_limit_ledger",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(depth, 3);
        assert_eq!(action, "tool:write_file");
    }

    #[test]
    fn schema_33_upgrades_and_backfills_dispatched_writes() {
        let mut fixture = Fixture::new();
        {
            let store = fixture.store();
            store.db.execute("INSERT INTO workspaces(name,path,path_key) VALUES('保留','/tmp/troop-keep','/tmp/troop-keep')", []).unwrap();
            store.db.execute(
                "INSERT INTO automation_rules(id,revision,document) VALUES('rule-write',1,?1)",
                [json!({"id":"rule-write","workspace_id":1,"work_item_id":6,"start":{"action":{"name":"write_file"}}}).to_string()],
            ).unwrap();
            for (key, state, age_seconds, workspace) in [
                ("e1", "dispatched", 120, 1),
                ("e2", "dispatched", 120, 1),
                ("e3", "dispatched", 120, 1),
                ("e4", "skipped", 120, 1),
                ("recent", "dispatched", 10, 2),
                ("old", "dispatched", 4000, 3),
            ] {
                store.db.execute(
                    "INSERT INTO automation_deliveries(rule_id,event_key,workspace_id,created_at,document) VALUES('rule-write',?1,?2,unixepoch()-?3,?4)",
                    params![key, workspace, age_seconds, json!({"state": state}).to_string()],
                ).unwrap();
            }
            store.db.execute_batch("DROP TABLE write_limit_ledger; DROP TABLE write_limit_policies; PRAGMA user_version=33;").unwrap();
        }
        let dir = fixture.dir.clone();
        drop(fixture.store.take());
        fixture.store = Some(Store::open(&dir).unwrap());
        let store = fixture.store();
        let version: i64 = store
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 34);
        assert_eq!(store.list(0).unwrap().items[0].name, "保留");
        assert_eq!(store.write_limit_policy().unwrap()["revision"], 1);
        let (count, object, action): (i64, String, String) = store.db.query_row(
            "SELECT COUNT(*), MIN(object_key), MIN(action_key) FROM write_limit_ledger WHERE workspace_id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(count, 3);
        assert_eq!(object, "work_item:6");
        assert_eq!(action, "tool:write_file");
        assert!(store.rule_frequency_blocked(1).unwrap());
        assert!(store.rule_frequency_blocked(2).unwrap());
        assert!(!store.rule_frequency_blocked(3).unwrap());
    }

    #[test]
    fn incomplete_write_limit_schema_is_rejected_without_migration() {
        let mut fixture = Fixture::new();
        fixture.store().db.execute("INSERT INTO workspaces(name,path,path_key) VALUES('仍在','/tmp/troop-stay','/tmp/troop-stay')", []).unwrap();
        fixture.store().db.execute_batch("DROP TABLE write_limit_ledger; DROP TABLE write_limit_policies; PRAGMA user_version=34;").unwrap();
        let dir = fixture.dir.clone();
        drop(fixture.store.take());
        match Store::open(&dir) {
            Err(error) => assert!(error.contains("Write-limit storage is incomplete")),
            Ok(_) => panic!("incomplete write-limit schema was opened"),
        }
        let db = Connection::open(dir.join("troop.sqlite3")).unwrap();
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 34);
        let name: String = db
            .query_row("SELECT name FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "仍在");
        let ledger: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='write_limit_ledger')", [], |row| row.get(0)).unwrap();
        assert!(!ledger);
    }
}
