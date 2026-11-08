//! Run/Task lifecycle rules shared by online controllers and startup recovery.
//! No storage, model wire format, or process I/O lives here. JSON record shapes remain
//! compatible with existing databases; adapters persist a complete transition atomically.
use serde_json::{json, Value};

#[cfg(test)]
mod tests;

pub fn run_final(run: &Value) -> bool {
    matches!(
        run["state"].as_str(),
        Some("completed" | "failed" | "cancelled")
    )
}

pub fn run_terminal(run: &Value) -> bool {
    run_final(run) || run["state"] == "interrupted"
}

pub fn task_active(task: &Value) -> bool {
    matches!(
        task["state"].as_str(),
        Some("queued" | "dispatched" | "running" | "cancelling")
    )
}

pub fn needs_review(record: &Value) -> bool {
    record["state"] == "indeterminate" && record["reviewed"] != true
}

pub fn task_unresolved(task: &Value) -> bool {
    matches!(
        task["state"].as_str(),
        Some("indeterminate" | "interrupted")
    ) && task["reviewed"] != true
}

pub fn invocation_holds_resource(inv: &Value) -> bool {
    needs_review(inv) && inv["stopped"] != true
}

/// Relations are durable facts, not conclusions supplied by each caller.
#[derive(Default)]
pub struct Relations<'a> {
    pub tasks: &'a [Value],
    pub hooks: &'a [Value],
    pub connections: &'a [Value],
    /// The owning Task and its Run, when this Run is a child.
    pub parent: Option<(&'a Value, &'a Value)>,
}

pub fn subtree(root: i64, tasks: &[Value]) -> Vec<i64> {
    let mut runs = vec![root];
    loop {
        let count = runs.len();
        for task in tasks {
            if task["owner_run_id"]
                .as_i64()
                .is_some_and(|id| runs.contains(&id))
            {
                if let Some(child) = task["child_run_id"].as_i64() {
                    if !runs.contains(&child) {
                        runs.push(child);
                    }
                }
            }
        }
        if count == runs.len() {
            return runs;
        }
    }
}

/// A fence never clears an existing cancellation/failure intent, nor reopens a final Run.
pub fn fence_run(run: &mut Value, intent: Option<&str>) -> bool {
    if run_final(run) {
        return false;
    }
    if run["intent"].is_null() {
        run["intent"] = json!(intent);
    }
    run["state"] = json!("cancelling");
    true
}

pub fn begin_failure_cleanup(run: &mut Value, tree: &[i64], tasks: &[Value]) -> bool {
    if run["state"] != "failed"
        || !tasks.iter().any(|t| {
            t["owner_run_id"]
                .as_i64()
                .is_some_and(|id| tree.contains(&id))
                && task_active(t)
        })
    {
        return false;
    }
    run["state"] = json!("cancelling");
    true
}

pub fn begin_stop(run: &mut Value, invocations: &[Value], cancel: bool) -> Option<&'static str> {
    if run_final(run) {
        return None;
    }
    if cancel && run["intent"].is_null() {
        run["intent"] = json!("cancel");
    }
    if run["state"] == "interrupted" && invocations.iter().any(invocation_holds_resource) {
        return Some("stop_unconfirmed");
    }
    run["state"] = json!("cancelling");
    run["waiting"] = json!([]);
    Some("stop_requested")
}

pub fn finish_stop(
    run: &mut Value,
    invocations: &mut [Value],
    relations: &Relations<'_>,
    runtime_busy: bool,
) -> bool {
    if runtime_busy || relations.tasks.iter().any(task_active) {
        return false;
    }
    let unresolved = relations.connections.iter().any(needs_review)
        || relations.hooks.iter().any(needs_review)
        || relations.tasks.iter().any(task_unresolved)
        || invocations.iter().any(invocation_holds_resource);
    for inv in invocations {
        if inv["state"] == "prepared" {
            inv["state"] = json!("cancelled");
            inv["result"] = json!({"ok":false,"error":"未派发，任务已停止。"});
        }
    }
    run["state"] = json!(if unresolved {
        "interrupted"
    } else if run["intent"] == "failure" {
        "failed"
    } else if run["intent"] == "cancel" {
        "cancelled"
    } else {
        "interrupted"
    });
    run["waiting"] = json!([]);
    if run["intent"] != "failure" {
        run["error"] = json!(if unresolved {
            "Owned work or process stop requires reconciliation; previous work will not be replayed."
        } else if run["intent"] == "cancel" {
            "任务已停止；已发生的效果和文件保留。"
        } else {
            "应用退出或执行中断；请核对记录后手动继续。"
        });
    }
    true
}

