use crate::params;
use serde::Deserialize;
use serde_json::{json, Value};
use troop_protocol::schedule::Schedule;

pub(crate) fn preview(input: Value, now: i64) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Preview {
        schedule: Schedule,
        after_ms: Option<i64>,
    }
    let request = params::<Preview>(input)?;
    let mut next = request.schedule.next(request.after_ms.unwrap_or(now))?;
    let mut slots = Vec::new();
    while let Some(slot) = next {
        next = request.schedule.following(&slot)?;
        slots.push(slot);
        if slots.len() == 5 {
            break;
        }
    }
    Ok(
        json!({"slots":slots,"missed_policy":"skip","dst_fold_policy":"earliest_once","dst_gap_policy":"skip"}),
    )
}

pub(crate) const GRACE_MS: i64 = 5_000;
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub(crate) struct Clock {
    file: Option<std::path::PathBuf>,
    pub boot_ms: i64,
    last_tick_ms: i64,
    missed_through_ms: i64,
}
impl Clock {
    pub fn cutoff(&self) -> i64 {
        self.boot_ms.max(self.missed_through_ms)
    }
    pub fn new(file: Option<std::path::PathBuf>) -> Result<Self, String> {
        let mut value = Self {
            file,
            boot_ms: 0,
            last_tick_ms: 0,
            missed_through_ms: 0,
        };
        value.boot_ms = value.now()?;
        value.last_tick_ms = value.boot_ms;
        Ok(value)
    }
    pub fn now(&self) -> Result<i64, String> {
        if let Some(file) = &self.file {
            use std::io::Read;
            let mut raw = String::new();
            std::fs::File::open(file)
                .map_err(|e| e.to_string())?
                .take(65)
                .read_to_string(&mut raw)
                .map_err(|e| e.to_string())?;
            let time = raw.trim().parse::<i64>().map_err(|_| "测试时钟无效。")?;
            if !(0..4_134_000_000_000).contains(&time) {
                return Err("测试时钟超出范围。".into());
            }
            Ok(time)
        } else {
            Ok(now_ms())
        }
    }
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    kind: String,
    event: String,
    name: String,
    enabled: bool,
    agent_id: i64,
    project_id: Option<String>,
    body: String,
    schedule: Schedule,
}
fn identity_current(store: &troop_storage::Store, rule: &Value) -> Result<(), String> {
    store.memory_agent(rule["agent_id"].as_i64().ok_or("提醒 Agent 无效。")?)?;
    if let Some(project) = rule["project_id"].as_str() {
        if !store
            .memory_projects(rule["agent_id"].as_i64().unwrap())?
            .as_array()
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["slug"] == project && item["joined"] == true)
            })
        {
            return Err("提醒项目成员资格已失效。".into());
        }
    }
    Ok(())
}
fn require_rule(store: &troop_storage::Store, id: &str) -> Result<Value, String> {
    let value = store.rule_get(id)?;
    if value["kind"] != "reminder" {
        return Err("该规则不是时间提醒。".into());
    }
    Ok(value)
}
fn revise(value: &Value, expected: i64) -> Result<(), troop_storage::OperationFailure> {
    crate::groups::check_revision(Some(value), expected)
}
fn notify(
    store: &troop_storage::Store,
    rule: &Value,
    slot_id: i64,
    now: i64,
    deadline: i64,
    manual: bool,
) -> Result<Value, String> {
    store.reminder_add_notification(json!({"rule_id":rule["id"],"rule_revision":rule["revision"],"slot_id":slot_id,"title":rule["name"],"body":rule["body"],"agent_id":rule["agent_id"],"project_id":rule["project_id"],"state":"pending","reason":null,"created_at_ms":now,"deadline_ms":deadline,"manual":manual,"read_at_ms":null}))
}
fn advance(
    store: &troop_storage::Store,
    rule: &Value,
    now: i64,
    boot: i64,
    missed: bool,
    limit: usize,
    forced: Option<&str>,
) -> Result<(), String> {
    let id = rule["id"].as_str().ok_or("提醒身份无效。")?;
    let Some(mut state) = store.reminder_state(id)? else {
        return Ok(());
    };
    let schedule: Schedule =
        serde_json::from_value(rule["schedule"].clone()).map_err(|e| e.to_string())?;
    if missed {
        state["missed_through_ms"] =
            json!(state["missed_through_ms"].as_i64().unwrap_or(0).max(now));
    }
    let missed_through = state["missed_through_ms"].as_i64().unwrap_or(0);
    for _ in 0..limit {
        let Some(raw) = state.get("next_slot").filter(|v| !v.is_null()) else {
            break;
        };
        let slot: troop_protocol::schedule::Slot =
            serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        if slot.at_ms > now {
            break;
        }
        let reason = forced.map(str::to_owned).or_else(|| {
            if slot.state == "dst_gap" {
                Some("夏令时缺失时刻，已跳过。".into())
            } else if rule["cancelled"] == true {
                Some("提醒已取消。".into())
            } else if rule["enabled"] != true {
                Some("提醒已暂停。".into())
            } else if slot.at_ms <= missed_through
                || slot.at_ms <= boot
                || now - slot.at_ms > GRACE_MS
            {
                Some("退出、休眠或调度延迟错过触发，已跳过。".into())
            } else {
                identity_current(store, rule).err()
            }
        });
        let phase = if reason.is_some() {
            "skipped"
        } else {
            "triggered"
        };
        if let Some(slot_id) = store.reminder_record_slot(
            rule,
            raw,
            phase,
            reason.as_deref().unwrap_or("时间条件已接纳。"),
            now,
        )? {
            if reason.is_none() {
                notify(store, rule, slot_id, now, slot.at_ms + GRACE_MS, false)?;
            }
        }
        state["next_slot"] =
            serde_json::to_value(schedule.following(&slot)?).map_err(|e| e.to_string())?;
    }
    state["watermark_ms"] = json!(state["watermark_ms"].as_i64().unwrap_or(0).max(now));
    store.reminder_save_state(id, state)
}
pub(crate) fn save(
    store: &mut troop_storage::Store,
    input: Value,
    author: Value,
    now: i64,
) -> Result<Value, troop_storage::OperationFailure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Save {
        id: Option<String>,
        expected_revision: i64,
        rule: Definition,
    }
    let request = params::<Save>(input)?;
    if request.rule.kind != "reminder"
        || request.rule.event != "time.due"
        || !crate::groups::text_valid(&request.rule.name, 120, true)
        || !crate::groups::text_valid(&request.rule.body, 4000, true)
    {
        return Err("提醒名称、正文或类型无效。".to_owned().into());
    }
    request.rule.schedule.validate()?;
    let id = request
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    uuid::Uuid::parse_str(&id).map_err(|_| "提醒身份无效。".to_owned())?;
    let old = store.rule_get(&id).ok();
    if let Some(old) = &old {
        if old["kind"] != "reminder" || old["cancelled"] == true {
            return Err("规则类型已变化或提醒已取消。".to_owned().into());
        }
        revise(old, request.expected_revision)?;
        advance(
            store,
            old,
            now,
            now,
            true,
            1024,
            Some("旧修订尚未派发的触发已跳过。"),
        )?;
        if store.reminder_state(&id)?.is_some_and(|state| {
            state["next_slot"]["at_ms"]
                .as_i64()
                .is_some_and(|time| time <= now)
        }) {
            return Err("正在整理错过的触发，请稍后修改。".to_owned().into());
        }
    } else if request.expected_revision != 0 {
        return Err("提醒修订冲突。".to_owned().into());
    }
    let rule = serde_json::to_value(request.rule).map_err(|e| e.to_string())?;
    identity_current(store, &rule)?;
    let anchor = store
        .reminder_state(&id)?
        .and_then(|state| state["watermark_ms"].as_i64())
        .unwrap_or(now)
        .max(now);
    let schedule: Schedule =
        serde_json::from_value(rule["schedule"].clone()).map_err(|e| e.to_string())?;
    let next = schedule.next(anchor)?;
    if rule["enabled"] == true && next.is_none() {
        return Err("该提醒没有未来触发，请修改时间。".to_owned().into());
    }
    let mut rule = rule;
    rule["cancelled"] = json!(false);
    let saved = store.rule_save(&id, request.expected_revision, rule, author)?;
    store.reminder_cancel_pending(&id, "提醒修订已变化，旧通知未提交。")?;
    store.reminder_save_state(
        &id,
        json!({"next_slot":next,"watermark_ms":anchor,"rule_revision":saved["revision"]}),
    )?;
    project_rule(store, saved)
}
fn project_rule(
    store: &troop_storage::Store,
    mut rule: Value,
) -> Result<Value, troop_storage::OperationFailure> {
    let state = store.reminder_state(
        rule["id"]
            .as_str()
            .ok_or_else(|| "提醒身份无效。".to_owned())?,
    )?;
    rule["next_slot"] = state
        .as_ref()
        .map(|s| s["next_slot"].clone())
        .unwrap_or(Value::Null);
    let cancelled = rule["cancelled"] == true;
    rule["phase"] = json!(if cancelled {
        "cancelled"
    } else if rule["enabled"] != true {
        "paused"
    } else if rule["next_slot"].is_null() {
        "completed"
    } else {
        "active"
    });
    rule["allowed_actions"] = json!({"save":{"allowed":!cancelled,"reason":if cancelled{Some("提醒已取消，请新建规则。")}else{None}},"cancel":{"allowed":!cancelled,"reason":if cancelled{Some("提醒已取消。")}else{None}},"run":{"allowed":!cancelled&&identity_current(store,&rule).is_ok(),"reason":if cancelled{Some("提醒已取消。".to_owned())}else{identity_current(store,&rule).err()}}});
    Ok(rule)
}
fn public_notification(mut value: Value) -> Value {
    value["allowed_actions"] = json!({"read":{"allowed":value["read_at_ms"].is_null(),"reason":if value["read_at_ms"].is_null(){None}else{Some("通知已读。")}}});
    value
}
pub(crate) fn read(
    store: &troop_storage::Store,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Id {
        id: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct History {
        id: String,
        before: Option<i64>,
    }
    match method {
        "notifications.pending" => {
            if input != json!({}) {
                return Err("通知查询参数无效。".into());
            }
            Ok(json!({"pending":!store.reminder_pending()?.is_empty()}))
        }
        "reminders.get" => project_rule(store, require_rule(store, &params::<Id>(input)?.id)?)
            .map_err(|e| e.message),
        "reminders.history" => {
            let query = params::<History>(input)?;
            require_rule(store, &query.id)?;
            crate::groups::paginate(store.reminder_history(&query.id, query.before)?, Ok)
        }
        "notifications.list" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                rule_id: Option<String>,
                before: Option<i64>,
            }
            let query = params::<Query>(input)?;
            crate::groups::paginate(
                store.reminder_notifications(query.rule_id.as_deref(), query.before)?,
                |value| Ok(public_notification(value)),
            )
        }
        "notifications.preferences" => {
            if input != json!({}) {
                return Err("通知设置查询参数无效。".into());
            }
            store.reminder_preferences()
        }
        _ => Err("提醒写操作需要操作账本。".into()),
    }
}
pub(crate) fn write(
    store: &mut troop_storage::Store,
    method: &str,
    input: Value,
    now: i64,
) -> Result<Value, troop_storage::OperationFailure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Revision {
        id: String,
        expected_revision: i64,
    }
    match method {
        "rules.save" => save(store, input, json!({"kind":"desktop"}), now),
        "reminders.run" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Run {
                id: String,
                expected_revision: i64,
                client_trigger_id: String,
                source_slot_id: Option<i64>,
            }
            let request = params::<Run>(input)?;
            let rule = require_rule(store, &request.id)?;
            revise(&rule, request.expected_revision)?;
            identity_current(store, &rule)?;
            if rule["cancelled"] == true {
                return Err("提醒已取消。".to_owned().into());
            }
            uuid::Uuid::parse_str(&request.client_trigger_id)
                .map_err(|_| "手动触发身份无效。".to_owned())?;
            if let Some(id) = request.source_slot_id {
                if store.reminder_slot(id)?["rule_id"] != request.id {
                    return Err("原触发记录不属于该提醒。".to_owned().into());
                }
            }
            let key = format!("manual:{}", request.client_trigger_id);
            if let Some(value) = store.reminder_manual_notification(&request.id, &key)? {
                return Ok(public_notification(value));
            }
            let slot = troop_protocol::schedule::manual_slot(
                rule["schedule"]["timezone"]
                    .as_str()
                    .ok_or_else(|| "时区无效。".to_owned())?,
                now,
                &request.client_trigger_id,
            )?;
            let mut slot = serde_json::to_value(slot).map_err(|e| e.to_string())?;
            slot["source_slot_id"] = json!(request.source_slot_id);
            let id = store
                .reminder_record_slot(&rule, &slot, "triggered", "用户明确手动触发。", now)?
                .ok_or_else(|| "手动触发记录已存在。".to_owned())?;
            notify(store, &rule, id, now, now + GRACE_MS, true)
                .map(public_notification)
                .map_err(Into::into)
        }
        "reminders.cancel" => {
            let request = params::<Revision>(input)?;
            let old = require_rule(store, &request.id)?;
            revise(&old, request.expected_revision)?;
            let mut value = old.clone();
            for key in [
                "id",
                "revision",
                "after_event",
                "author",
                "updated_at",
                "created_at_ms",
                "effective_from_ms",
            ] {
                value.as_object_mut().unwrap().remove(key);
            }
            value["enabled"] = json!(false);
            value["cancelled"] = json!(true);
            let saved = store.rule_save(
                &request.id,
                request.expected_revision,
                value,
                json!({"kind":"desktop"}),
            )?;
            store.reminder_cancel_pending(&request.id, "提醒已取消。")?;
            project_rule(store, saved)
        }
        "notifications.preferences.save" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Preferences {
                expected_revision: i64,
                enabled: bool,
            }
            let request = params::<Preferences>(input)?;
            let old = store.reminder_preferences()?;
            revise(&old, request.expected_revision)?;
            let mut value = old;
            value["enabled"] = json!(request.enabled);
            store.reminder_save_preferences(value).map_err(Into::into)
        }
        "notifications.read" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Read {
                id: i64,
                expected_revision: i64,
            }
            let request = params::<Read>(input)?;
            let mut value = store.reminder_notification(request.id)?;
            revise(&value, request.expected_revision)?;
            value["read_at_ms"] = json!(now);
            store
                .reminder_save_notification(value)
                .map(public_notification)
                .map_err(Into::into)
        }
        "notifications.claim" => claim(store, input, now),
        "notifications.complete" => complete(store, input, now),
        _ => Err("未知提醒操作。".to_owned().into()),
    }
}
fn claim(
    store: &troop_storage::Store,
    input: Value,
    now: i64,
) -> Result<Value, troop_storage::OperationFailure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Claim {
        consumer_id: String,
        focused: bool,
    }
    let request = params::<Claim>(input)?;
    uuid::Uuid::parse_str(&request.consumer_id).map_err(|_| "通知消费者身份无效。".to_owned())?;
    let preferences = store.reminder_preferences()?;
    let pending = store.reminder_pending()?;
    for mut value in pending {
        let rule = require_rule(
            store,
            value["rule_id"]
                .as_str()
                .ok_or_else(|| "通知来源无效。".to_owned())?,
        )?;
        let reason = if value["deadline_ms"].as_i64().unwrap_or(0) < now {
            Some(("expired", "已错过系统通知投递窗口。".to_owned()))
        } else if rule["cancelled"] == true
            || rule["revision"] != value["rule_revision"]
            || (rule["enabled"] != true && value["manual"] != true)
        {
            Some(("cancelled", "提醒修订已变化或已停用。".to_owned()))
        } else if let Err(reason) = identity_current(store, &rule) {
            Some(("cancelled", reason))
        } else if preferences["enabled"] != true {
            Some((
                "suppressed",
                "系统通知开关已关闭，记录仍可查看。".to_owned(),
            ))
        } else if request.focused {
            Some(("suppressed", "应用当前获得焦点，记录仍可查看。".to_owned()))
        } else if store.reminder_notification_recent(now - GRACE_MS)? {
            Some(("suppressed", "系统通知频率限制，记录仍可查看。".to_owned()))
        } else {
            None
        };
        if let Some((state, reason)) = reason {
            value["state"] = json!(state);
            value["reason"] = json!(reason);
            store.reminder_save_notification(value)?;
            continue;
        }
        value["state"] = json!("dispatching");
        value["consumer_id"] = json!(request.consumer_id);
        value["attempt_id"] = json!(uuid::Uuid::new_v4().to_string());
        value["claimed_at_ms"] = json!(now);
        return Ok(
            json!({"notification":public_notification(store.reminder_save_notification(value)?)}),
        );
    }
    Ok(json!({"notification":null}))
}
fn complete(
    store: &troop_storage::Store,
    input: Value,
    now: i64,
) -> Result<Value, troop_storage::OperationFailure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Complete {
        id: i64,
        expected_revision: i64,
        consumer_id: String,
        attempt_id: String,
        outcome: String,
        reason: String,
    }
    let request = params::<Complete>(input)?;
    let mut value = store.reminder_notification(request.id)?;
    if request.expected_revision < 1
        || request.expected_revision > value["revision"].as_i64().unwrap_or(0)
    {
        return Err("通知回应修订无效。".to_owned().into());
    }
    if value["state"] != "dispatching"
        || value["consumer_id"] != request.consumer_id
        || value["attempt_id"] != request.attempt_id
        || !matches!(
            request.outcome.as_str(),
            "shown" | "failed" | "indeterminate" | "expired"
        )
        || !crate::groups::text_valid(&request.reason, 1000, false)
    {
        return Err("通知回应已过期或结果无效。".to_owned().into());
    }
    value["state"] = json!(request.outcome);
    value["reason"] = json!(request.reason);
    value["completed_at_ms"] = json!(now);
    store
        .reminder_save_notification(value)
        .map(public_notification)
        .map_err(Into::into)
}
pub(crate) fn pump(store: &mut troop_storage::Store, clock: &mut Clock) -> Result<(), String> {
    let now = clock.now()?;
    let missed = now - clock.last_tick_ms > GRACE_MS;
    if missed {
        clock.missed_through_ms = clock.missed_through_ms.max(now);
    }
    clock.last_tick_ms = now;
    for rule in store.rules_all()?["items"]
        .as_array()
        .ok_or("规则列表无效。")?
    {
        if rule["kind"] != "reminder" {
            continue;
        }
        let id = rule["id"].as_str().ok_or("提醒身份无效。")?;
        if !store.reminder_state(id)?.is_some_and(|state| {
            state["next_slot"]["at_ms"]
                .as_i64()
                .is_some_and(|time| time <= now)
        }) {
            continue;
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let (receipt, _) = store.execute_operation(
            "scheduler",
            &operation,
            "reminders.tick",
            &json!({"rule_id":id,"at_ms":now}),
            None,
            |store| {
                advance(
                    store,
                    rule,
                    now,
                    clock.boot_ms.max(clock.missed_through_ms),
                    missed,
                    4,
                    None,
                )?;
                Ok((json!({"advanced":true}), ()))
            },
        )?;
        if receipt["state"] == "rejected" {
            eprintln!("Reminder deferred: {}", receipt["error"]["message"]);
        }
    }
    Ok(())
}
