use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("
      CREATE TABLE providers(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,config TEXT NOT NULL,secret_ref TEXT);
      CREATE TABLE conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,provider_id TEXT,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE turns(id INTEGER PRIMARY KEY AUTOINCREMENT,client_turn_id TEXT NOT NULL UNIQUE,conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider_id TEXT NOT NULL,provider_revision INTEGER NOT NULL,provider_name TEXT NOT NULL,model TEXT NOT NULL,protocol TEXT NOT NULL,user_text TEXT NOT NULL,assistant_text TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,error_kind TEXT,error_message TEXT,usage TEXT,finish_reason TEXT,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),finished_at TEXT);
      CREATE INDEX turns_conversation ON turns(conversation_id,id);
      PRAGMA user_version=2;
    ").map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub(super) fn migrate_scope(db: &mut Connection) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for (table, column, statement) in [
        (
            "conversations",
            "agent_id",
            "ALTER TABLE conversations ADD COLUMN agent_id INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "conversations",
            "project_id",
            "ALTER TABLE conversations ADD COLUMN project_id TEXT",
        ),
        (
            "turns",
            "automation_mode",
            "ALTER TABLE turns ADD COLUMN automation_mode INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        let present: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![table, column],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !present {
            tx.execute_batch(statement).map_err(|e| e.to_string())?;
        }
    }
    tx.execute_batch("PRAGMA user_version=31")
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub struct Provider {
    pub id: String,
    pub revision: i64,
    pub config: Value,
    pub has_key: bool,
    #[serde(skip)]
    pub secret_ref: Option<String>,
}
#[derive(Serialize)]
pub struct Conversation {
    pub id: i64,
    pub agent_id: i64,
    pub project_id: Option<String>,
    pub title: String,
    pub workspace_id: Option<i64>,
    pub provider_id: Option<String>,
    pub updated_at: String,
    pub active_turn_id: Option<i64>,
}
#[derive(Serialize)]
pub struct ChatMessage {
    pub id: i64,
    pub turn_id: i64,
    pub role: String,
    pub content: String,
    pub status: String,
    pub provider_name: String,
    pub model: String,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
}
#[derive(Serialize)]
pub struct MessagePage {
    pub items: Vec<ChatMessage>,
    pub next_before: Option<i64>,
}
#[derive(Serialize)]
pub struct TurnReceipt {
    pub turn_id: i64,
    pub conversation_id: i64,
    pub status: String,
    pub duplicate: bool,
}

