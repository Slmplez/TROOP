use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate_identity(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE memory_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER NOT NULL REFERENCES memory_agents(id),scope TEXT NOT NULL,project TEXT NOT NULL DEFAULT '',fact_key TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),protected INTEGER NOT NULL DEFAULT 0,source_ref TEXT NOT NULL DEFAULT '{\"kind\":\"legacy_unknown\"}');
        INSERT INTO memory_entries SELECT * FROM memories;
        CREATE INDEX memory_entry_keys ON memory_entries(scope,project,fact_key,agent_id);
        CREATE VIEW active_memory_entries AS SELECT m.* FROM memory_entries m WHERE m.deleted=0 AND NOT EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.scope=m.scope AND f.owner=CASE WHEN m.scope='agent' THEN m.agent_id ELSE 0 END AND f.project=m.project AND f.fact_key=m.fact_key);
        CREATE TRIGGER memory_entry_insert AFTER INSERT ON memory_entries BEGIN
          INSERT INTO memory_revisions(memory_id,revision,document) VALUES(NEW.id,NEW.revision,
            json_object('memory_id',NEW.id,'revision',NEW.revision,'agent_id',NEW.agent_id,'scope',NEW.scope,'project',NEW.project,'content',NEW.content,'kind',NEW.kind,'origin',NEW.origin,'deleted',json(CASE WHEN NEW.deleted THEN 'true' ELSE 'false' END),'protected',json(CASE WHEN NEW.protected THEN 'true' ELSE 'false' END),'source',json(NEW.source_ref),'history_completeness','complete','created_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        END;
        CREATE TRIGGER memory_entry_update AFTER UPDATE ON memory_entries WHEN NEW.revision<>OLD.revision BEGIN
          INSERT INTO memory_revisions(memory_id,revision,previous_revision_id,document)
            SELECT NEW.id,NEW.revision,id,json_object('memory_id',NEW.id,'revision',NEW.revision,'agent_id',NEW.agent_id,'scope',NEW.scope,'project',NEW.project,'content',NEW.content,'kind',NEW.kind,'origin',NEW.origin,'deleted',json(CASE WHEN NEW.deleted THEN 'true' ELSE 'false' END),'protected',json(CASE WHEN NEW.protected THEN 'true' ELSE 'false' END),'source',json(NEW.source_ref),'history_completeness',json_extract(document,'$.history_completeness'),'created_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            FROM memory_revisions WHERE memory_id=OLD.id ORDER BY revision DESC LIMIT 1;
        END;
        CREATE TRIGGER memory_legacy_no_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'Legacy memory archive is read-only'); END;
        CREATE TRIGGER memory_legacy_no_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT,'Legacy memory archive is read-only'); END;
        CREATE TRIGGER memory_legacy_no_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'Legacy memory archive is read-only'); END;
        PRAGMA user_version=21; COMMIT;").map_err(|e|e.to_string())
}

pub(super) fn migrate_forgetting(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE memory_forgetting(scope TEXT NOT NULL,owner INTEGER NOT NULL,project TEXT NOT NULL,fact_key TEXT NOT NULL,memory_id INTEGER,source_ref TEXT NOT NULL,PRIMARY KEY(scope,owner,project,fact_key));
        INSERT INTO memory_forgetting SELECT scope,CASE WHEN scope='agent' THEN agent_id ELSE 0 END,project,fact_key,NULL,json_object('kind','legacy_forgetting','authors',json_group_array(agent_id)) FROM memory_tombstones GROUP BY scope,CASE WHEN scope='agent' THEN agent_id ELSE 0 END,project,fact_key;
        PRAGMA user_version=19; COMMIT;").map_err(|e|e.to_string())
}
pub(super) fn migrate_visibility(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        UPDATE memories AS m SET deleted=1,revision=revision+1,source_ref=json_object('kind','legacy_forgetting','reason','scope_protection') WHERE deleted=0 AND EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.scope=m.scope AND f.owner=CASE WHEN m.scope='agent' THEN m.agent_id ELSE 0 END AND f.project=m.project AND f.fact_key=m.fact_key);
        CREATE VIEW active_memories AS SELECT m.* FROM memories m WHERE m.deleted=0 AND NOT EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.scope=m.scope AND f.owner=CASE WHEN m.scope='agent' THEN m.agent_id ELSE 0 END AND f.project=m.project AND f.fact_key=m.fact_key);
        UPDATE memory_clock SET revision=revision+1,force_revision=force_revision+1 WHERE id=1 AND changes()>0;
        PRAGMA user_version=20; COMMIT;").map_err(|e|e.to_string())
}

