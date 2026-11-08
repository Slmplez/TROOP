//! SQLite adapter for complete Run/Task lifecycle transitions. Domain decisions live
//! in troop_protocol::lifecycle; controllers supply runtime facts and perform I/O only
//! after these commands return successfully.
use super::{agent::commit_agent, Store};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use troop_protocol::lifecycle::{self as rules, Evidence, Relations};

#[cfg(test)]
mod tests;

pub struct StopPlan {
    pub runs: Vec<i64>,
    pub tasks: Vec<i64>,
}

struct Related {
    tasks: Vec<Value>,
    hooks: Vec<Value>,
    connections: Vec<Value>,
    parent: Option<(Value, Value)>,
}
impl Related {
    fn facts(&self) -> Relations<'_> {
        Relations {
            tasks: &self.tasks,
            hooks: &self.hooks,
            connections: &self.connections,
            parent: self.parent.as_ref().map(|(task, owner)| (task, owner)),
        }
    }
}

impl Store {
    fn lifecycle_relations(&self, run: &Value) -> Result<Related, String> {
        let id = run["id"].as_i64().ok_or("Invalid Run ID")?;
        let parent = if let Some(task_id) = run["owner_task_id"].as_i64() {
            let task = self.owned_task(task_id)?;
            let owner = self.agent_run(task["owner_run_id"].as_i64().ok_or("Invalid owner")?)?;
            Some((task, owner))
        } else {
            None
        };
        Ok(Related {
            tasks: self
                .owned_tasks(Self::task_root(run))?
                .into_iter()
                .filter(|t| t["owner_run_id"] == id)
                .collect(),
            hooks: self.hook_calls(id)?,
            connections: self.mcp_connections(id)?,
            parent,
        })
    }

    /// Fence every selected Run and mark its active Tasks in one transaction. The
    /// returned plan may be cancelled by runtime adapters only after this commit.
    pub fn stop_tree(
        &mut self,
        root: i64,
        intent: Option<&str>,
        running_tasks: &[i64],
    ) -> Result<StopPlan, String> {
        self.stop_tree_transaction(root, intent, running_tasks, None)
    }

