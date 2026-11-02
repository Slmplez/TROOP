use super::Store;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE memory_agents(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,automatic INTEGER NOT NULL DEFAULT 1,dreaming INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,memory_revision INTEGER NOT NULL DEFAULT 1);
      INSERT INTO memory_agents(id,name) VALUES(1,'Default Agent');
      CREATE TABLE memory_projects(slug TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE memory_members(agent_id INTEGER NOT NULL REFERENCES memory_agents(id),project TEXT NOT NULL REFERENCES memory_projects(slug),PRIMARY KEY(agent_id,project));
      CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER NOT NULL REFERENCES memory_agents(id),scope TEXT NOT NULL,project TEXT NOT NULL DEFAULT '',fact_key TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),UNIQUE(agent_id,scope,project,fact_key));
      CREATE TABLE memory_tombstones(agent_id INTEGER NOT NULL,scope TEXT NOT NULL,project TEXT NOT NULL,fact_key TEXT NOT NULL,PRIMARY KEY(agent_id,scope,project,fact_key));
      CREATE TABLE memory_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,force_revision INTEGER NOT NULL);
      INSERT INTO memory_clock VALUES(1,1,1);
      CREATE TABLE memory_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,source_key TEXT NOT NULL UNIQUE,agent_id INTEGER NOT NULL REFERENCES memory_agents(id),document TEXT NOT NULL);
      CREATE TABLE memory_evidence(run_id INTEGER PRIMARY KEY REFERENCES agent_runs(id),agent_id INTEGER NOT NULL REFERENCES memory_agents(id),document TEXT NOT NULL);
      CREATE TABLE context_checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES agent_runs(id),epoch INTEGER NOT NULL,document TEXT NOT NULL);
      UPDATE agent_runs SET document=json_set(document,'$.agent_id',1) WHERE json_extract(document,'$.agent_id') IS NULL;
      PRAGMA user_version=5; COMMIT;").map_err(|e|e.to_string())
}
pub fn normalize_fact(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}
pub fn slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn clock(tx: &Transaction, explicit: bool) -> Result<(), String> {
    tx.execute(
        "UPDATE memory_clock SET revision=revision+1,force_revision=force_revision+?1 WHERE id=1",
        [i32::from(explicit)],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
pub(crate) fn apply_action(tx: &Transaction, a: &Value, automatic: bool) -> Result<(), String> {
    let agent = a["agent_id"].as_i64().ok_or("Invalid Agent identity")?;
    let target = a["target"].as_str().unwrap_or("memory");
    let action = a["action"].as_str().unwrap_or("");
    let scope = a["scope"].as_str().unwrap_or("agent");
    let project = a["project"].as_str().unwrap_or("");
    tx.query_row("SELECT id FROM memory_agents WHERE id=?1", [agent], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|_| "Agent does not exist")?;
    if target == "project" {
        if automatic || !slug(project) {
            return Err("Invalid project membership action".into());
        }
        match action {
            "create" => {
                let count: i64 = tx
                    .query_row("SELECT count(*) FROM memory_projects", [], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                if count >= 128
                    && !tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM memory_projects WHERE slug=?1)",
                            [project],
                            |r| r.get::<_, bool>(0),
                        )
                        .map_err(|e| e.to_string())?
                {
                    return Err("Project capacity reached".into());
                }
                tx.execute(
                    "INSERT OR IGNORE INTO memory_projects(slug,name) VALUES(?1,?1)",
                    [project],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT OR IGNORE INTO memory_members VALUES(?1,?2)",
                    params![agent, project],
                )
                .map_err(|e| e.to_string())?;
            }
            "join" => {
                tx.execute(
                    "INSERT OR IGNORE INTO memory_members VALUES(?1,?2)",
                    params![agent, project],
                )
                .map_err(|_| "Project does not exist")?;
            }
            "leave" => {
                tx.execute(
                    "DELETE FROM memory_members WHERE agent_id=?1 AND project=?2",
                    params![agent, project],
                )
                .map_err(|e| e.to_string())?;
            }
            _ => return Err("Invalid project action".into()),
        }
        return clock(tx, true);
    }
    if target != "memory" || !matches!(scope, "agent" | "user" | "project") {
        return Err("Invalid memory scope".into());
    }
    if scope == "project" {
        if !slug(project)||(a["human"]!=true && !tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_members WHERE agent_id=?1 AND project=?2)",params![agent,project],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?){return Err("Agent has not joined this project".into());}
    } else if !project.is_empty() {
        return Err("Project must be empty outside project scope".into());
    }
    let mut content = normalize_fact(a["content"].as_str().unwrap_or(""));
    let tier = a["tier"].as_str().unwrap_or("profile");
    if action == "write" && tier == "note" && !content.starts_with("[note] ") {
        content = normalize_fact(&format!("[note] {content}"));
    }
    if content.is_empty() || content.chars().any(|c| c.is_control()) {
        return Err("Memory content is empty or invalid".into());
    }
    let key = content.to_lowercase();
    let old:Option<(i64,String)>=tx.query_row("SELECT id,origin FROM memories WHERE agent_id=?1 AND scope=?2 AND project=?3 AND fact_key=?4",params![agent,scope,project,key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    if automatic && (old.as_ref().is_some_and(|(_,origin)|origin=="explicit")||tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_tombstones WHERE agent_id=?1 AND scope=?2 AND project=?3 AND fact_key=?4)",params![agent,scope,project,key],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?){return Ok(());}
    match action {
        "write" => {
            if !matches!(tier, "profile" | "log" | "note") {
                return Err("Invalid memory tier".into());
            }
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM memories WHERE agent_id=?1",
                    [agent],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if old.is_none() && count >= 2000 {
                return Err("Agent memory capacity reached".into());
            }
            if !automatic {
                tx.execute("DELETE FROM memory_tombstones WHERE agent_id=?1 AND scope=?2 AND project=?3 AND fact_key=?4",params![agent,scope,project,key]).map_err(|e|e.to_string())?;
            }
            tx.execute("INSERT INTO memories(agent_id,scope,project,fact_key,content,kind,origin) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(agent_id,scope,project,fact_key) DO UPDATE SET deleted=0,revision=memories.revision+1,content=CASE WHEN excluded.origin='explicit' THEN excluded.content ELSE memories.content END,kind=CASE WHEN excluded.origin='explicit' THEN excluded.kind ELSE memories.kind END,origin=CASE WHEN excluded.origin='explicit' THEN 'explicit' ELSE memories.origin END",params![agent,scope,project,key,content,if tier=="profile"{"profile"}else{"log"},if automatic{"synthesis"}else{"explicit"}]).map_err(|e|e.to_string())?;
        }
        "forget" => {
            tx.execute("UPDATE memories SET deleted=1,revision=revision+1 WHERE agent_id=?1 AND scope=?2 AND project=?3 AND fact_key=?4",params![agent,scope,project,key]).map_err(|e|e.to_string())?;
            if !automatic {
                tx.execute(
                    "INSERT OR IGNORE INTO memory_tombstones VALUES(?1,?2,?3,?4)",
                    params![agent, scope, project, key],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("Invalid memory action".into()),
    }
    if scope == "agent" {
        tx.execute(
            "UPDATE memory_agents SET memory_revision=memory_revision+1 WHERE id=?1",
            [agent],
        )
        .map_err(|e| e.to_string())?;
    }
    clock(tx, !automatic)
}
impl Store {
    pub fn memory_search(
        &self,
        agent: i64,
        scope: &str,
        project: &str,
        text: &str,
    ) -> Result<Vec<Value>, String> {
        self.memory_agent(agent)?;
        let mut q=self.db.prepare("SELECT m.id FROM memories m WHERE m.deleted=0 AND (?2='' OR m.scope=?2) AND (?3='' OR m.project=?3) AND instr(m.fact_key,?4)>0 AND ((m.scope='agent' AND m.agent_id=?1) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=m.project))) ORDER BY m.id DESC LIMIT 12").map_err(|e|e.to_string())?;
        let ids = q
            .query_map(params![agent, scope, project, text.to_lowercase()], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter()
            .map(|id| self.memory_visible_entry(agent, id))
            .collect()
    }
    fn memory_scope(
        &self,
        agent: i64,
        scope: &str,
        project: &str,
        profiles: i64,
        recent: i64,
    ) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        for (kind, limit) in [("profile", profiles), ("log", recent)] {
            let mut q=self.db.prepare("SELECT m.id FROM memories m WHERE m.deleted=0 AND m.scope=?2 AND m.project=?3 AND m.kind=?4 AND ((m.scope='agent' AND m.agent_id=?1) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=m.project))) ORDER BY (julianday(m.created_at)/30+CASE WHEN m.content LIKE '[episode] %' THEN 0.5849625 WHEN m.content LIKE '[note] %' THEN -1 ELSE 0 END) DESC,m.id DESC LIMIT ?5").map_err(|e|e.to_string())?;
            let ids = q
                .query_map(params![agent, scope, project, kind, limit], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for id in ids {
                out.push(self.memory_visible_entry(agent, id)?);
            }
        }
        Ok(out)
    }
    pub fn memory_snapshot_rows(&self, agent: i64) -> Result<Vec<Value>, String> {
        self.memory_agent(agent)?;
        let mut rows = self.memory_scope(agent, "agent", "", 100, 30)?;
        rows.extend(self.memory_scope(agent, "user", "", 50, 15)?);
        for project in self
            .memory_projects(agent)?
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["joined"] == true)
            .take(3)
        {
            rows.extend(self.memory_scope(
                agent,
                "project",
                project["slug"].as_str().unwrap(),
                25,
                10,
            )?);
        }
        Ok(rows)
    }
    pub fn memory_private_revision(&self, agent: i64) -> Result<(i64, i64), String> {
        self.db
            .query_row(
                "SELECT memory_revision,revision FROM memory_agents WHERE id=?1",
                [agent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())
    }
    fn memory_visible_entry(&self, agent: i64, id: i64) -> Result<Value, String> {
        let raw:String=self.db.query_row("SELECT json_object('id',m.id,'agent_id',m.agent_id,'agent_name',a.name,'scope',m.scope,'project',m.project,'content',m.content,'kind',m.kind,'origin',m.origin,'revision',m.revision,'created_at',m.created_at,'month',substr(m.created_at,1,7)) FROM memories m JOIN memory_agents a ON a.id=m.agent_id WHERE m.id=?2 AND m.deleted=0 AND ((m.scope='agent' AND m.agent_id=?1) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=m.project)))",params![agent,id],|r|r.get(0)).map_err(|_|"Memory is not visible to this Agent")?;
        serde_json::from_str(&raw).map_err(|_| "Invalid memory record".into())
    }
    pub fn memory_list(&self, agent: i64, offset: usize) -> Result<Value, String> {
        self.memory_agent(agent)?;
        let filter="m.deleted=0 AND ((m.scope='agent' AND m.agent_id=?1) OR m.scope='user' OR (m.scope='project' AND EXISTS(SELECT 1 FROM memory_members p WHERE p.agent_id=?1 AND p.project=m.project)))";
        let total: i64 = self
            .db
            .query_row(
                &format!("SELECT count(*) FROM memories m WHERE {filter}"),
                [agent],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut query = self
            .db
            .prepare(&format!(
                "SELECT m.id FROM memories m WHERE {filter} ORDER BY m.id DESC LIMIT 20 OFFSET ?2"
            ))
            .map_err(|e| e.to_string())?;
        let ids = query
            .query_map(params![agent, offset as i64], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let items = ids
            .into_iter()
            .map(|id| self.memory_visible_entry(agent, id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            json!({"items":items,"total":total,"next_offset":if(offset as i64)+20<total{Some(offset+20)}else{None}}),
        )
    }
    pub fn memory_synthesis_due(&self, agent: i64) -> Result<bool, String> {
        self.db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_jobs WHERE agent_id=?1 AND json_extract(document,'$.kind')='synthesis' AND julianday('now')-julianday(json_extract(document,'$.created_at'))<1)",[agent],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub fn memory_validate_action(&mut self, a: &Value) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let result = apply_action(&tx, a, false);
        tx.rollback().map_err(|e| e.to_string())?;
        result
    }
    pub fn memory_agent(&self, id: i64) -> Result<Value, String> {
        self.db.query_row("SELECT id,name,automatic,dreaming,revision FROM memory_agents WHERE id=?1",[id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"automatic":r.get::<_,bool>(2)?,"dreaming":r.get::<_,bool>(3)?,"revision":r.get::<_,i64>(4)?}))).map_err(|_|"Agent does not exist".into())
    }
    pub fn memory_agents(&self) -> Result<Value, String> {
        let mut q = self
            .db
            .prepare("SELECT id FROM memory_agents ORDER BY id LIMIT 32")
            .map_err(|e| e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!(ids
            .into_iter()
            .map(|id| self.memory_agent(id))
            .collect::<Result<Vec<_>, _>>()?))
    }
    pub fn memory_agent_save(
        &mut self,
        id: Option<i64>,
        name: &str,
        automatic: bool,
        dreaming: bool,
        expected: i64,
    ) -> Result<Value, String> {
        if name.trim().is_empty() || name.len() > 120 {
            return Err("Invalid Agent name".into());
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let id = if let Some(id) = id {
            if tx.execute("UPDATE memory_agents SET name=?1,automatic=?2,dreaming=?3,revision=revision+1 WHERE id=?4 AND revision=?5",params![name.trim(),automatic,dreaming,id,expected]).map_err(|e|e.to_string())?!=1{return Err("Agent settings changed; refresh before saving".into());}
            id
        } else {
            let count: i64 = tx
                .query_row("SELECT count(*) FROM memory_agents", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if count >= 32 {
                return Err("Agent capacity reached".into());
            }
            tx.execute(
                "INSERT INTO memory_agents(name,automatic,dreaming) VALUES(?1,?2,?3)",
                params![name.trim(), automatic, dreaming],
            )
            .map_err(|e| e.to_string())?;
            tx.last_insert_rowid()
        };
        clock(&tx, true)?;
        tx.commit().map_err(|e| e.to_string())?;
        self.memory_agent(id)
    }
    pub fn memory_clock(&self) -> Result<(i64, i64), String> {
        self.db
            .query_row(
                "SELECT revision,force_revision FROM memory_clock WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())
    }
    pub fn memory_projects(&self, agent: i64) -> Result<Value, String> {
        self.memory_agent(agent)?;
        let mut q=self.db.prepare("SELECT p.slug,p.name,EXISTS(SELECT 1 FROM memory_members m WHERE m.agent_id=?1 AND m.project=p.slug) FROM memory_projects p ORDER BY p.slug LIMIT 128").map_err(|e|e.to_string())?;
        let rows=q.query_map([agent],|r|Ok(json!({"slug":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"joined":r.get::<_,bool>(2)?}))).map_err(|e|e.to_string())?;
        Ok(json!(rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?))
    }
    pub fn memory_action(&mut self, a: &Value) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        apply_action(&tx, a, false)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn memory_edit(
        &mut self,
        agent: i64,
        id: i64,
        expected: i64,
        content: Option<&str>,
    ) -> Result<(), String> {
        let old = self.memory_visible_entry(agent, id)?;
        if old["revision"] != expected {
            return Err("Memory version changed; refresh before editing".into());
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let base = json!({"agent_id":old["agent_id"],"scope":old["scope"],"project":old["project"],"target":"memory","action":"forget","tier":old["kind"],"content":old["content"],"human":true});
        apply_action(&tx, &base, false)?;
        if let Some(content) = content {
            let mut next = base;
            next["action"] = json!("write");
            next["content"] = json!(content);
            apply_action(&tx, &next, false)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn memory_private(&self, agent: i64) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT id FROM memories WHERE agent_id=?1 AND scope='agent' AND deleted=0 ORDER BY CASE WHEN origin='explicit' THEN 1 ELSE 0 END DESC,CASE WHEN kind='profile' THEN 1 ELSE 0 END DESC,id DESC LIMIT 500").map_err(|e|e.to_string())?;
        let ids = q
            .query_map([agent], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter()
            .map(|id| self.memory_visible_entry(agent, id))
            .collect()
    }
    pub fn memory_job(&self, id: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row("SELECT document FROM memory_jobs WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "Maintenance job does not exist")?;
        serde_json::from_str(&raw).map_err(|_| "Invalid maintenance record".into())
    }
    pub fn memory_jobs(&self, agent: i64) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM memory_jobs WHERE agent_id=?1 ORDER BY id DESC LIMIT 50")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([agent], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string()).and_then(|raw| {
                serde_json::from_str(&raw).map_err(|_| "Invalid maintenance record".into())
            })
        })
        .collect()
    }
    pub fn memory_job_create(&mut self, key: &str, doc: &mut Value) -> Result<bool, String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let now: String = tx
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        doc["created_at"] = json!(now);
        if tx.execute("INSERT OR IGNORE INTO memory_jobs(source_key,agent_id,document) VALUES(?1,?2,'{}')",params![key,doc["agent_id"].as_i64()]).map_err(|e|e.to_string())?==0{return Ok(false);}
        doc["id"] = json!(tx.last_insert_rowid());
        tx.execute(
            "UPDATE memory_jobs SET document=?1 WHERE id=?2",
            params![doc.to_string(), doc["id"].as_i64()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn memory_job_save(&mut self, doc: &Value) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE memory_jobs SET document=?1 WHERE id=?2",
                params![doc.to_string(), doc["id"].as_i64()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn memory_apply_job(&mut self, job: &mut Value, changes: &Value) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let (rev, settings): (i64, i64) = tx
            .query_row(
                "SELECT memory_revision,revision FROM memory_agents WHERE id=?1",
                [job["agent_id"].as_i64()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if job["memory_revision"] != rev || job["agent_revision"] != settings {
            return Err("Memory snapshot changed; proposal was not applied".into());
        }
        let mut applied = 0;
        for change in changes.as_array().ok_or("Expected memory changes")? {
            let mut action = change.clone();
            action["agent_id"] = job["agent_id"].clone();
            action["target"] = json!("memory");
            action["scope"] = json!("agent");
            action["project"] = json!("");
            let before: i64 = tx
                .query_row("SELECT total_changes()", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            apply_action(&tx, &action, true)?;
            let after: i64 = tx
                .query_row("SELECT total_changes()", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            applied += i64::from(after > before);
        }
        job["state"] = json!("completed");
        job["applied"] = json!(applied);
        job["processed"] = json!(changes.as_array().unwrap().len());
        tx.execute(
            "UPDATE memory_jobs SET document=?1 WHERE id=?2",
            params![job.to_string(), job["id"].as_i64()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn memory_evidence_add(&mut self, run: i64, agent: i64, doc: &Value) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO memory_evidence VALUES(?1,?2,?3)",
                params![run, agent, doc.to_string()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn memory_evidence(&self, agent: i64) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT document FROM memory_evidence WHERE agent_id=?1 ORDER BY json_extract(document,'$.date') DESC,run_id DESC LIMIT 50").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([agent], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            r.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|_| "Invalid evidence".into()))
        })
        .collect()
    }
    pub fn memory_evidence_count(&self, agent: i64) -> Result<i64, String> {
        self.db
            .query_row(
                "SELECT count(*) FROM memory_evidence WHERE agent_id=?1",
                [agent],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }
    pub fn memory_recover(&mut self) -> Result<(), String> {
        self.db.execute("UPDATE memory_jobs SET document=json_set(document,'$.state','interrupted','$.error','Maintenance interrupted; manual retry required') WHERE json_extract(document,'$.state') IN ('queued','running','validating')",[]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn context_checkpoints(&self, run: i64) -> Result<Value, String> {
        self.agent_run(run)?;
        let mut q=self.db.prepare("SELECT id,document FROM context_checkpoints WHERE run_id=?1 ORDER BY id DESC LIMIT 4").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([run], |r| {
                let raw: String = r.get(1)?;
                Ok((r.get::<_, i64>(0)?, raw))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (id, raw) = row.map_err(|e| e.to_string())?;
            let mut d: Value =
                serde_json::from_str(&raw).map_err(|_| "Invalid context checkpoint")?;
            d["id"] = json!(id);
            out.push(d);
        }
        Ok(json!(out))
    }
}