pub(crate) fn is_forgotten(
    db: &Connection,
    agent: i64,
    scope: &str,
    project: &str,
    key: &str,
) -> Result<bool, String> {
    let owner = if scope == "agent" { agent } else { 0 };
    db.query_row("SELECT EXISTS(SELECT 1 FROM memory_forgetting WHERE scope=?1 AND owner=?2 AND project=?3 AND fact_key=?4)",
        params![scope,owner,project,key], |r|r.get(0)).map_err(|e|e.to_string())
}

pub(crate) fn protect_forgetting(
    db: &Connection,
    agent: i64,
    scope: &str,
    project: &str,
    key: &str,
    memory: Option<i64>,
    source: &str,
) -> Result<(), String> {
    let owner = if scope == "agent" { agent } else { 0 };
    db.execute("INSERT INTO memory_forgetting VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(scope,owner,project,fact_key) DO UPDATE SET memory_id=excluded.memory_id,source_ref=excluded.source_ref",
        params![scope,owner,project,key,memory,source]).map_err(|e|e.to_string())?;
    db.execute("UPDATE memory_entries SET deleted=1,revision=revision+1,source_ref=?5 WHERE scope=?1 AND project=?2 AND fact_key=?3 AND (?1<>'agent' OR agent_id=?4) AND id<>COALESCE(?6,-1) AND deleted=0",
        params![scope,project,key,agent,source,memory]).map(|_|()).map_err(|e|e.to_string())
}

