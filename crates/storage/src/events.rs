use super::Store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

enum AcceptanceError {
    Invalid(&'static str),
    Storage(String),
}
impl From<&'static str> for AcceptanceError {
    fn from(reason: &'static str) -> Self {
        Self::Invalid(reason)
    }
}
impl From<String> for AcceptanceError {
    fn from(error: String) -> Self {
        Self::Storage(error)
    }
}

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE event_sources(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE TABLE event_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,semantic_key TEXT NOT NULL,document TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0,UNIQUE(source_id,semantic_key));
        CREATE TABLE event_deliveries(source_id TEXT NOT NULL,delivery_id TEXT NOT NULL,event_id INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(source_id,delivery_id));
        CREATE TABLE event_leases(source_id TEXT PRIMARY KEY,consumer_id TEXT NOT NULL,generation TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        CREATE TABLE source_events(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,semantic_key TEXT NOT NULL,document TEXT NOT NULL,state TEXT NOT NULL,next_check INTEGER NOT NULL DEFAULT 0,UNIQUE(source_id,semantic_key));
        PRAGMA user_version=16; COMMIT;").map_err(|e|e.to_string())
}
pub(super) fn migrate_receipts(db: &mut Connection) -> Result<(), String> {
    db.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE source_event_receipts(source_id TEXT NOT NULL,receiver_instance TEXT NOT NULL,inbox_id INTEGER NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(source_id,receiver_instance,inbox_id));
        PRAGMA user_version=17; COMMIT;").map_err(|e|e.to_string())
}
impl Store {
    pub fn source_event_accept(&mut self, source: &Value, event: &Value) -> Result<Value, String> {
        let record = match self.accept_source_event(source, event) {
            Ok(record) => Ok(record),
            Err(AcceptanceError::Invalid(reason)) => {
                self.source_event_quarantine(source, event, reason)
            }
            Err(AcceptanceError::Storage(error)) => Err(error),
        }?;
        let receiver = self.event_receiver_identity(source)?;
        self.db.execute("INSERT INTO source_event_receipts VALUES(?1,?2,?3,?4) ON CONFLICT(source_id,receiver_instance,inbox_id) DO NOTHING",
            params![source["id"].as_str(),receiver,event["inbox_id"].as_i64(),record["id"].as_i64()]).map_err(|e|e.to_string())?;
        Ok(record)
    }
    fn source_event_quarantine(
        &mut self,
        source: &Value,
        event: &Value,
        reason: &str,
    ) -> Result<Value, String> {
        let inbox = event["inbox_id"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or("交付缺少可确认的 Inbox 身份。")?;
        let receiver = self.event_receiver_identity(source)?;
        let semantic = format!("rejected-inbox:{receiver}:{inbox}");
        let record = json!({"source_id":source["id"],"semantic_key":semantic,
            "inbox_id":inbox,"workspace_id":source["workspace_id"],
            "receiver_instance":receiver,
            "subject_id":event["subject_id"].as_str().unwrap_or("unknown").chars().take(200).collect::<String>(),
            "kind":event["kind"].as_str().unwrap_or("unknown").chars().take(100).collect::<String>(),"delivery_committed":true,
            "review_state":"rejected","review_reason":reason});
        self.db.execute(
            "INSERT INTO source_events(source_id,semantic_key,document,state) VALUES(?1,?2,?3,'rejected') ON CONFLICT(source_id,semantic_key) DO NOTHING",
            params![source["id"].as_str(),semantic,record.to_string()],
        ).map_err(|e|e.to_string())?;
        let id = self
            .db
            .query_row(
                "SELECT id FROM source_events WHERE source_id=?1 AND semantic_key=?2",
                params![source["id"].as_str(), semantic],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.source_event(id)
    }
    fn accept_source_event(
        &mut self,
        source: &Value,
        event: &Value,
    ) -> Result<Value, AcceptanceError> {
        if serde_json::to_vec(event).map_err(|e| e.to_string())?.len() > 4000 {
            return Err("交付事件元数据超过 4KB。".into());
        }
        let semantic = event["semantic_key"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 1024)
            .ok_or("语义事件身份无效。")?;
        if event["source_id"] != source["id"]
            || event["project"] != source["project"]
            || event["inbox_id"].as_i64().is_none_or(|n| n <= 0)
        {
            return Err("交付事件与登记来源不匹配。".into());
        }
        let kind = event["kind"].as_str().ok_or("交付事件类型无效。")?;
        let allowed = match source["kind"].as_str().unwrap_or("") {
            "github" => matches!(
                kind,
                "github.workflow.completed"
                    | "github.issue.changed"
                    | "github.pull_request.changed"
            ),
            "gitlab" => matches!(
                kind,
                "gitlab.pipeline.changed" | "gitlab.issue.changed" | "gitlab.merge_request.changed"
            ),
            "webhook" => kind == "webhook.changed",
            _ => false,
        };
        if !allowed {
            return Err("交付事件类型超出来源能力。".into());
        }
        for field in ["subject_id", "subject_version", "state", "payload_sha256"] {
            if event[field]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 200 || s.chars().any(char::is_control))
            {
                return Err("交付事件元数据无效。".into());
            }
        }
        let receiver = self.event_receiver_identity(source)?;
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        let received = event["received_at"].as_i64().ok_or("接收时间无效。")?;
        let now: i64 = tx
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if received <= 0 || received > now + 300 {
            return Err("接收时间超出允许范围。".into());
        }
        let occurred = event["occurred_at"].as_i64().or_else(|| {
            event["occurred_at"].as_str().and_then(|s| {
                tx.query_row("SELECT CAST(strftime('%s',?1) AS INTEGER)", [s], |r| {
                    r.get::<_, Option<i64>>(0)
                })
                .ok()
                .flatten()
            })
        });
        let mut record = event.clone();
        record
            .as_object_mut()
            .ok_or("交付事件无效。")?
            .remove("acked");
        record["delivery_committed"] = json!(true);
        record["receiver_instance"] = json!(receiver);
        record["workspace_id"] = source["workspace_id"].clone();
        record["uncertain_time"] = json!(occurred.is_none());
        record["occurred_at_ms"] = json!(event["occurred_at"]
            .as_i64()
            .map(|t| t.saturating_mul(1000))
            .or_else(|| {
                event["occurred_at"].as_str().and_then(|s| {
                    tx.query_row(
                        "SELECT CAST(unixepoch(?1,'subsec')*1000 AS INTEGER)",
                        [s],
                        |r| r.get::<_, Option<i64>>(0),
                    )
                    .ok()
                    .flatten()
                })
            }));
        record["time_precision_ms"] = json!(if event["occurred_at"]
            .as_str()
            .is_some_and(|s| s.contains('.'))
        {
            1
        } else {
            1000
        });
        let ttl = source["ttl_seconds"].as_i64().ok_or("来源有效期无效。")?;
        let expired = occurred
            .unwrap_or(received)
            .min(received)
            .saturating_add(ttl)
            <= now;
        let state = if occurred.is_some_and(|t| t > received + 300) {
            "needs_attention"
        } else if expired {
            "expired"
        } else {
            "pending"
        };
        record["review_state"] = json!(state);
        record["expires_at"] = json!(occurred
            .unwrap_or(received)
            .min(received)
            .saturating_add(ttl));
        record["review_reason"] = json!(if expired {
            "事件已过期。"
        } else {
            "等待当前状态复核。"
        });
        tx.execute("INSERT OR IGNORE INTO source_events(source_id,semantic_key,document,state) VALUES(?1,?2,?3,?4)",params![source["id"].as_str(),semantic,record.to_string(),state]).map_err(|e|e.to_string())?;
        let (id, raw): (i64, String) = tx
            .query_row(
                "SELECT id,document FROM source_events WHERE source_id=?1 AND semantic_key=?2",
                params![source["id"].as_str(), semantic],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        let mut saved: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        saved["id"] = json!(id);
        Ok(saved)
    }
    pub fn source_event(&self, id: i64) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM source_events WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "来源事件不存在。")?;
        let mut event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        event["id"] = json!(id);
        Ok(event)
    }
    pub fn source_events(&self, source: &str, after: i64) -> Result<Value, String> {
        let mut q = self
            .db
            .prepare(
                "SELECT id FROM source_events WHERE source_id=?1 AND id>?2 ORDER BY id LIMIT 11",
            )
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map(params![source, after], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let more = rows.len() > 10;
        let items = rows
            .into_iter()
            .take(10)
            .map(|id| self.source_event(id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            json!({"next_after":if more{items.last().map(|e|e["id"].clone()).unwrap_or(Value::Null)}else{Value::Null},"items":items}),
        )
    }
    pub fn event_executions(&self, event: i64) -> Result<Value, String> {
        let mut q=self.db.prepare("SELECT rule_id,document FROM automation_deliveries WHERE json_extract(document,'$.external_event_id')=?1 ORDER BY rowid DESC LIMIT 3").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([event], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let items=rows.map(|row|{let (rule,raw)=row.map_err(|e|e.to_string())?;let d:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;Ok(json!({"rule_id":rule,"state":d["state"],"run_id":d["run_id"],"rule_revision":d["rule_revision"],"reason":d["reason"].as_str().unwrap_or("等待处理。").chars().take(100).collect::<String>()}))}).collect::<Result<Vec<Value>,String>>()?;
        Ok(json!(items))
    }
    pub fn source_event_due(&self) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT e.id FROM source_events e JOIN event_sources s ON s.id=e.source_id WHERE e.state IN ('pending','waiting_recheck') AND e.next_check<=unixepoch() AND json_extract(s.document,'$.enabled')=1 ORDER BY e.id LIMIT 20").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter().map(|id| self.source_event(id)).collect()
    }
    pub fn source_event_save(
        &mut self,
        mut event: Value,
        state: &str,
        reason: &str,
        next: i64,
    ) -> Result<Value, String> {
        event["review_state"] = json!(state);
        event["review_reason"] = json!(reason);
        self.db
            .execute(
                "UPDATE source_events SET document=?1,state=?2,next_check=?3 WHERE id=?4",
                params![event.to_string(), state, next, event["id"].as_i64()],
            )
            .map_err(|e| e.to_string())?;
        Ok(event)
    }
    pub fn source_event_recheck(&mut self, source: &str) -> Result<(), String> {
        self.db.execute("UPDATE source_events SET state='pending',next_check=0,document=json_set(document,'$.review_state','pending','$.review_generation',COALESCE(json_extract(document,'$.review_generation'),0)+1,'$.review_reason','来源配置已更新，等待复核。') WHERE source_id=?1 AND state IN ('needs_attention','waiting_recheck','valid')",[source]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn source_rule_candidates(&self, rule: &Value) -> Result<Vec<Value>, String> {
        let mut q=self.db.prepare("SELECT e.id FROM source_events e WHERE e.source_id=?1 AND e.state IN ('valid','invalid','expired') AND NOT EXISTS(SELECT 1 FROM automation_deliveries d WHERE d.rule_id=?2 AND d.event_key='external:'||e.id AND COALESCE(json_extract(d.document,'$.state'),'')<>'waiting') ORDER BY e.id LIMIT 20").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(
                params![rule["source_id"].as_str(), rule["id"].as_str()],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter().map(|id| self.source_event(id)).collect()
    }
    pub fn event_source_page(&self, raw: Vec<String>, offset: usize) -> Result<Value, String> {
        super::authorizations::page(raw, offset)
    }
    pub fn event_source(&self, id: &str) -> Result<Value, String> {
        let raw: String = self
            .db
            .query_row(
                "SELECT document FROM event_sources WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "事件来源不存在。")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
    pub fn event_sources(&self) -> Result<Vec<Value>, String> {
        let mut q = self
            .db
            .prepare("SELECT document FROM event_sources ORDER BY rowid LIMIT 64")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn event_source_save(
        &mut self,
        id: &str,
        expected: i64,
        mut source: Value,
    ) -> Result<Value, String> {
        let current = self.event_source(id).ok();
        if current
            .as_ref()
            .map(|s| s["revision"].as_i64().unwrap_or(0))
            .unwrap_or(0)
            != expected
        {
            return Err("事件来源修订冲突，请刷新。".into());
        }
        if current.is_none() && self.event_sources()?.len() >= 64 {
            return Err("最多配置 64 个事件来源。".into());
        }
        source["id"] = json!(id);
        source["revision"] = json!(expected + 1);
        self.db.execute("INSERT INTO event_sources VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document",params![id,expected+1,source.to_string()]).map_err(|e|e.to_string())?;
        Ok(source)
    }
    pub fn event_receive(
        &mut self,
        source: &str,
        delivery: &str,
        semantic: &str,
        digest: &str,
        document: &Value,
        payload: &str,
    ) -> Result<Value, String> {
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        let old:Option<(i64,String)>=tx.query_row("SELECT event_id,digest FROM event_deliveries WHERE source_id=?1 AND delivery_id=?2",params![source,delivery],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        if let Some((id, previous)) = old {
            if previous != digest {
                return Err("事件投递标识已用于不同正文。".into());
            }
            return Ok(json!({"accepted":true,"duplicate":true,"event_id":id}));
        }
        let mut document = document.clone();
        document["received_at_ms"] = json!(tx
            .query_row(
                "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
                [],
                |r| r.get::<_, i64>(0)
            )
            .map_err(|e| e.to_string())?);
        let inserted=tx.execute("INSERT OR IGNORE INTO event_inbox(source_id,semantic_key,document,payload,received_at) VALUES(?1,?2,?3,?4,unixepoch())",params![source,semantic,document.to_string(),payload]).map_err(|e|e.to_string())?;
        let id: i64 = tx
            .query_row(
                "SELECT id FROM event_inbox WHERE source_id=?1 AND semantic_key=?2",
                params![source, semantic],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO event_deliveries VALUES(?1,?2,?3,?4)",
            params![source, delivery, id, digest],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(json!({"accepted":true,"duplicate":inserted==0,"event_id":id}))
    }
    pub fn event_inbox(&self, source: &str, after: i64, unacked: bool) -> Result<Value, String> {
        self.event_inbox_page(source, after, unacked, None)
    }
    fn event_inbox_page(
        &self,
        source: &str,
        after: i64,
        unacked: bool,
        accepted: Option<i64>,
    ) -> Result<Value, String> {
        let mut q=self.db.prepare("SELECT id,document,received_at,acked,payload='' FROM event_inbox WHERE source_id=?1 AND id>?2 AND (?3=0 OR acked=0) AND (?4 IS NULL OR id>?4 OR acked=0) ORDER BY id LIMIT 11").map_err(|e|e.to_string())?;
        let rows = q
            .query_map(params![source, after, i32::from(unacked), accepted], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (id, raw, received, acked, archived) = row.map_err(|e| e.to_string())?;
            let mut event: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            event["inbox_id"] = json!(id);
            event["received_at"] = json!(received);
            event["acked"] = json!(acked);
            event["payload_archived"] = json!(archived);
            items.push(event);
        }
        let more = items.len() > 10;
        items.truncate(10);
        let next = if more {
            items
                .last()
                .map(|v| v["inbox_id"].clone())
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(json!({"items":items,"next_after":next}))
    }
    pub fn event_payload(&self, source: &str, id: i64) -> Result<String, String> {
        self.db
            .query_row(
                "SELECT payload FROM event_inbox WHERE source_id=?1 AND id=?2",
                params![source, id],
                |r| r.get(0),
            )
            .map_err(|_| "事件正文不存在。".into())
    }
    pub fn event_prune_payloads(&mut self) -> Result<(), String> {
        self.db.execute("UPDATE event_inbox SET payload='' WHERE acked=1 AND payload<>'' AND received_at<unixepoch()-2592000", [])
            .map(|_| ()).map_err(|e|e.to_string())
    }
    fn event_receiver_identity(&self, source: &Value) -> Result<String, String> {
        if source["mode"] == "remote" {
            source["receiver_instance"]
                .as_str()
                .map(str::to_owned)
                .ok_or("接收器身份缺失。".into())
        } else {
            self.instance_id()
        }
    }
    pub fn source_event_boundary(&self, source: &Value) -> Result<i64, String> {
        let receiver = self.event_receiver_identity(source)?;
        self.db.query_row(
            "SELECT COALESCE(MAX(inbox_id),0) FROM source_event_receipts WHERE source_id=?1 AND receiver_instance=?2",
            params![source["id"].as_str(),receiver], |r| r.get(0),
        ).map_err(|e| e.to_string())
    }
    pub fn event_reconcile(&self, source: &str, accepted: i64) -> Result<Value, String> {
        let last: i64 = self
            .db
            .query_row(
                "SELECT COALESCE(MAX(id),0) FROM event_inbox WHERE source_id=?1",
                [source],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if accepted < 0 || accepted > last {
            return Err("接收器交付边界落后于 Core，请核对数据库恢复或接收器迁移。".into());
        }
        // Include unacknowledged holes as well as records missing from a restored Core.
        let mut page = self.event_inbox_page(source, 0, false, Some(accepted))?;
        page["accepted_through"] = json!(accepted);
        page["receiver_through"] = json!(last);
        Ok(page)
    }
    pub fn event_claim(
        &mut self,
        source: &str,
        consumer: &str,
        generation: &str,
    ) -> Result<Value, String> {
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        let old: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT generation,epoch,expires_at FROM event_leases WHERE source_id=?1",
                [source],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let now: i64 = tx
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if old
            .as_ref()
            .is_some_and(|(owner, _, expiry)| owner != generation && *expiry > now)
        {
            return Err("事件来源已有活动消费者。".into());
        }
        if let Some((owner, epoch, expiry)) = &old {
            if owner == generation && *expiry > now + 5 {
                return Ok(json!({"epoch":epoch,"expires_at":expiry}));
            }
        }
        let epoch = old
            .map(|(owner, epoch, expiry)| {
                if owner == generation && expiry > now {
                    epoch
                } else {
                    epoch + 1
                }
            })
            .unwrap_or(1);
        tx.execute("INSERT INTO event_leases VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source_id) DO UPDATE SET consumer_id=excluded.consumer_id,generation=excluded.generation,epoch=excluded.epoch,expires_at=excluded.expires_at",params![source,consumer,generation,epoch,now+15]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(json!({"epoch":epoch,"expires_at":now+15}))
    }
    pub fn event_recover_local_leases(&self) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE event_leases SET expires_at=0 WHERE consumer_id=?1",
                [self.instance_id()?],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn event_check_lease(
        &self,
        source: &str,
        consumer: &str,
        generation: &str,
        epoch: i64,
    ) -> Result<(), String> {
        let valid:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM event_leases WHERE source_id=?1 AND consumer_id=?2 AND generation=?3 AND epoch=?4 AND expires_at>unixepoch())",params![source,consumer,generation,epoch],|r|r.get(0)).map_err(|e|e.to_string())?;
        if valid {
            Ok(())
        } else {
            Err("事件消费租约已失效。".into())
        }
    }
    pub fn event_ack(&mut self, source: &str, id: i64) -> Result<Value, String> {
        if self
            .db
            .execute(
                "UPDATE event_inbox SET acked=1 WHERE source_id=?1 AND id=?2",
                params![source, id],
            )
            .map_err(|e| e.to_string())?
            != 1
        {
            return Err("交付记录不存在。".into());
        }
        let cursor:i64=self.db.query_row("SELECT COALESCE(MAX(id),0) FROM event_inbox WHERE source_id=?1 AND acked=1 AND id<COALESCE((SELECT MIN(id) FROM event_inbox WHERE source_id=?1 AND acked=0),9223372036854775807)",[source],|r|r.get(0)).map_err(|e|e.to_string())?;
        Ok(json!({"acked":true,"cursor":cursor}))
    }
}
