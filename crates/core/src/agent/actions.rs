use super::*;

fn availability(reason: Option<String>) -> Value {
    json!({"allowed":reason.is_none(),"reason":reason})
}
fn condition(ok: bool, reason: &str) -> Value {
    availability((!ok).then(|| reason.to_owned()))
}
impl Manager {
    pub(super) fn approval_blocker(&self, run: &Value, inv: &Value) -> Option<String> {
        (terminal(run)
            || !run["intent"].is_null()
            || run["epoch"] != inv["epoch"]
            || inv["state"] != "prepared"
            || !inv["approval"].is_null()
            || !(self
                .providers
                .tools
                .needs_approval(inv["name"].as_str().unwrap_or(""))
                || inv["hook_ask"] == true))
            .then(|| "此审批已失效或无需批准。".into())
    }
    pub(super) fn invocation_actions(&self, store: &Store, inv: &Value) -> Result<Value, String> {
        let run = store.agent_run(inv["run_id"].as_i64().ok_or("Invalid invocation owner")?)?;
        let epoch = inv["epoch"].as_i64().ok_or("Invalid invocation epoch")?;
        let review = if inv["reviewed"] == true {
            Some("此调用已核对。".into())
        } else {
            lifecycle::reconcile_invocation(
                &run,
                &mut inv.clone(),
                epoch,
                Evidence::Reviewed("preflight".into()),
            )
            .err()
        };
        let receipt = if review.is_some() {
            review.clone()
        } else {
            self.reconciliation_evidence(
                &Reconcile {
                    id: inv["id"].as_i64().unwrap(),
                    epoch,
                    source: "receipt".into(),
                    note: String::new(),
                },
                false,
            )
            .and_then(|e| lifecycle::reconcile_invocation(&run, &mut inv.clone(), epoch, e))
            .err()
        };
        Ok(
            json!({"approve":availability(self.authorization_blocker(store,&run).or_else(||self.approval_blocker(&run,inv))),"reconcile":availability(review),"reconcile_receipt":availability(receipt)}),
        )
    }
    pub(super) fn invocation_snapshot(&self, store: &Store, id: i64) -> Result<Value, String> {
        let mut inv = store.agent_invocation(id)?;
        inv["allowed_actions"] = self.invocation_actions(store, &inv)?;
        inv["revision"] = json!(store.execution_revision("invocation", id)?);
        Ok(inv)
    }
    pub(super) fn task_actions(&self, store: &Store, task: &Value) -> Result<Value, String> {
        let id = task["id"].as_i64().ok_or("Invalid Task ID")?;
        let epoch = task["epoch"].as_i64().ok_or("Invalid Task epoch")?;
        let review = store.task_reconcile_blocker(id, Evidence::Reviewed("preflight".into()))?;
        let receipt = if review.is_some() {
            review.clone()
        } else {
            match self.reconciliation_evidence(
                &Reconcile {
                    id,
                    epoch,
                    source: "receipt".into(),
                    note: String::new(),
                },
                true,
            ) {
                Ok(e) => store.task_reconcile_blocker(id, e)?,
                Err(e) => Some(e),
            }
        };
        Ok(
            json!({"stop":condition(lifecycle::task_active(task)&&task["state"]!="cancelling"&&task["stop_requested"]!=true,"此作业已停止或正在停止。"),"review":condition(task["state"]=="awaiting_review"&&task["stopped"]==true,"此作业尚无已封存的待审结果。"),"reconcile":availability(review),"reconcile_receipt":availability(receipt)}),
        )
    }
    pub(super) fn task_snapshot(&self, store: &Store, id: i64) -> Result<Value, String> {
        let mut task = store.owned_task(id)?;
        task["allowed_actions"] = self.task_actions(store, &task)?;
        task["revision"] = json!(store.execution_revision("task", id)?);
        if task["result"]["value"].is_object() {
            task.as_object_mut().unwrap().remove("output");
        }
        if task["kind"] == "external_cli" {
            for field in ["arguments", "baseline", "baseline_complete"] {
                task.as_object_mut().unwrap().remove(field);
            }
            if task["evidence"].is_object() {
                task.as_object_mut().unwrap().remove("result");
                task.as_object_mut().unwrap().remove("permission_plan");
            }
        }
        Ok(task)
    }
    pub(super) fn run_actions(&self, store: &Store, run: &Value) -> Result<Value, String> {
        let active = !terminal(run) && run["intent"].is_null();
        let id = run["id"].as_i64().unwrap();
        let unresolved = store
            .agent_invocations(id)?
            .iter()
            .any(lifecycle::needs_review)
            || store
                .owned_tasks(Store::task_root(run))?
                .iter()
                .any(lifecycle::task_unresolved)
            || store.hook_calls(id)?.iter().any(lifecycle::needs_review)
            || store
                .mcp_connections(id)?
                .iter()
                .any(lifecycle::needs_review);
        let can_stop = !lifecycle::run_final(run)
            && run["state"] != "cancelling"
            && (run["intent"] != "cancel" || (run["state"] == "interrupted" && !unresolved));
        let resume = if run["kind"] == "external_cli" {
            Some("先核对外部执行效果，再明确创建新作业。".into())
        } else if let Some(reason) = self.authorization_blocker(store, run) {
            Some(reason)
        } else if self.live.len() >= 16 {
            Some("活动任务已达到 16 个上限，请先停止或完成已有任务。".into())
        } else {
            store.resume_blocker(run)?
        };
        Ok(
            json!({"resume":availability(resume),"stop":condition(can_stop,"任务已结束、正在停止或仍有待核对操作。"),"steer":condition(active&&run["kind"]!="external_cli"&&run["kind"]!="tool_action","任务当前不接收补充指令。"),"compact":condition(active&&run["kind"]!="external_cli"&&run["kind"]!="tool_action"&&self.live.contains_key(&run["id"].as_i64().unwrap())&&run["compact_requested"]!=true&&run["waiting"]!=json!(["context"]),"任务不在可请求压缩的状态。")}),
        )
    }
}
