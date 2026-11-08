use super::*;

fn text(value: &Value) -> Result<String, String> {
    let text = if let Some(s) = value.as_str() {
        s.to_owned()
    } else if value.is_u64() {
        value.to_string()
    } else {
        return Err("事件身份字段缺失。".into());
    };
    if text.is_empty() || text.len() > 200 || text.chars().any(char::is_control) {
        return Err("事件身份字段无效。".into());
    }
    Ok(text)
}
pub fn event(
    source: &Value,
    header_kind: &str,
    delivery: &str,
    body: &Value,
) -> Result<Value, String> {
    let canonical = tools::hash(body.to_string().as_bytes());
    let mut version_field = "subject_version";
    let (kind, subject, version, state, project, occurred, semantic) =
        match source["kind"].as_str().unwrap_or("") {
            "github" => {
                let project = text(&body["repository"]["full_name"])?;
                match header_kind {
                    "workflow_run"
                        if body["action"] == "completed"
                            && body["workflow_run"]["status"] == "completed" =>
                    {
                        let run = &body["workflow_run"];
                        let id = text(&run["id"])?;
                        let attempt = text(&run["run_attempt"])?;
                        let state = text(&run["conclusion"])?;
                        (
                            "github.workflow.completed",
                            id.clone(),
                            attempt.clone(),
                            state.clone(),
                            project,
                            run["updated_at"].clone(),
                            format!("workflow:{id}:{attempt}:{state}"),
                        )
                    }
                    "issues" | "pull_request" => {
                        let (name, kind) = if header_kind == "issues" {
                            ("issue", "github.issue.changed")
                        } else {
                            ("pull_request", "github.pull_request.changed")
                        };
                        let item = &body[name];
                        let subject = text(&item["number"])?;
                        let version = text(&item["updated_at"])?;
                        let state = text(&item["state"])?;
                        (
                            kind,
                            subject.clone(),
                            version.clone(),
                            state.clone(),
                            project,
                            item["updated_at"].clone(),
                            format!("{kind}:{subject}:{version}:{state}"),
                        )
                    }
                    _ => return Err("不支持的 GitHub 事件。".into()),
                }
            }
            "gitlab" => {
                let project = text(&body["project"]["id"])?;
                let item = &body["object_attributes"];
                match (header_kind, body["object_kind"].as_str()) {
                    ("Pipeline Hook", Some("pipeline")) => {
                        version_field = if !item["updated_at"].is_null() {
                            "updated_at"
                        } else if !item["finished_at"].is_null() {
                            "finished_at"
                        } else {
                            "unavailable"
                        };
                        let version = if version_field == "unavailable" {
                            canonical.clone()
                        } else {
                            text(&item[version_field])?
                        };
                        let subject = text(&item["id"])?;
                        let state = text(&item["status"])?;
                        (
                            "gitlab.pipeline.changed",
                            subject.clone(),
                            version.clone(),
                            state.clone(),
                            project,
                            item[version_field].clone(),
                            format!("pipeline:{subject}:{version}:{state}"),
                        )
                    }
                    ("Issue Hook", Some("issue"))
                    | ("Merge Request Hook", Some("merge_request")) => {
                        let kind = if header_kind == "Issue Hook" {
                            "gitlab.issue.changed"
                        } else {
                            "gitlab.merge_request.changed"
                        };
                        let subject = text(&item["iid"])?;
                        let version = text(&item["updated_at"])?;
                        let state = text(&item["state"])?;
                        (
                            kind,
                            subject.clone(),
                            version.clone(),
                            state.clone(),
                            project,
                            item["updated_at"].clone(),
                            format!("{kind}:{subject}:{version}:{state}"),
                        )
                    }
                    _ => return Err("不支持的 GitLab 事件。".into()),
                }
            }
            "webhook" => {
                if body["schema"] != "troop.webhook.v1" {
                    return Err("Webhook schema 未登记。".into());
                }
                (
                    "webhook.changed",
                    text(&body["subject_id"])?,
                    text(&body["subject_version"])?,
                    text(&body["state"])?,
                    text(&body["project"])?,
                    body["occurred_at"].clone(),
                    format!("webhook:{}", text(&body["id"])?),
                )
            }
            _ => return Err("事件来源类型无效。".into()),
        };
    let occurred =
        if occurred.as_i64().is_some() || occurred.as_str().is_some_and(|s| s.len() <= 80) {
            occurred
        } else {
            Value::Null
        };
    if source["project"] != project {
        return Err("事件项目与来源登记不匹配。".into());
    }
    Ok(
        json!({"source_id":source["id"],"kind":kind,"subject_id":subject,"subject_version":version,"version_field":version_field,"state":state,"project":project,"occurred_at":occurred,"received_at":now(),"semantic_key":semantic,"delivery_id":delivery,"ttl_seconds":source["ttl_seconds"],"payload_sha256":tools::hash(body.to_string().as_bytes())}),
    )
}