    fn stop_tree_transaction(
        &mut self,
        root: i64,
        intent: Option<&str>,
        running_tasks: &[i64],
        requested_task: Option<Value>,
    ) -> Result<StopPlan, String> {
        let initial = self.agent_run(root)?;
        let mut tasks = self.owned_tasks(Self::task_root(&initial))?;
        let ids = rules::subtree(root, &tasks);
        let mut runs = ids
            .iter()
            .map(|id| self.agent_run(*id).map(|d| (*id, d)))
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let mut direct_stop = if let Some(mut task) = requested_task {
            let owner =
                self.agent_run(task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?)?;
            rules::stop_task(&mut task, false, false);
            Some((owner, task))
        } else {
            None
        };
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        if let Some((owner, task)) = &mut direct_stop {
            commit_agent(
                &tx,
                owner,
                &mut [],
                std::slice::from_mut(task),
                None,
                "owned_stop_requested",
            )?;
        }
        let run = runs.get_mut(&root).unwrap();
        if rules::begin_failure_cleanup(run, &ids, &tasks) {
            commit_agent(&tx, run, &mut [], &mut [], None, "failure_cleanup")?;
        }
        for id in &ids {
            let run = runs.get_mut(id).unwrap();
            if !rules::fence_run(run, intent) {
                continue;
            }
            run["revision"] = json!(run["revision"].as_u64().unwrap_or(0) + 1);
            tx.execute(
                "UPDATE agent_runs SET state=?1,document=?2 WHERE id=?3",
                params![run["state"].as_str(), run.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO agent_events(run_id,epoch,kind,payload) VALUES(?1,?2,'tree_stop_requested',?3)",
                params![id,run["epoch"].as_i64(),json!({"state":run["state"],"intent":run["intent"]}).to_string()]).map_err(|e| e.to_string())?;
        }
        let mut stopped_tasks = vec![];
        for task in &mut tasks {
            let owner = task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?;
            if !ids.contains(&owner) {
                continue;
            }
            let id = task["id"].as_i64().ok_or("Invalid Task ID")?;
            if !rules::stop_task(task, running_tasks.contains(&id), true) {
                continue;
            }
            commit_agent(
                &tx,
                runs.get_mut(&owner).unwrap(),
                &mut [],
                std::slice::from_mut(task),
                None,
                "owned_stop_requested",
            )?;
            stopped_tasks.push(id);
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(StopPlan {
            runs: ids,
            tasks: stopped_tasks,
        })
    }

    pub fn request_run_stop(&mut self, id: i64, cancel: bool) -> Result<Value, String> {
        let mut run = self.agent_run(id)?;
        let invocations = self.agent_invocations(id)?;
        if let Some(kind) = rules::begin_stop(&mut run, &invocations, cancel) {
            self.agent_save(&mut run, &mut [], kind)?;
        }
        Ok(run)
    }

    pub fn finish_run_stop(
        &mut self,
        id: i64,
        runtime_busy: bool,
    ) -> Result<Option<Value>, String> {
        let mut run = self.agent_run(id)?;
        let mut invocations = self.agent_invocations(id)?;
        let related = self.lifecycle_relations(&run)?;
        if !rules::finish_stop(&mut run, &mut invocations, &related.facts(), runtime_busy) {
            return Ok(None);
        }
        self.agent_save(&mut run, &mut invocations, "stopped")?;
        Ok(Some(run))
    }

    pub fn resume_blocker(&self, run: &Value) -> Result<Option<String>, String> {
        let id = run["id"].as_i64().ok_or("Invalid Run ID")?;
        let invocations = self.agent_invocations(id)?;
        let related = self.lifecycle_relations(run)?;
        let check = rules::validate_resume(run, &invocations, &related.facts()).and_then(|_| {
            self.workspace_path(run["workspace_id"].as_i64().ok_or("Invalid workspace")?)
                .map(|_| ())
        });
        Ok(check.err())
    }

    pub fn resume_run(
        &mut self,
        id: i64,
        history: impl FnOnce(&mut Value, &[Value]) -> Result<(), String>,
    ) -> Result<Value, String> {
        let mut run = self.agent_run(id)?;
        let mut invocations = self.agent_invocations(id)?;
        let related = self.lifecycle_relations(&run)?;
        let results = rules::resume(&mut run, &mut invocations, &related.facts())?;
        self.workspace_path(run["workspace_id"].as_i64().ok_or("Invalid workspace")?)?;
        history(&mut run, &results)?;
        self.agent_save(&mut run, &mut invocations, "manual_resume")?;
        Ok(run)
    }

    pub fn reconcile_invocation(
        &mut self,
        id: i64,
        epoch: i64,
        evidence: Evidence,
    ) -> Result<(), String> {
        let mut inv = self.agent_invocation(id)?;
        let mut run = self.agent_run(inv["run_id"].as_i64().ok_or("Invalid invocation owner")?)?;
        rules::reconcile_invocation(&run, &mut inv, epoch, evidence)?;
        self.agent_save(&mut run, std::slice::from_mut(&mut inv), "reconciled")
    }

    pub fn stop_owned_task(
        &mut self,
        id: i64,
        running_tasks: &[i64],
    ) -> Result<(Value, StopPlan), String> {
        let mut task = self.owned_task(id)?;
        if task["kind"] == "external_cli" && rules::task_active(&task) {
            let owner = task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?;
            let plan = self.stop_tree_transaction(owner, Some("cancel"), running_tasks, None)?;
            return Ok((self.owned_task(id)?, plan));
        }
        if !rules::task_active(&task) {
            return Ok((
                task,
                StopPlan {
                    runs: vec![],
                    tasks: vec![],
                },
            ));
        }
        if let Some(child) = task["child_run_id"].as_i64() {
            let plan =
                self.stop_tree_transaction(child, Some("cancel"), running_tasks, Some(task))?;
            return Ok((self.owned_task(id)?, plan));
        }
        if rules::stop_task(&mut task, running_tasks.contains(&id), false) {
            let mut run =
                self.agent_run(task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?)?;
            self.agent_commit(
                &mut run,
                &mut [],
                std::slice::from_mut(&mut task),
                None,
                "owned_stop_requested",
            )?;
        }
        Ok((
            task,
            StopPlan {
                runs: vec![],
                tasks: vec![id],
            },
        ))
    }

    fn task_child_clear(&self, task: &Value) -> Result<bool, String> {
        let child_clear = if task["kind"] == "agent" {
            let child_id = task["child_run_id"].as_i64().ok_or("Invalid child Run")?;
            let child = self.agent_run(child_id)?;
            !self
                .agent_invocations(child_id)?
                .iter()
                .any(rules::needs_review)
                && !self
                    .owned_tasks(Self::task_root(&child))?
                    .iter()
                    .filter(|t| t["owner_run_id"] == child_id)
                    .any(|t| rules::task_active(t) || rules::task_unresolved(t))
        } else {
            true
        };
        Ok(child_clear)
    }
    pub fn task_reconcile_blocker(
        &self,
        id: i64,
        evidence: Evidence,
    ) -> Result<Option<String>, String> {
        let mut task = self.owned_task(id)?;
        let owner = self.agent_run(task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?)?;
        let epoch = task["epoch"].as_i64().ok_or("Invalid Task epoch")?;
        let clear = self.task_child_clear(&task)?;
        Ok(rules::reconcile_task(&owner, &mut task, epoch, clear, evidence).err())
    }
    pub fn reconcile_task(
        &mut self,
        id: i64,
        epoch: i64,
        evidence: Evidence,
    ) -> Result<Value, String> {
        let mut task = self.owned_task(id)?;
        let mut owner =
            self.agent_run(task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?)?;
        let child_clear = self.task_child_clear(&task)?;
        rules::reconcile_task(&owner, &mut task, epoch, child_clear, evidence)?;
        self.agent_commit(
            &mut owner,
            &mut [],
            std::slice::from_mut(&mut task),
            None,
            "owned_reconciled",
        )?;
        Ok(task)
    }

    /// A failed recovery commit leaves both Run and Task records at their old versions.
    /// Reopening the database can retry recovery; it never dispatches effects.
    pub fn recover_executions(&mut self) -> Result<(), String> {
        let mut q = self.db.prepare("SELECT id FROM agent_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')").map_err(|e| e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        let mut runs = BTreeMap::new();
        let mut invocations = BTreeMap::new();
        for id in ids {
            runs.insert(id, self.agent_run(id)?);
            invocations.insert(id, self.agent_invocations(id)?);
        }
        let mut q = self.db.prepare("SELECT id FROM owned_tasks WHERE json_extract(document,'$.state') IN ('queued','dispatched','running','cancelling') ORDER BY id").map_err(|e| e.to_string())?;
        let task_ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        let mut tasks = vec![];
        for id in task_ids {
            let task = self.owned_task(id)?;
            let owner = task["owner_run_id"].as_i64().ok_or("Invalid Task owner")?;
            if let std::collections::btree_map::Entry::Vacant(e) = runs.entry(owner) {
                e.insert(self.agent_run(owner)?);
            }
            tasks.push(task);
        }
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
        for (id, invs) in &mut invocations {
            let run = runs.get_mut(id).unwrap();
            if rules::recover_run(run, invs) {
                commit_agent(&tx, run, invs, &mut [], None, "recovered")?;
            }
        }
        for task in &mut tasks {
            if rules::recover_task(task) {
                let owner = task["owner_run_id"].as_i64().unwrap();
                commit_agent(
                    &tx,
                    runs.get_mut(&owner).unwrap(),
                    &mut [],
                    std::slice::from_mut(task),
                    None,
                    "owned_task_recovered",
                )?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
