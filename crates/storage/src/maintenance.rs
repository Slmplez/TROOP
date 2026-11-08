use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE memory_maintenance_settings(agent_id INTEGER NOT NULL REFERENCES memory_agents(id),revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(agent_id,revision));
        CREATE TABLE memory_maintenance_attempts(job_id INTEGER NOT NULL REFERENCES memory_jobs(id),attempt INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(job_id,attempt));
        INSERT INTO memory_maintenance_attempts SELECT id,COALESCE(json_extract(document,'$.attempt'),1),document FROM memory_jobs;
        PRAGMA user_version=15; COMMIT;").map_err(|e|e.to_string())
}
impl Store {
    pub fn maintenance_settings(&self, agent: i64) -> Result<Value, String> {
        self.memory_agent(agent)?;
        let raw:Option<String>=self.db.query_row("SELECT document FROM memory_maintenance_settings WHERE agent_id=?1 ORDER BY revision DESC LIMIT 1",[agent],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let mut settings: Value = raw.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).unwrap_or_else(||Ok(json!({"agent_id":agent,"revision":0,"enabled":false,"provider_id":null,"model":null,"destination":null})))?;
        if settings["target_scope"].is_null() {
            settings["target_scope"] = json!("agent");
            settings["target_project"] = json!("");
        }
        Ok(settings)
    }
    pub fn maintenance_save(
        &mut self,
        agent: i64,
        expected: i64,
        mut settings: Value,
    ) -> Result<Value, String> {
        let current = self.maintenance_settings(agent)?;
        if current["revision"] != expected {
            return Err("记忆维护配置已变化，请刷新。".into());
        }
        settings["agent_id"] = json!(agent);
        settings["revision"] = json!(expected + 1);
        self.db
            .execute(
                "INSERT INTO memory_maintenance_settings VALUES(?1,?2,?3)",
                params![agent, expected + 1, settings.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(settings)
    }
    pub fn maintenance_pending(&self) -> Result<Vec<i64>, String> {
        let mut query=self.db.prepare("SELECT id FROM memory_jobs WHERE json_extract(document,'$.state') IN ('queued','waiting_configuration','validating') ORDER BY COALESCE((SELECT json_extract(s.document,'$.enabled') FROM memory_maintenance_settings s WHERE s.agent_id=memory_jobs.agent_id ORDER BY revision DESC LIMIT 1),0) DESC,id LIMIT 64").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn maintenance_agent_pending(&self, agent: i64) -> Result<Vec<Value>, String> {
        let mut query=self.db.prepare("SELECT document FROM memory_jobs WHERE agent_id=?1 AND json_extract(document,'$.state') IN ('queued','waiting_configuration','running','validating')").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([agent], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn maintenance_attempts(&self, job: i64) -> Result<Value, String> {
        self.memory_job(job)?;
        let mut query=self.db.prepare("SELECT json_object('attempt',attempt,'state',json_extract(document,'$.state'),'provider_id',json_extract(document,'$.provider_id'),'model',json_extract(document,'$.config.model'),'maintenance_revision',json_extract(document,'$.maintenance_revision'),'error',json_extract(document,'$.error'),'usage',json_extract(document,'$.usage')) FROM memory_maintenance_attempts WHERE job_id=?1 ORDER BY attempt DESC LIMIT 20").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([job], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let items = rows
            .map(|r| {
                serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!(items))
    }
}

pub(super) fn save_attempt(db: &Connection, doc: &Value) -> Result<(), String> {
    if doc["maintenance_revision"].is_null() {
        return Ok(());
    }
    db.execute("INSERT INTO memory_maintenance_attempts VALUES(?1,?2,?3) ON CONFLICT(job_id,attempt) DO UPDATE SET document=excluded.document",params![doc["id"].as_i64(),doc["attempt"].as_i64(),doc.to_string()]).map(|_|()).map_err(|e|e.to_string())
}
