import React, { useEffect, useRef, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { resources } from "./client/resources";
import { call } from "./api";
import ReminderPanel from "./ReminderPanel";
import SchedulesPanel from "./SchedulesPanel";
import FollowupsPanel from "./FollowupsPanel";
import WorkItemExecution from "./WorkItemExecution";
import { defaultRule, issuesForRule } from "./schema-form.mjs";
import { RuleDefinitionEditor } from "./SchemaForm.jsx";

const empty = defaultRule;
export default function RulesPanel(props) {
  const [tab, setTab] = useState("events");
  useEffect(() => {
    if (props.openAutomation)
      setTab(
        props.openAutomation.kind === "scheduled" ? "schedules" : "reminders",
      );
  }, [props.openAutomation]);
  return (
    <>
      <div className="title-row" role="group" aria-label="规则类型">
        <button
          id="rules-events-tab"
          aria-pressed={tab === "events"}
          onClick={() => setTab("events")}
        >
          事件规则
        </button>
        <button
          id="rules-reminders-tab"
          aria-pressed={tab === "reminders"}
          onClick={() => setTab("reminders")}
        >
          时间提醒
        </button>
        <button
          id="rules-schedules-tab"
          aria-pressed={tab === "schedules"}
          onClick={() => setTab("schedules")}
        >
          定时执行
        </button>
        <button
          id="rules-followups-tab"
          aria-pressed={tab === "followups"}
          onClick={() => setTab("followups")}
        >
          持续跟进
        </button>
      </div>
      <div hidden={tab !== "events"}>
        <EventRulesPanel {...props} />
      </div>
      <div hidden={tab !== "reminders"}>
        <ReminderPanel
          ready={props.ready}
          openAutomation={props.openAutomation}
        />
      </div>
      <div hidden={tab !== "schedules"}>
        <SchedulesPanel
          openAutomation={props.openAutomation}
          ready={props.ready}
          workspaces={props.workspaces}
          onOpenRun={props.onOpenRun}
        />
      </div>
      <div hidden={tab !== "followups"}>
        <FollowupsPanel ready={props.ready} onOpenRun={props.onOpenRun} />
      </div>
    </>
  );
}
function EventRulesPanel({ ready, onOpenRun }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(null),
    [text, setText] = useState(() => JSON.stringify(empty(), null, 2)),
    [source, setSource] = useState(""),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const lock = useRef(false);
  const list = useClientModel(clientModels.resource("rules.list", { offset }));
  const history = useClientModel(
    selected
      ? clientModels.resource("rules.history", {
          id: selected.id,
          offset: historyOffset,
        })
      : null,
  );
  const work = useClientModel(
    selected?.work_item_id
      ? clientModels.resource("work_items.get", { id: selected.work_item_id })
      : null,
  );
  function edit(rule) {
    setSelected(rule);
    setHistoryOffset(0);
    const value = rule
      ? (({
          id,
          revision,
          after_event,
          author,
          updated_at,
          created_at_ms,
          effective_from_ms,
          origin,
          ...definition
        }) => definition)(rule)
      : empty();
    setText(JSON.stringify(value, null, 2));
    setResult(null);
    setError("");
  }
  async function act(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      clientModels.invalidate();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function save(toggle) {
    const problems = issuesForRule(text);
    if (problems.length) throw Error(problems.join("\n"));
    const rule = JSON.parse(text);
    if (toggle !== undefined) rule.enabled = toggle;
    const saved = await clientModels.command("rules.save", {
      ...(selected ? { id: selected.id } : {}),
      expected_revision: selected?.revision ?? 0,
      rule,
    });
    edit(saved);
  }
  return (
    <div className="models-page">
      <div className="title-row">
        <h1>事件规则</h1>
        <button disabled={!ready || busy} onClick={() => edit(null)}>
          创建规则
        </button>
      </div>
      <p>
        内部事件支持执行完成与失败。保存启用规则后，Core 校验授权并创建独立
        Run。规则配置最多 4KB。
      </p>
      <p>
        工作推进使用 event=work.accepted、source_work_item_id 和
        work_item_id。接纳事件产生后复核依赖及授权，CLI
        需要已确认的权限计划。外部事件也可设置 work_item_id 关联后续工作。
      </p>
      {(error || list.error) && (
        <p role="alert" className="error">
          {error || list.error.message}
        </p>
      )}
      <div className="models-layout">
        <section className="provider-library" aria-label="规则列表">
          {list.data?.items
            .filter(
              (rule) =>
                !["reminder", "scheduled", "followup"].includes(rule.kind),
            )
            .map((rule) => (
              <button
                key={rule.id}
                className="provider-choice"
                disabled={busy}
                onClick={() => edit(rule)}
              >
                {rule.name} · 修订 {rule.revision} ·{" "}
                {rule.enabled ? "启用" : "暂停"}
              </button>
            ))}
          <button
            disabled={busy || !ready}
            onClick={() => {
              setOffset(0);
              clientModels.invalidate();
            }}
          >
            刷新列表
          </button>
          {list.data?.next_offset !== null &&
            list.data?.next_offset !== undefined && (
              <button
                disabled={busy}
                onClick={() => setOffset(list.data.next_offset)}
              >
                下一页
              </button>
            )}
        </section>
        <section className="provider-form">
          <RuleDefinitionEditor
            text={text}
            disabled={!ready || busy}
            onText={setText}
          />
          <p>
            start 可使用原生执行或 CLI 启动契约。原生 action
            指定工具及完整参数。 CLI 指定 engine_id、tool_mode
            和执行时限，authorization_id 引用对应启动授权。 source_run_id
            可限定触发执行，留空匹配同一工作区。 外部事件使用 source_id 和可选
            event_state。每次保存后的新修订仅接纳生效时间内的事件。
          </p>
          <button
            id="rule-save"
            disabled={!ready || busy}
            onClick={() => act(() => save())}
          >
            保存规则
          </button>
          {selected && (
            <>
              <button
                id="rule-toggle"
                disabled={!ready || busy}
                onClick={() => act(() => save(!selected.enabled))}
              >
                {selected.enabled ? "暂停规则" : "启用规则"}
              </button>
              <label htmlFor="rule-source">
                {selected.event === "work.accepted"
                  ? "模拟的工作接纳事件 ID"
                  : selected.source_id
                    ? "模拟的外部事件 ID"
                    : "模拟事件的 Run ID"}
              </label>
              <input
                id="rule-source"
                type="number"
                min="1"
                disabled={!ready || busy}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <button
                id="rule-simulate"
                disabled={!ready || busy || !source}
                onClick={() =>
                  act(async () =>
                    setResult(
                      await call(
                        resources.rulesSimulate({
                          id: selected.id,
                          ...(selected.event === "work.accepted"
                            ? { work_event_id: Number(source) }
                            : selected.source_id
                              ? { external_event_id: Number(source) }
                              : { run_id: Number(source) }),
                        }),
                      ),
                    ),
                  )
                }
              >
                模拟检查
              </button>
              {result && (
                <pre role="status">{JSON.stringify(result, null, 2)}</pre>
              )}
              <h2>触发历史</h2>
              {history.data?.next_offset != null && (
                <button
                  onClick={() => setHistoryOffset(history.data.next_offset)}
                >
                  更多历史
                </button>
              )}
              {historyOffset > 0 && (
                <button onClick={() => setHistoryOffset(0)}>
                  返回最新历史
                </button>
              )}
              {history.error && <p role="alert">{history.error.message}</p>}
              {history.data?.deliveries.map((delivery, index) => (
                <div key={index}>
                  <p>
                    {delivery.state} ·{" "}
                    {typeof delivery.reason === "string"
                      ? delivery.reason
                      : JSON.stringify(delivery.reason)}{" "}
                    · 规则修订 {delivery.rule_revision} · 来源 Run{" "}
                    {delivery.external_event_id
                      ? `外部事件 ${delivery.external_event_id}`
                      : delivery.event_run_id}
                    {delivery.work_event_id &&
                      ` · 工作接纳事件 ${delivery.work_event_id}`}
                    {delivery.work_item_id &&
                      ` · 后续工作 #${delivery.work_item_id}`}
                  </p>
                  {delivery.run_id && (
                    <button onClick={() => onOpenRun(delivery.run_id)}>
                      查看 Run #{delivery.run_id}
                    </button>
                  )}
                </div>
              ))}
              <details>
                <summary>规则修订</summary>
                <pre>{JSON.stringify(history.data?.items ?? [], null, 2)}</pre>
              </details>
            </>
          )}
        </section>
      </div>
      {work.error && <p role="alert">{work.error.message}</p>}
      {work.data && (
        <WorkItemExecution
          key={work.data.id}
          item={work.data}
          ready={ready}
          busy={busy}
          dirty={false}
          act={act}
          onOpenRun={onOpenRun}
        />
      )}
    </div>
  );
}
