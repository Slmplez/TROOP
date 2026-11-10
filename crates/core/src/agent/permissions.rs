use super::*;

impl Manager {
    fn bound_capabilities(store: &Store, run: &Value, grant: &Value) -> Result<(), String> {
        if grant["purpose"] == "mcp_call" {
            crate::authorizations::mcp_grant_current(store, grant)?;
        } else if run["mcp_snapshot"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            return Err("绑定范围授权的执行仍缺少 MCP 权限强制能力。".into());
        }
        let current = store.hook_rules()?;
        if grant["shell"].is_object() {
            crate::sandbox::plan(grant)?;
        }
        crate::authorizations::command_hooks_current(store, grant)?;
        for binding in grant["prompt_hooks"].as_array().into_iter().flatten() {
            if !current.iter().any(|rule| {
                rule["id"] == binding["id"]
                    && rule["revision"] == binding["revision"]
                    && rule["kind"] == "prompt"
                    && rule["enabled"] == true
            }) {
                return Err("已授权提示 Hook 已停用、删除或配置发生变化。".into());
            }
        }
        for rule in run["hook_snapshot"].as_array().into_iter().flatten() {
            if run["kind"] == "tool_action" && rule["kind"] != "command" {
                return Err("直接工具动作的提示 Hook 需要有模型配置的 Agent。".into());
            }
            let field = if rule["kind"] == "command" {
                "command_hooks"
            } else {
                "prompt_hooks"
            };
            if !grant[field].as_array().is_some_and(|bindings| {
                bindings.iter().any(|binding| {
                    binding["id"] == rule["id"] && binding["revision"] == rule["revision"]
                })
            }) {
                return Err(if field == "command_hooks" {
                    "此命令 Hook 修订未获明确授权。"
                } else {
                    "此提示 Hook 修订未获明确授权。"
                }
                .into());
            }
        }
        Ok(())
    }
    pub(super) fn authorization_blocker(&self, store: &Store, run: &Value) -> Option<String> {
        if let Some(reason) = crate::followups::run_blocker(store, run) {
            return Some(reason);
        }
        if let Some(reason) = crate::group_runtime::run_blocker(store, run) {
            return Some(reason);
        }
        if run["kind"] == "external_cli" {
            if run["waiting"] == json!(["review"]) {
                return None;
            }
            return Self::external_authorized(store, run).err();
        }
        let id = run["authorization_id"].as_str()?;
        let check = || -> Result<(), String> {
            let grant = store.authorization_get(id)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs() as i64;
            if (!run["authorization_revision"].is_null()
                && grant["revision"] != run["authorization_revision"])
                || grant["revoked"] == true
                || grant["expires_at"].as_i64().unwrap_or(0) <= now
                || grant["agent_id"] != run["agent_id"]
                || grant["workspace_id"] != run["workspace_id"]
                || grant["engine_id"] != "native"
                || !matches!(grant["purpose"].as_str(), Some("tool_call" | "mcp_call"))
                || grant["rule_id"] != run["rule_id"]
                || (grant["project_ids"]
                    .as_array()
                    .is_some_and(|p| !p.is_empty())
                    && run["project_ids"].as_array().is_none_or(|p| p.is_empty()))
                || run["project_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|p| {
                        !grant["project_ids"]
                            .as_array()
                            .is_some_and(|projects| projects.contains(p))
                    })
            {
                return Err("授权已撤销、到期或执行身份不匹配。".into());
            }
            let projects = store.memory_projects(run["agent_id"].as_i64().unwrap_or(1))?;
            if run["project_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| {
                    !projects
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|row| row["slug"] == *p && row["joined"] == true)
                })
            {
                return Err("项目成员资格已变化。".into());
            }
            Self::bound_capabilities(store, run, &grant)
        };
        check().err()
    }

    pub(super) fn authorize_invocation(
        &self,
        store: &Store,
        run: &Value,
        inv: &mut Value,
    ) -> Result<(), String> {
        if matches!(
            inv["name"].as_str(),
            Some("propose_followup" | "request_handoff")
        ) {
            if let Some(reason) = self.authorization_blocker(store, run) {
                return Err(reason);
            }
            let grant = store.authorization_get(
                run["authorization_id"]
                    .as_str()
                    .ok_or("预约提议需要明确授权。")?,
            )?;
            if run["work_item_id"].as_i64().is_none()
                || grant["purpose"] != "tool_call"
                || !grant["operations"]
                    .as_array()
                    .is_some_and(|operations| operations.contains(&inv["name"]))
            {
                return Err("本次执行没有工作预约提议授权。".into());
            }
            inv["permission_plan"] = json!({"allowed":true,"grant_id":grant["id"],"grant_revision":grant["revision"],"work_item_id":run["work_item_id"],"operation":inv["name"],"enforcement":"Core binds current source Run and work; policy, generation, scope and limits checked inside proposal transaction"});
            return self.providers.tools.validate(
                store,
                run,
                inv["name"].as_str().unwrap(),
                &inv["arguments"],
            );
        }
        if inv["name"] == "group_reply" {
            if let Some(reason) = self.authorization_blocker(store, run) {
                return Err(reason);
            }
            let grant = store.authorization_get(
                run["authorization_id"]
                    .as_str()
                    .ok_or("群回复缺少明确授权。")?,
            )?;
            if run["group_delivery_id"].as_i64().is_none()
                || !grant["operations"]
                    .as_array()
                    .is_some_and(|operations| operations.contains(&json!("group_reply")))
            {
                return Err("本次执行没有群回复授权。".into());
            }
            inv["permission_plan"] = json!({"allowed":true,"grant_id":grant["id"],"grant_revision":grant["revision"],"group_id":run["group_id"],"delivery_id":run["group_delivery_id"],"chain_id":run["group_chain_id"],"operation":"group_reply","enforcement":"Core binds sender and source Run; current membership, scope, generation and authorization checked inside publication transaction"});
            return self
                .providers
                .tools
                .validate(store, run, "group_reply", &inv["arguments"]);
        }
        if inv["name"] == "manage_rule" {
            if run["kind"] == "tool_action" {
                return Err("直接工具动作不支持规则管理工具。".into());
            }
            return self
                .providers
                .tools
                .validate(store, run, "manage_rule", &inv["arguments"]);
        }
        if inv["approval"] == false {
            return Err("用户已拒绝此操作。".into());
        }
        let Some(id) = run["authorization_id"].as_str() else {
            return Ok(());
        };
        if let Some(reason) = self.authorization_blocker(store, run) {
            return Err(reason);
        }
        let is_mcp = inv["name"]
            .as_str()
            .is_some_and(|name| name == "call_mcp" || name.starts_with("mcp_"));
        let operation = if inv["name"] == "call_mcp" {
            let value: crate::authorizations::McpOperation = params(inv["arguments"].clone())?;
            serde_json::to_value(value).map_err(|error| error.to_string())?
        } else if is_mcp {
            mcp::operation(run, inv)?
        } else {
            Value::Null
        };
        let action = json!({"id":id,"agent_id":run["agent_id"],"engine_id":"native",
            "workspace_id":run["workspace_id"],"project_ids":run["project_ids"],
            "rule_id":run["rule_id"],"operation":if is_mcp {json!("call_mcp")}else{match inv["name"].as_str() {Some("office_read") => json!("read_file"), Some("office_edit") => json!("write_file"), _ => inv["name"].clone()}},
            "path":if is_mcp{Value::Null}else{inv["arguments"]["path"].clone()},"network":if is_mcp{store.authorization_get(id)?["network"].clone()}else{json!("none")},"mcp":operation});
        let mut decision = crate::authorizations::read(store, "authorizations.evaluate", action)?;
        if decision["decision"] != "allow" {
            return Err(decision["reason"].as_str().unwrap_or("授权不可用。").into());
        }
        if inv["name"] != "call_mcp" {
            self.providers.tools.validate(
                store,
                run,
                inv["name"].as_str().unwrap_or(""),
                &inv["arguments"],
            )?;
        }
        decision["executable"] = json!(true);
        decision["tool_version"] = json!(if is_mcp {
            "mcp-exact-v1"
        } else if decision["sandbox"].is_object() {
            "native-shell-mxc-v1"
        } else {
            "native-files-v1"
        });
        decision["arguments"] = inv["arguments"].clone();
        if is_mcp {
            decision["mcp_schema_sha256"] = inv["mcp"]["schema_hash"].clone();
            decision["mcp_directory_sha256"] = run["mcp_snapshot"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| entry["id"] == decision["mcp"]["server_id"])
                .map(|entry| entry["directory_hash"].clone())
                .unwrap_or(Value::Null);
        }
        decision["enforcement"] = json!(
            if is_mcp && decision["mcp"]["host_access"] == "full_host" {
                "Core exact-operation and startup gates; Worker pins executable; service initialization and execution have current-user host access"
            } else if is_mcp && decision["mcp"]["host_access"] == "sandbox" {
                "Core exact-operation and startup/Ready gates; Worker pins executable and applies MXC filesystem/network containment before initialization"
            } else if is_mcp {
                "Core service/revision/auth identity/tool/exact arguments and Ready gate; remote effects use configured service permissions"
            } else if decision["sandbox"].is_object() {
                "Core dispatch and Ready gates; MXC BaseContainer filesystem and network containment; Windows runtime libraries readonly; host UI interaction restricted"
            } else {
                "Core dispatch and Worker Ready gate; workspace-relative paths reject reparse points"
            }
        );
        inv["permission_plan"] = decision;
        if inv["hook_ask"] != true {
            inv["approval"] = json!(true);
        }
        Ok(())
    }
}