/// Shared preflight for command admission and frontend action availability.
pub fn validate_resume(
    run: &Value,
    invocations: &[Value],
    relations: &Relations<'_>,
) -> Result<(), String> {
    if relations.connections.iter().any(needs_review) {
        return Err("Reconcile MCP process stops before continuing".into());
    }
    if let Some((task, owner)) = relations.parent {
        if run_terminal(owner)
            || !owner["intent"].is_null()
            || task["consumed"] == true
            || task["reviewed"] == true
            || task["stop_requested"] == true
        {
            return Err(
                "Resume the owner first; cancelled or acknowledged child work cannot be restarted"
                    .into(),
            );
        }
    }
    if relations
        .tasks
        .iter()
        .any(|t| task_active(t) || task_unresolved(t))
    {
        return Err(
            "Reconcile all owned tasks before continuing; previous jobs will not be replayed"
                .into(),
        );
    }
    if relations.hooks.iter().any(needs_review) {
        return Err(
            "Reconcile interrupted Hooks before continuing; no old Hook will replay".into(),
        );
    }
    if run["state"] != "interrupted" || !run["intent"].is_null() {
        return Err("只有没有终止意图的中断任务可以手动继续。".into());
    }
    if invocations.iter().any(needs_review) {
        return Err("请先核对所有结果不明的工具；不会自动重放旧操作。".into());
    }
    Ok(())
}

/// Returns settled pending results for the model-history adapter, never work to replay.
pub fn resume(
    run: &mut Value,
    invocations: &mut [Value],
    relations: &Relations<'_>,
) -> Result<Vec<Value>, String> {
    validate_resume(run, invocations, relations)?;
    let epoch = run["epoch"]
        .as_i64()
        .and_then(|e| e.checked_add(1))
        .ok_or("执行代次无效。")?;
    let pending = run["pending"].as_array().cloned().unwrap_or_default();
    let mut results = vec![];
    for inv in invocations {
        if pending.contains(&inv["id"]) {
            if matches!(inv["state"].as_str(), Some("prepared" | "cancelled")) {
                inv["state"] = json!("cancelled");
                inv["result"] =
                    json!({"ok":false,"error":"旧计划在中断时失效，未派发；需要重新评估。"});
            }
            results.push(inv.clone());
        }
    }
    run["epoch"] = json!(epoch);
    run["pending"] = json!([]);
    run["state"] = json!("queued");
    run["waiting"] = json!([]);
    run["error"] = Value::Null;
    Ok(results)
}

pub fn recover_run(run: &mut Value, invocations: &mut [Value]) -> bool {
    if run_terminal(run)
        || (run["kind"] == "external_cli"
            && run["waiting"] == json!(["review"])
            && run["intent"].is_null())
    {
        return false;
    }
    for inv in invocations {
        if matches!(inv["state"].as_str(), Some("dispatched" | "running")) {
            inv["state"] = json!("indeterminate");
            inv["reviewed"] = json!(false);
            inv["stopped"] = json!(false);
        }
    }
    run["state"] = json!("interrupted");
    run["waiting"] = json!([]);
    run["error"] = json!("上次执行中断；请核对工具记录后手动继续，旧操作不会自动重放。");
    true
}

pub fn recover_task(task: &mut Value) -> bool {
    if !task_active(task) {
        return false;
    }
    let dispatched = matches!(
        task["state"].as_str(),
        Some("dispatched" | "running" | "cancelling")
    );
    let process_task = matches!(task["kind"].as_str(), Some("background" | "external_cli"));
    task["state"] = json!(if process_task && dispatched {
        "indeterminate"
    } else {
        "interrupted"
    });
    task["stopped"] = json!(!process_task || !dispatched);
    task["result"] = json!({"ok":false,"error":"Execution interrupted; reconcile before manual continuation. Previous work will not be replayed."});
    true
}

pub fn stop_task(task: &mut Value, running: bool, subtree: bool) -> bool {
    if task["kind"] == "external_cli"
        && task["state"] == "awaiting_review"
        && task["stopped"] == true
    {
        task["stop_requested"] = json!(true);
        task["state"] = json!("cancelled");
        return true;
    }
    if !task_active(task) {
        return false;
    }
    task["stop_requested"] = json!(true);
    // Preserve the existing child projection during a tree stop: the child's final
    // result will update its owning Task. A direct Task stop immediately says cancelling.
    if subtree && !matches!(task["kind"].as_str(), Some("background" | "external_cli")) {
        return true;
    }
    if running || task["child_run_id"].as_i64().is_some() {
        task["state"] = json!("cancelling");
    } else {
        task["state"] = json!("cancelled");
        task["stopped"] = json!(true);
        task["result"] = json!({"ok":false,"error":"Cancelled before dispatch"});
    }
    true
}

