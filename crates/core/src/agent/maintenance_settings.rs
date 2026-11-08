use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    agent_id: i64,
    expected_revision: i64,
    enabled: bool,
    provider_id: Option<String>,
    model: Option<String>,
    #[serde(default)]
    target_scope: Option<String>,
    #[serde(default)]
    target_project: String,
}
impl Manager {
    pub(super) fn save_maintenance_settings(
        &self,
        store: &mut Store,
        input: Value,
    ) -> Result<Value, String> {
        let a = params::<Settings>(input)?;
        let scope = a.target_scope.as_deref().unwrap_or("agent");
        if !matches!(scope, "agent" | "user" | "project")
            || (scope != "project" && !a.target_project.is_empty())
            || (scope == "project" && !troop_storage::memory::slug(&a.target_project))
            || (a.enabled
                && scope == "project"
                && !store
                    .memory_projects(a.agent_id)?
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|project| {
                        project["slug"] == a.target_project && project["joined"] == true
                    }))
        {
            return Err("维护目标超出当前记忆范围或项目成员资格。".into());
        }
        if a.model.as_ref().is_some_and(|v| {
            v.trim().is_empty() || v.len() > 200 || v.chars().any(char::is_control)
        }) || a
            .provider_id
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 128)
        {
            return Err("维护模型或服务标识无效。".into());
        }
        let destination = if a.enabled {
            let provider =
                store.provider(a.provider_id.as_deref().ok_or("请选择维护模型服务。")?)?;
            let mut config: Config =
                serde_json::from_value(provider.config).map_err(|_| "维护模型配置无效。")?;
            config.model = a
                .model
                .clone()
                .filter(|v| !v.trim().is_empty() && v.len() <= 200)
                .ok_or("维护模型名称无效。")?;
            let endpoint = config.endpoint()?.to_string();
            if endpoint.len() > 2048 {
                return Err("维护目的地地址过长。".into());
            }
            Some(endpoint)
        } else {
            None
        };
        let previous = store.maintenance_settings(a.agent_id)?;
        let saved=store.maintenance_save(a.agent_id,a.expected_revision,json!({"enabled":a.enabled,"provider_id":a.provider_id,"model":a.model,"destination":destination,"purpose":"memory_maintenance","target_scope":scope,"target_project":a.target_project}))?;
        let changed_scope = previous["target_scope"] != saved["target_scope"]
            || previous["target_project"] != saved["target_project"];
        if !a.enabled || changed_scope {
            for mut job in store.maintenance_agent_pending(a.agent_id)? {
                if matches!(
                    job["state"].as_str(),
                    Some("queued" | "waiting_configuration" | "running" | "validating")
                ) {
                    job["state"] =
                        json!(if job["maintenance_revision"].is_null() && !changed_scope {
                            "waiting_configuration"
                        } else {
                            "cancelled"
                        });
                    job["error"] = json!("记忆维护授权已关闭或目标范围已变化。");
                    store.memory_job_save(&job)?;
                }
            }
        }
        Ok(saved)
    }
    pub(super) fn maintenance_settings_committed(
        &mut self,
        store: &Store,
        agent: i64,
    ) -> Result<(), String> {
        for id in self.memory_queue.iter().copied().collect::<Vec<_>>() {
            let job = store.memory_job(id)?;
            if job["agent_id"] == agent && job["state"] == "cancelled" {
                self.memory_queue.remove(&id);
            }
        }
        for id in self.maintenance.keys().copied().collect::<Vec<_>>() {
            let job = store.memory_job(id)?;
            if job["agent_id"] == agent && job["state"] == "cancelled" {
                if let Some(handle) = self.maintenance.remove(&id) {
                    handle.abort();
                }
                self.memory_queue.remove(&id);
            }
        }
        Ok(())
    }
    pub(super) fn freeze_maintenance(&self, store: &Store, job: &mut Value) -> Result<(), String> {
        let settings =
            store.maintenance_settings(job["agent_id"].as_i64().ok_or("维护身份无效。")?)?;
        if settings["enabled"] != true {
            return Err("请配置并授权独立记忆维护模型。".into());
        }
        self.check_maintenance_scope(store, job, &settings)?;
        let provider =
            store.provider(settings["provider_id"].as_str().ok_or("维护服务未配置。")?)?;
        let mut config: Config =
            serde_json::from_value(provider.config).map_err(|_| "维护模型配置无效。")?;
        config.model = settings["model"]
            .as_str()
            .ok_or("维护模型未配置。")?
            .to_owned();
        if json!(config.endpoint()?.to_string()) != settings["destination"] {
            return Err("维护服务地址已变化，请重新保存授权。".into());
        }
        job["provider_id"] = settings["provider_id"].clone();
        job["maintenance_revision"] = settings["revision"].clone();
        job["destination"] = settings["destination"].clone();
        job["config"] = serde_json::to_value(config).map_err(|e| e.to_string())?;
        job["secret_ref"] = json!(provider.secret_ref);
        Ok(())
    }
    pub(super) fn maintenance_authorized(&self, store: &Store, job: &Value) -> Result<(), String> {
        let settings =
            store.maintenance_settings(job["agent_id"].as_i64().ok_or("维护身份无效。")?)?;
        if settings["enabled"] != true {
            return Err("记忆维护模型授权已关闭。".into());
        }
        self.check_maintenance_scope(store, job, &settings)?;
        let provider = store.provider(job["provider_id"].as_str().ok_or("维护服务未配置。")?)?;
        let config: Config =
            serde_json::from_value(provider.config).map_err(|_| "维护服务配置无效。")?;
        if json!(config.endpoint()?.to_string()) != job["destination"] {
            return Err("维护服务地址已变化，旧尝试已失效。".into());
        }
        Ok(())
    }
    pub(super) fn check_maintenance_scope(
        &self,
        store: &Store,
        job: &Value,
        settings: &Value,
    ) -> Result<(), String> {
        let scope = job["target_scope"].as_str().unwrap_or("agent");
        let project = job["target_project"].as_str().unwrap_or("");
        if settings["target_scope"] != scope || settings["target_project"] != project {
            return Err("维护目标范围已变化，旧作业不再获授权。".into());
        }
        if scope == "project" {
            let run = store.agent_run(job["source_run_id"].as_i64().ok_or("维护来源无效。")?)?;
            let projects = store.memory_projects(job["agent_id"].as_i64().unwrap())?;
            if !run["project_ids"]
                .as_array()
                .is_some_and(|ids| ids.contains(&json!(project)))
                || !projects
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["slug"] == project && row["joined"] == true)
            {
                return Err("维护项目超出来源任务范围或成员资格已撤销。".into());
            }
        }
        Ok(())
    }
}