pub(crate) fn forget_memory(
    db: &Connection,
    agent: i64,
    scope: &str,
    project: &str,
    key: &str,
    memory: Option<i64>,
    source: &str,
) -> Result<(), String> {
    let mut query = db
        .prepare(
            "SELECT json_extract(document,'$.content') FROM memory_revisions WHERE memory_id=?1",
        )
        .map_err(|e| e.to_string())?;
    let mut aliases = query
        .query_map([memory], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|content| super::memory::normalize_fact(&content).to_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    aliases.insert(key.into());
    for alias in aliases {
        protect_forgetting(db, agent, scope, project, &alias, memory, source)?;
        db.execute("UPDATE memory_entries SET deleted=1,revision=revision+1,source_ref=?5 WHERE scope=?1 AND project=?2 AND fact_key=?3 AND (?1<>'agent' OR agent_id=?4) AND deleted=0",
            params![scope,project,alias,agent,source]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        ALTER TABLE memories ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE memories ADD COLUMN source_ref TEXT NOT NULL DEFAULT '{\"kind\":\"legacy_unknown\"}';
        UPDATE memories SET protected=(origin='explicit'),source_ref=json_object('kind','legacy','legacy_id',id);
        CREATE TABLE memory_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,memory_id INTEGER NOT NULL,revision INTEGER NOT NULL,previous_revision_id INTEGER,document TEXT NOT NULL,UNIQUE(memory_id,revision));
        INSERT INTO memory_revisions(memory_id,revision,document)
          SELECT id,revision,json_object('memory_id',id,'revision',revision,'agent_id',agent_id,'scope',scope,'project',project,'content',content,'kind',kind,'origin',origin,'deleted',json(CASE WHEN deleted THEN 'true' ELSE 'false' END),'protected',json(CASE WHEN protected THEN 'true' ELSE 'false' END),'source',json_object('kind','legacy','legacy_id',id),'history_completeness','baseline_only','created_at',created_at) FROM memories;
        CREATE TRIGGER memory_revision_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memory_revisions(memory_id,revision,document) VALUES(NEW.id,NEW.revision,
            json_object('memory_id',NEW.id,'revision',NEW.revision,'agent_id',NEW.agent_id,'scope',NEW.scope,'project',NEW.project,'content',NEW.content,'kind',NEW.kind,'origin',NEW.origin,'deleted',json(CASE WHEN NEW.deleted THEN 'true' ELSE 'false' END),'protected',json(CASE WHEN NEW.protected THEN 'true' ELSE 'false' END),'source',json(NEW.source_ref),'history_completeness','complete','created_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        END;
        CREATE TRIGGER memory_revision_update AFTER UPDATE ON memories WHEN NEW.revision<>OLD.revision BEGIN
          INSERT INTO memory_revisions(memory_id,revision,previous_revision_id,document)
            SELECT NEW.id,NEW.revision,id,json_object('memory_id',NEW.id,'revision',NEW.revision,'agent_id',NEW.agent_id,'scope',NEW.scope,'project',NEW.project,'content',NEW.content,'kind',NEW.kind,'origin',NEW.origin,'deleted',json(CASE WHEN NEW.deleted THEN 'true' ELSE 'false' END),'protected',json(CASE WHEN NEW.protected THEN 'true' ELSE 'false' END),'source',json(NEW.source_ref),'history_completeness',json_extract(document,'$.history_completeness'),'created_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            FROM memory_revisions WHERE memory_id=OLD.id ORDER BY revision DESC LIMIT 1;
        END;
        CREATE TRIGGER memory_revision_no_update BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable'); END;
        CREATE TRIGGER memory_revision_no_delete BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable'); END;
        PRAGMA user_version=18; COMMIT;").map_err(|e|e.to_string())
}

impl Store {
    pub fn memory_usage(
        &self,
        run_id: i64,
        request_id: Option<i64>,
        before: Option<i64>,
        offset: usize,
    ) -> Result<Value, String> {
        let run = self.agent_run(run_id)?;
        let agent = run["agent_id"].as_i64().unwrap_or(1);
        let event_kind = if run["kind"] == "external_cli" {
            "cli_dispatched"
        } else {
            "model_started"
        };
        self.memory_agent(agent)?;
        let mut query = self.db.prepare("SELECT id,epoch,created_at,payload FROM agent_events WHERE run_id=?1 AND kind=?3 AND id<?2 ORDER BY id DESC LIMIT 21").map_err(|error|error.to_string())?;
        let rows = query
            .query_map(
                params![run_id, before.unwrap_or(i64::MAX), event_kind],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut requests = Vec::new();
        for (id, epoch, created_at, raw) in rows.iter().take(20) {
            let payload: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
            requests.push(json!({"id":id,"epoch":epoch,"step":payload["step"],"attempt":payload["attempt"],"created_at":created_at}));
        }
        let selected = request_id.or_else(|| rows.first().map(|row| row.0));
        let record: Option<(i64, String)> = match selected {
            Some(id) => self
                .db
                .query_row(
                    "SELECT epoch,payload FROM agent_events WHERE id=?1 AND run_id=?2 AND kind=?3",
                    params![id, run_id, event_kind],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?,
            None => None,
        };
        if selected.is_some() && record.is_none() {
            return Err("模型请求记录不属于当前执行。".into());
        }
        let mut epoch = Value::Null;
        let mut visible = Vec::new();
        let mut evidence = "historical_sources_unavailable";
        if let Some((generation, raw)) = record {
            epoch = json!(generation);
            let payload: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            if let Some(sources) = payload["memory_sources"].as_array() {
                evidence = if event_kind == "cli_dispatched" {
                    "prepared_cli_prompt"
                } else {
                    "prepared_model_request"
                };
                for source in sources {
                    let allowed: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM memory_entries m WHERE m.id=?1 AND ((m.scope='agent' AND m.agent_id=?2) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?2 AND p.project=m.project))))",params![source["memory_id"].as_i64(),agent],|row|row.get(0)).map_err(|error|error.to_string())?;
                    if allowed {
                        visible.push(source.clone());
                    }
                }
            }
        }
        let page = super::authorizations::page(
            visible
                .iter()
                .skip(offset)
                .take(21)
                .map(Value::to_string)
                .collect(),
            offset,
        )?;
        Ok(
            json!({"run_id":run_id,"epoch":epoch,"request_id":selected,"requests":requests,
            "next_before":if rows.len()>20{requests.last().map(|request|request["id"].clone())}else{None},
            "items":page["items"],"evidence":evidence,"next_offset":page["next_offset"]}),
        )
    }
    pub fn memory_history(&self, agent: i64, id: i64, offset: usize) -> Result<Value, String> {
        if offset > 1_000_000 {
            return Err("记忆历史分页无效。".into());
        }
        let visible: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_entries m WHERE m.id=?2 AND ((m.scope='agent' AND m.agent_id=?1) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=m.project))))",
            params![agent,id], |r|r.get(0),
        ).map_err(|e|e.to_string())?;
        self.memory_agent(agent)?;
        if !visible {
            return Err("当前 Agent 无权查看这条记忆的历史。".into());
        }
        let mut query = self.db.prepare(
            "SELECT id,previous_revision_id,document FROM memory_revisions WHERE memory_id=?1 ORDER BY revision DESC LIMIT 21 OFFSET ?2",
        ).map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![id, offset as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (revision, previous, raw) = row.map_err(|e| e.to_string())?;
            let mut document: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            document["revision_id"] = json!(revision);
            document["previous_revision_id"] = json!(previous);
            items.push(document);
        }
        let more = items.len() > 20;
        items.truncate(20);
        let (scope, project, key, author, revision, deleted): (
            String,
            String,
            String,
            i64,
            i64,
            bool,
        ) = self
            .db
            .query_row(
                "SELECT scope,project,fact_key,agent_id,revision,deleted FROM memory_entries WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let forgotten = is_forgotten(&self.db, author, &scope, &project, &key)?;
        let older: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_revisions WHERE memory_id=?1 AND revision<?2)",
                params![id, revision],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"items":items,"current_revision":revision,"allowed_actions":{"restore_revision":{"allowed":older,"reason":if older{None}else{Some("暂无可证明的较早修订。")}},"restore":{"allowed":deleted,"reason":if deleted{None}else{Some("当前记忆仍在使用，无需恢复。")}}},"forgetting":{"active":forgotten,"scope":scope,"project":project},"next_offset":if more{Some(offset+20)}else{None}}),
        )
    }

    pub fn memory_restore(
        &mut self,
        agent: i64,
        id: i64,
        expected: i64,
        revision_id: Option<i64>,
    ) -> Result<(), String> {
        self.memory_history(agent, id, 0)?;
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        let (author, scope, project, revision, deleted, content, kind): (i64, String, String, i64, bool, String, String) = tx.query_row(
            "SELECT agent_id,scope,project,revision,deleted,content,kind FROM memory_entries WHERE id=?1", [id],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
        ).map_err(|e|e.to_string())?;
        if revision != expected {
            return Err("记忆已变化，请刷新后恢复。".into());
        }
        let selected = if let Some(revision_id) = revision_id {
            let raw: String = tx
                .query_row(
                    "SELECT document FROM memory_revisions WHERE memory_id=?1 AND id=?2",
                    params![id, revision_id],
                    |r| r.get(0),
                )
                .map_err(|_| "目标修订不属于这条记忆。")?;
            serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?
        } else {
            if !deleted {
                return Err("当前记忆无需恢复，请选择明确的历史修订。".into());
            }
            json!({"content":content,"kind":kind})
        };
        let next =
            super::memory::normalize_fact(selected["content"].as_str().ok_or("修订正文无效。")?);
        if next.is_empty() {
            return Err("修订正文为空。".into());
        }
        let source = json!({"kind":"user_command","agent_id":agent,"action":"restore","restored_from_revision_id":revision_id}).to_string();
        if content.to_lowercase() != next.to_lowercase() {
            protect_forgetting(
                &tx,
                author,
                &scope,
                &project,
                &content.to_lowercase(),
                Some(id),
                &source,
            )?;
        }
        let owner = if scope == "agent" { author } else { 0 };
        tx.execute("DELETE FROM memory_forgetting WHERE scope=?1 AND owner=?2 AND project=?3 AND fact_key=?4",
            params![scope,owner,project,next.to_lowercase()]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE memory_entries SET deleted=0,protected=1,origin='explicit',revision=revision+1,source_ref=?2,content=?3,fact_key=?4,kind=?5 WHERE id=?1",
            params![id,source,next,next.to_lowercase(),selected["kind"].as_str().ok_or("修订类别无效。")?]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE memory_agents SET memory_revision=memory_revision+1 WHERE id=?1",
            [author],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE memory_clock SET revision=revision+1,force_revision=force_revision+1 WHERE id=1",[]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
}