pub fn complete_background(task: &mut Value, result: Value) {
    task["stopped"] = result["stopped"].clone();
    task["state"] = json!(
        if result["indeterminate"] == true || result["stopped"] != true {
            "indeterminate"
        } else if result["ok"] == true && result["value"]["exit_code"] == 0 {
            "succeeded"
        } else {
            "failed"
        }
    );
    task["result"] = result;
}

pub fn complete_child(task: &mut Value, child: &Value) -> bool {
    if task["kind"] != "agent" || !task_active(task) || !run_terminal(child) {
        return false;
    }
    let state = if child["state"] == "completed" {
        "succeeded"
    } else {
        child["state"].as_str().unwrap_or("interrupted")
    };
    task["state"] = json!(state);
    task["stopped"] = json!(true);
    let full = child["output"].as_str().unwrap_or("");
    let mut size = 0;
    let output = full
        .chars()
        .take_while(|c| {
            size += c.len_utf8();
            size <= 6000
        })
        .collect::<String>();
    task["result"] = json!({"ok":state=="succeeded","output":output,"output_truncated":output.len()<full.len(),"error":child["error"],"child_run_id":child["id"]});
    true
}

pub enum Evidence {
    Receipt(Value),
    Reviewed(String),
    Invalid,
}

pub fn reconcile_invocation(
    run: &Value,
    inv: &mut Value,
    epoch: i64,
    evidence: Evidence,
) -> Result<(), String> {
    if inv["epoch"] != epoch || inv["state"] != "indeterminate" || !run_terminal(run) {
        return Err("此调用当前不需要核对或仍在运行。".into());
    }
    match evidence {
        Evidence::Receipt(r) => {
            if r["id"] != inv["id"]
                || r["epoch"] != epoch
                || r["status"] != "finished"
                || !r["result"]["ok"].is_boolean()
            {
                return Err("Worker 尚无已提交的最终结果。".into());
            }
            if r["result"]["indeterminate"] == true {
                return Err("Worker 回执仍标记效果不明，请人工核对后填写结论。".into());
            }
            if r["result"]["stopped"] != true {
                return Err("此回执尚未确认进程树已退出，请人工核对停止状态。".into());
            }
            inv["state"] = json!(if r["result"]["ok"] == true
                && r["result"]["value"]["exit_code"]
                    .as_i64()
                    .is_none_or(|n| n == 0)
            {
                "succeeded"
            } else {
                "failed"
            });
            inv["result"] = r["result"].clone();
        }
        Evidence::Reviewed(note) if !note.trim().is_empty() && note.len() <= 2000 => {
            inv["review_note"] = json!(note);
            inv["result"] = json!({"ok":false,"indeterminate":true,"review_note":note,"error":"操作效果由用户核对，禁止自动重放此调用。"});
        }
        _ => return Err("请选择有效回执，或填写已核对效果与停止状态的说明。".into()),
    }
    inv["reviewed"] = json!(true);
    inv["stopped"] = json!(true);
    Ok(())
}

pub fn reconcile_task(
    owner: &Value,
    task: &mut Value,
    epoch: i64,
    child_clear: bool,
    evidence: Evidence,
) -> Result<(), String> {
    if task["epoch"] != epoch || !task_unresolved(task) || !run_terminal(owner) {
        return Err("Task is not available for reconciliation".into());
    }
    if task["kind"] == "agent" && !child_clear {
        return Err("Reconcile the child invocations and owned work first".into());
    }
    match evidence {
        Evidence::Receipt(r)
            if matches!(task["kind"].as_str(), Some("background" | "external_cli")) =>
        {
            if r["id"] != task["id"]
                || r["epoch"] != epoch
                || r["status"] != "finished"
                || r["result"]["stopped"] != true
                || r["result"]["indeterminate"] == true
                || !r["result"]["ok"].is_boolean()
            {
                return Err("Receipt does not confirm both result and process-tree stop".into());
            }
            if task["kind"] == "external_cli" {
                task["result"] = r["result"].clone();
            } else {
                complete_background(task, r["result"].clone());
            }
        }
        Evidence::Reviewed(note) if !note.trim().is_empty() && note.len() <= 2000 => {
            task["result"] = json!({"ok":false,"indeterminate":true,"review_note":note});
            task["review_note"] = json!(note);
        }
        _ => {
            return Err(
                "Provide a final receipt or a review of effects and process-tree stop".into(),
            )
        }
    }
    task["reviewed"] = json!(true);
    task["stopped"] = json!(true);
    Ok(())
}