impl Store {
    pub fn chat_scope(&self, conversation: i64) -> Result<Value, String> {
        self.db.query_row("SELECT agent_id,project_id,workspace_id FROM conversations WHERE id=?1",[conversation],|row|Ok(json!({"agent_id":row.get::<_,i64>(0)?,"project_id":row.get::<_,Option<String>>(1)?,"workspace_id":row.get::<_,Option<i64>>(2)?}))).map_err(|_|"对话不存在。".into())
    }
    pub fn chat_automation_mode(&self, client: &str) -> Result<Option<bool>, String> {
        self.db
            .query_row(
                "SELECT automation_mode FROM turns WHERE client_turn_id=?1",
                [client],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn create_scoped_conversation(
        &self,
        title: &str,
        workspace: Option<i64>,
        agent: i64,
        project: Option<&str>,
    ) -> Result<i64, String> {
        self.memory_agent(agent)?;
        if let Some(project) = project {
            if !self
                .memory_projects(agent)?
                .as_array()
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["slug"] == project && item["joined"] == true)
                })
            {
                return Err("对话项目成员资格无效。".into());
            }
        }
        if title.trim().is_empty() || title.chars().count() > 80 {
            return Err("对话标题无效。".into());
        }
        self.db.execute("INSERT INTO conversations(title,workspace_id,agent_id,project_id) VALUES(?1,?2,?3,?4)", params![title.trim(),workspace,agent,project]).map_err(|e|e.to_string())?;
        Ok(self.db.last_insert_rowid())
    }
    pub fn automation_chat_source(&self, turn: i64) -> Result<Value, String> {
        let mut source:Value = self.db.query_row("SELECT t.assistant_text,t.status,t.provider_id,c.id,c.agent_id,c.project_id,c.workspace_id,t.office_reference_ids FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=?1", [turn], |row| {
            let raw:String=row.get(7)?;
            let mut value=json!({"output":row.get::<_,String>(0)?,"state":row.get::<_,String>(1)?,"provider_id":row.get::<_,String>(2)?,"conversation_id":row.get::<_,i64>(3)?,"agent_id":row.get::<_,i64>(4)?,"project_id":row.get::<_,Option<String>>(5)?,"workspace_id":row.get::<_,Option<i64>>(6)?});
            value["office_reference_ids"] = serde_json::from_str(&raw).unwrap_or(Value::Null);
            Ok(value)
        }).map_err(|_|"自动化来源对话不存在。".to_string())?;
        if source["office_reference_ids"]
            .as_array()
            .is_some_and(|ids| ids.is_empty())
        {
            source
                .as_object_mut()
                .unwrap()
                .remove("office_reference_ids");
        }
        Ok(source)
    }
    pub fn providers(&self) -> Result<Vec<Provider>, String> {
        let mut q = self
            .db
            .prepare("SELECT id,revision,config,secret_ref FROM providers ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                let config: String = r.get(2)?;
                let secret_ref: Option<String> = r.get(3)?;
                Ok(Provider {
                    id: r.get(0)?,
                    revision: r.get(1)?,
                    config: serde_json::from_str(&config).unwrap_or(Value::Null),
                    has_key: secret_ref.is_some(),
                    secret_ref,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn provider(&self, id: &str) -> Result<Provider, String> {
        self.providers()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "模型服务不存在，请重新选择。".into())
    }
    pub fn save_provider(
        &self,
        id: &str,
        config: &Value,
        reference: Option<&str>,
    ) -> Result<Provider, String> {
        let count: i64 = self
            .db
            .query_row("SELECT count(*) FROM providers", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count >= 8 && self.provider(id).is_err() {
            return Err("当前最多配置 8 个模型服务。".into());
        }
        self.db.execute("INSERT INTO providers(id,revision,config,secret_ref) VALUES(?1,1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=revision+1,config=excluded.config,secret_ref=excluded.secret_ref",params![id,config.to_string(),reference]).map_err(|e|e.to_string())?;
        self.provider(id)
    }
    pub fn delete_provider(&mut self, id: &str) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE conversations SET provider_id=NULL WHERE provider_id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM providers WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn conversations(&self, offset: i64) -> Result<Value, String> {
        if offset < 0 {
            return Err("分页参数无效。".into());
        }
        let mut q=self.db.prepare("SELECT c.id,c.title,c.workspace_id,c.provider_id,c.updated_at,(SELECT id FROM turns t WHERE t.conversation_id=c.id AND t.status='streaming' LIMIT 1),c.agent_id,c.project_id FROM conversations c ORDER BY c.updated_at DESC,c.id DESC LIMIT 30 OFFSET ?1").map_err(|e|e.to_string())?;
        let items = q
            .query_map([offset], |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    workspace_id: r.get(2)?,
                    provider_id: r.get(3)?,
                    updated_at: r.get(4)?,
                    active_turn_id: r.get(5)?,
                    agent_id: r.get(6)?,
                    project_id: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let total: i64 = self
            .db
            .query_row("SELECT count(*) FROM conversations", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let next = offset + items.len() as i64;
        Ok(json!({"items":items,"total":total,"next_offset":if next<total{Some(next)}else{None}}))
    }
    pub fn create_conversation(
        &self,
        title: &str,
        workspace_id: Option<i64>,
    ) -> Result<i64, String> {
        if title.trim().is_empty() || title.chars().count() > 80 {
            return Err("对话标题无效。".into());
        }
        self.db
            .execute(
                "INSERT INTO conversations(title,workspace_id) VALUES(?1,?2)",
                params![title.trim(), workspace_id],
            )
            .map_err(|_| "无法创建对话，请检查工作区是否仍存在。".to_string())?;
        Ok(self.db.last_insert_rowid())
    }
    pub fn conversation_exists(&self, id: i64) -> Result<(), String> {
        let exists: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            Ok(())
        } else {
            Err("对话不存在。".into())
        }
    }
    pub fn delete_conversation(&self, id: i64) -> Result<(), String> {
        self.conversation_exists(id)?;
        self.db
            .execute("DELETE FROM conversations WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn duplicate_turn(
        &self,
        client_id: &str,
        conversation_id: i64,
        provider_id: &str,
        text: &str,
    ) -> Result<Option<TurnReceipt>, String> {
        let row:Option<(i64,i64,String,String,String)>=self.db.query_row("SELECT id,conversation_id,provider_id,user_text,status FROM turns WHERE client_turn_id=?1",[client_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
        match row {
            Some((id, c, p, t, status))
                if c == conversation_id && p == provider_id && t == text =>
            {
                Ok(Some(TurnReceipt {
                    turn_id: id,
                    conversation_id: c,
                    status,
                    duplicate: true,
                }))
            }
            Some(_) => Err("发送标识已被其他内容使用，请核对对话。".into()),
            None => Ok(None),
        }
    }
    pub fn context(&self, conversation_id: i64) -> Result<Vec<(String, String)>, String> {
        self.conversation_exists(conversation_id)?;
        let mut q=self.db.prepare("SELECT user_text,assistant_text FROM turns WHERE conversation_id=?1 AND status IN ('completed','incomplete') ORDER BY id").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([conversation_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut messages = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (u, a) = row.map_err(|e| e.to_string())?;
            bytes += u.len() + a.len();
            if bytes > 192_000 {
                return Err("对话上下文已达到本版本上限，请新建对话。".into());
            }
            messages.push(("user".into(), u));
            messages.push(("assistant".into(), a));
        }
        Ok(messages)
    }
    pub fn begin_turn(
        &mut self,
        client_id: &str,
        conversation_id: i64,
        provider: &Provider,
        text: &str,
    ) -> Result<TurnReceipt, String> {
        self.begin_turn_mode(client_id, conversation_id, provider, text, false, &[])
    }
    pub fn begin_turn_mode(
        &mut self,
        client_id: &str,
        conversation_id: i64,
        provider: &Provider,
        text: &str,
        automation: bool,
        office_reference_ids: &[String],
    ) -> Result<TurnReceipt, String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO turns(client_turn_id,conversation_id,provider_id,provider_revision,provider_name,model,protocol,user_text,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'streaming')",params![client_id,conversation_id,provider.id,provider.revision,provider.config["name"].as_str().unwrap_or(""),provider.config["model"].as_str().unwrap_or(""),provider.config["protocol"].as_str().unwrap_or(""),text]).map_err(|e|e.to_string())?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE turns SET automation_mode=?2,office_reference_ids=?3 WHERE id=?1",
            params![id, automation, json!(office_reference_ids).to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE conversations SET provider_id=?1,title=CASE WHEN NOT EXISTS(SELECT 1 FROM turns WHERE conversation_id=?2 AND id<>?3) THEN ?4 ELSE title END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",params![provider.id,conversation_id,id,text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect::<String>()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(TurnReceipt {
            turn_id: id,
            conversation_id,
            status: "streaming".into(),
            duplicate: false,
        })
    }
    pub fn append_text(&self, turn: i64, text: &str) -> Result<(), String> {
        self.db.execute("UPDATE turns SET assistant_text=assistant_text||?1 WHERE id=?2 AND status='streaming'",params![text,turn]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn finish_turn(
        &self,
        turn: i64,
        status: &str,
        kind: Option<&str>,
        message: Option<&str>,
        usage: Option<&Value>,
        finish: Option<&str>,
    ) -> Result<(), String> {
        self.db.execute("UPDATE turns SET status=?1,error_kind=?2,error_message=?3,usage=?4,finish_reason=?5,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?6 AND status='streaming'",params![status,kind,message,usage.map(Value::to_string),finish,turn]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn messages(
        &self,
        conversation_id: i64,
        before: Option<i64>,
    ) -> Result<MessagePage, String> {
        self.conversation_exists(conversation_id)?;
        let mut q=self.db.prepare("SELECT mid,tid,role,content,status,provider_name,model,error_kind,error_message,usage,finish_reason FROM (
          SELECT id*2 AS mid,id AS tid,'user' AS role,user_text AS content,'completed' AS status,provider_name,model,NULL AS error_kind,NULL AS error_message,NULL AS usage,NULL AS finish_reason FROM turns WHERE conversation_id=?1
          UNION ALL SELECT id*2+1,id,'assistant',assistant_text,status,provider_name,model,error_kind,error_message,usage,finish_reason FROM turns WHERE conversation_id=?1)
          WHERE mid<?2 ORDER BY mid DESC LIMIT 51").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![conversation_id, before.unwrap_or(i64::MAX)], |r| {
                let usage: Option<String> = r.get(9)?;
                Ok(ChatMessage {
                    id: r.get(0)?,
                    turn_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    status: r.get(4)?,
                    provider_name: r.get(5)?,
                    model: r.get(6)?,
                    error_kind: r.get(7)?,
                    error_message: r.get(8)?,
                    usage: usage.and_then(|v| serde_json::from_str(&v).ok()),
                    finish_reason: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for row in rows {
            let item = row.map_err(|e| e.to_string())?;
            let size = serde_json::to_vec(&item).map_err(|e| e.to_string())?.len();
            if bytes + size > 56_000 || items.len() >= 50 {
                more = true;
                break;
            }
            bytes += size;
            items.push(item);
        }
        let next_before = if more {
            items.last().map(|m| m.id)
        } else {
            None
        };
        items.reverse();
        Ok(MessagePage { items, next_before })
    }
}
