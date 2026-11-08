use super::{memory, memory_revisions, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE memory_conflicts(id TEXT NOT NULL,revision INTEGER NOT NULL,agent_id INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TRIGGER memory_conflict_no_update BEFORE UPDATE ON memory_conflicts BEGIN SELECT RAISE(ABORT,'Conflict revisions are immutable'); END;
        CREATE TRIGGER memory_conflict_no_delete BEFORE DELETE ON memory_conflicts BEGIN SELECT RAISE(ABORT,'Conflict revisions are immutable'); END;
        PRAGMA user_version=22; COMMIT;").map_err(|e|e.to_string())
}

fn entry(
    db: &Connection,
    id: i64,
    agent: i64,
    scope: &str,
    project: &str,
) -> Result<Value, String> {
    let raw: String = db.query_row(
        "SELECT json_object('memory_id',m.id,'revision',m.revision,'revision_id',r.id,'protected',json(CASE WHEN m.protected THEN 'true' ELSE 'false' END),'content',m.content,'kind',m.kind,'origin',m.origin,'created_at',json_extract(r.document,'$.created_at')) FROM active_memory_entries m JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision WHERE m.id=?1 AND m.scope=?3 AND m.project=?4 AND ((m.scope='agent' AND m.agent_id=?2) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?2 AND p.project=m.project)))",
        params![id,agent,scope,project],|r|r.get(0),
    ).map_err(|_|"冲突条目已变化，或不在当前维护范围内。")?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub(crate) fn revise(db: &Connection, action: &Value) -> Result<bool, String> {
    let agent = action["agent_id"].as_i64().ok_or("维护 Agent 无效。")?;
    let id = action["memory_id"].as_i64().ok_or("修订身份无效。")?;
    let scope = action["scope"].as_str().unwrap_or("agent");
    let project = action["project"].as_str().unwrap_or("");
    let base = entry(db, id, agent, scope, project)?;
    if base["revision"] != action["expected_revision"] {
        return Err("修订依据已变化。".into());
    }
    let quote = action["evidence_quote"].as_str().unwrap_or("");
    let mut evidence = None;
    for source in action["evidence"].as_array().into_iter().flatten() {
        if quote.chars().count() >= 8
            && source["source_kind"] == "user_task"
            && source["user"]
                .as_str()
                .is_some_and(|text| text.contains(quote))
        {
            let fresh: bool = db
                .query_row(
                    "SELECT COALESCE(julianday(?1)>=julianday(?2),0)",
                    params![source["date"].as_str(), base["created_at"].as_str()],
                    |r| r.get(0),
                )
                .map_err(|error| error.to_string())?;
            if fresh {
                evidence = Some(source);
                break;
            }
        }
    }
    if base["protected"] == true
        || base["origin"] == "explicit"
        || action["validation_approved"] != true
        || evidence.is_none()
    {
        record(db, action)?;
        return Ok(false);
    }
    let mut content = memory::normalize_fact(action["content"].as_str().ok_or("修订正文无效。")?);
    if action["tier"] == "note" && !content.starts_with("[note] ") {
        content = memory::normalize_fact(&format!("[note] {content}"));
    }
    if memory_revisions::is_forgotten(db, agent, scope, project, &content.to_lowercase())? {
        return Err("修订目标命中遗忘保护。".into());
    }
    let mut source = action["source"].clone();
    source["kind"] = json!("maintenance_revision");
    source["from_revision_id"] = base["revision_id"].clone();
    source["evidence_run_id"] = evidence.unwrap()["run_id"].clone();
    source["evidence_quote"] = json!(quote);
    source["validated"] = json!(true);
    db.execute("UPDATE memory_entries SET content=?1,fact_key=?2,kind=?3,revision=revision+1,source_ref=?4 WHERE id=?5",
        params![content,content.to_lowercase(),if action["tier"]=="profile"{"profile"}else{"log"},source.to_string(),id]).map_err(|e|e.to_string())?;
    db.execute(
        "UPDATE memory_agents SET memory_revision=memory_revision+1 WHERE id=?1",
        [agent],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE memory_clock SET revision=revision+1,force_revision=force_revision+1 WHERE id=1",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

pub(crate) fn record(db: &Connection, action: &Value) -> Result<(), String> {
    let agent = action["agent_id"].as_i64().ok_or("维护 Agent 无效。")?;
    let scope = action["scope"].as_str().unwrap_or("agent");
    let project = action["project"].as_str().unwrap_or("");
    let base = entry(
        db,
        action["memory_id"].as_i64().ok_or("冲突条目身份无效。")?,
        agent,
        scope,
        project,
    )?;
    if base["revision"] != action["expected_revision"] {
        return Err("冲突依据已变化，请重新核对。".into());
    }
    let count: i64 = db
        .query_row(
            "SELECT count(DISTINCT id) FROM memory_conflicts WHERE agent_id=?1",
            [agent],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count >= 1000 {
        return Err("当前 Agent 的冲突记录已达到容量上限。".into());
    }
    let (id, now): (String, String) = db
        .query_row(
            "SELECT lower(hex(randomblob(16))),strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut proposal = action.clone();
    let mut content = memory::normalize_fact(action["content"].as_str().ok_or("候选正文无效。")?);
    if action["tier"] == "note" && !content.starts_with("[note] ") {
        content = memory::normalize_fact(&format!("[note] {content}"));
    }
    if memory_revisions::is_forgotten(db, agent, scope, project, &content.to_lowercase())? {
        return Err("候选命中已生效的遗忘保护，请先由用户明确恢复。".into());
    }
    proposal["content"] = json!(content);
    proposal["action"] = json!("write");
    proposal["conflict_candidate"] = json!(true);
    proposal["source"]["kind"] = json!("conflict_candidate");
    proposal["source"]["conflict_id"] = json!(id);
    memory::apply_action(db, &proposal, true)?;
    let candidate = entry(db, db.last_insert_rowid(), agent, scope, project)?;
    let quote = action["evidence_quote"].as_str().unwrap_or("");
    let evidence_verified = !quote.is_empty()
        && action["evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|evidence| {
                evidence["user"]
                    .as_str()
                    .is_some_and(|text| text.contains(quote))
            });
    let document = json!({"id":id,"revision":1,"agent_id":agent,"scope":scope,"project":project,"state":"open",
        "base":base,"candidate":candidate,"source":action["source"],"evidence_quote":action["evidence_quote"],
        "evidence_verified":evidence_verified,
        "reason":"新旧资料需要核对，已保留双方。","created_at":now,"resolution":null});
    db.execute(
        "INSERT INTO memory_conflicts VALUES(?1,1,?2,?3)",
        params![id, agent, document.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

impl Store {
    pub fn memory_conflicts(&self, agent: i64, offset: usize) -> Result<Value, String> {
        self.memory_agent(agent)?;
        if offset > 1_000_000 {
            return Err("冲突分页无效。".into());
        }
        let mut query = self.db.prepare("SELECT document FROM memory_conflicts c WHERE (json_extract(c.document,'$.scope')='user' OR (json_extract(c.document,'$.scope')='agent' AND agent_id=?1) OR (json_extract(c.document,'$.scope')='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=json_extract(c.document,'$.project')))) AND revision=(SELECT max(revision) FROM memory_conflicts WHERE id=c.id) ORDER BY rowid DESC LIMIT 21 OFFSET ?2").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![agent, offset as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut documents = Vec::new();
        for raw in rows {
            let mut document: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let mut reason = "冲突已解决。".to_string();
            let mut allowed = false;
            if document["state"] == "open" {
                let base = entry(
                    &self.db,
                    document["base"]["memory_id"]
                        .as_i64()
                        .ok_or("冲突依据无效。")?,
                    agent,
                    document["scope"].as_str().ok_or("冲突范围无效。")?,
                    document["project"].as_str().unwrap_or(""),
                );
                let candidate = entry(
                    &self.db,
                    document["candidate"]["memory_id"]
                        .as_i64()
                        .ok_or("冲突候选无效。")?,
                    agent,
                    document["scope"].as_str().ok_or("冲突范围无效。")?,
                    document["project"].as_str().unwrap_or(""),
                );
                match (base, candidate) {
                    (Ok(base), Ok(candidate)) => {
                        document["original_base"] = document["base"].clone();
                        document["original_candidate"] = document["candidate"].clone();
                        document["snapshot_changed"] = json!(
                            base["revision_id"] != document["base"]["revision_id"]
                                || candidate["revision_id"] != document["candidate"]["revision_id"]
                        );
                        document["base"] = base;
                        document["candidate"] = candidate;
                        allowed = true;
                        reason.clear();
                    }
                    (Err(error), _) | (_, Err(error)) => reason = error,
                }
            }
            document["allowed_actions"] =
                json!({"resolve":{"allowed":allowed,"reason":if allowed{None}else{Some(reason)}}});
            documents.push(document.to_string());
        }
        super::authorizations::page(documents, offset)
    }

    pub fn memory_resolve(
        &mut self,
        agent: i64,
        id: &str,
        expected: i64,
        base_revision: i64,
        candidate_revision: i64,
        choice: &str,
    ) -> Result<Value, String> {
        if !matches!(choice, "base" | "candidate" | "both") {
            return Err("冲突解决方式无效。".into());
        }
        self.memory_agent(agent)?;
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        let raw: String = tx
            .query_row(
                "SELECT document FROM memory_conflicts WHERE id=?1 ORDER BY revision DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|_| "当前 Agent 无权处理这条冲突。")?;
        let mut conflict: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if conflict["revision"] != expected || conflict["state"] != "open" {
            return Err("冲突已变化或已经解决。".into());
        }
        let base_id = conflict["base"]["memory_id"]
            .as_i64()
            .ok_or("冲突依据无效。")?;
        let candidate_id = conflict["candidate"]["memory_id"]
            .as_i64()
            .ok_or("冲突候选无效。")?;
        let scope = conflict["scope"].as_str().ok_or("冲突范围无效。")?;
        let project = conflict["project"].as_str().unwrap_or("");
        let base = entry(&tx, base_id, agent, scope, project)?;
        let candidate = entry(&tx, candidate_id, agent, scope, project)?;
        if base["revision"] != base_revision || candidate["revision"] != candidate_revision {
            return Err("冲突涉及的记忆已变化，请重新核对。".into());
        }
        let source = json!({"kind":"conflict_resolution","agent_id":agent,"conflict_id":id,"choice":choice,"base_revision_id":base["revision_id"],"candidate_revision_id":candidate["revision_id"],"proposed_base_revision_id":conflict["base"]["revision_id"]});
        if choice == "candidate" {
            if base["content"].as_str().unwrap().to_lowercase()
                != candidate["content"].as_str().unwrap().to_lowercase()
            {
                memory_revisions::protect_forgetting(
                    &tx,
                    agent,
                    scope,
                    project,
                    &base["content"].as_str().unwrap().to_lowercase(),
                    Some(base_id),
                    &source.to_string(),
                )?;
            }
            tx.execute("UPDATE memory_entries SET content=?1,fact_key=?2,kind=?3,protected=1,origin='explicit',source_ref=?4,revision=revision+1 WHERE id=?5",
                params![candidate["content"].as_str(),candidate["content"].as_str().unwrap().to_lowercase(),candidate["kind"].as_str(),source.to_string(),base_id]).map_err(|e|e.to_string())?;
        }
        if choice == "base" {
            tx.execute("UPDATE memory_entries SET protected=1,origin='explicit',source_ref=?2,revision=revision+1 WHERE id=?1", params![base_id,source.to_string()]).map_err(|error|error.to_string())?;
        }
        if choice != "both" {
            tx.execute(
                "UPDATE memory_entries SET deleted=1,revision=revision+1,source_ref=?2 WHERE id=?1",
                params![candidate_id, source.to_string()],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute("UPDATE memory_entries SET protected=1,origin='explicit',revision=revision+1,source_ref=?3 WHERE id IN (?1,?2)",params![base_id,candidate_id,source.to_string()]).map_err(|e|e.to_string())?;
        }
        let current = entry(&tx, base_id, agent, scope, project)?;
        let candidate_result = if choice == "both" {
            entry(&tx, candidate_id, agent, scope, project)?
        } else {
            Value::Null
        };
        conflict["state"] = json!("resolved");
        conflict["revision"] = json!(expected + 1);
        conflict["resolution"] = json!({"choice":choice,"source":source,"revision_id":current["revision_id"],"result":current,
            "candidate_result":candidate_result});
        tx.execute(
            "INSERT INTO memory_conflicts VALUES(?1,?2,?3,?4)",
            params![
                id,
                expected + 1,
                conflict["agent_id"].as_i64(),
                conflict.to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE memory_agents SET memory_revision=memory_revision+1 WHERE id=?1",
            [agent],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE memory_clock SET revision=revision+1,force_revision=force_revision+1 WHERE id=1",[]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(conflict)
    }
}
