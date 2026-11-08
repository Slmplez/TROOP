import React, { useEffect, useState } from "react";
import { clientModels, useClientModel } from "./client/react";
import { actionFor } from "./client/actions.mjs";
function Question({ request, ready, act }) {
  const draftKey = `troop-cli-answer:${clientModels.instance}:${request.interaction_id}:${request.request_sha256}`;
  const [answers, setAnswers] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? saved
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      if (request.state === "pending")
        sessionStorage.setItem(draftKey, JSON.stringify(answers));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, answers, request.state]);
  const [pending, setPending] = useState(false);
  const action = actionFor(request, "respond");
  const questions = request.body.questions;
  const complete = questions.every(
    (question) =>
      Array.isArray(answers[question.id]) && answers[question.id].length > 0,
  );
  return (
    <article aria-label={`CLI 问题 ${request.interaction_id}`}>
      <h4>CLI 问答</h4>
      {questions.map((question) => (
        <fieldset
          key={question.id}
          disabled={!ready || pending || !action.allowed}
        >
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label className="check-row" key={option.label}>
              <input
                type={
                  question.multiSelect || question.multi ? "checkbox" : "radio"
                }
                name={`${request.interaction_id}-${question.id}`}
                value={option.label}
                checked={
                  Array.isArray(answers[question.id]) &&
                  answers[question.id].includes(option.label)
                }
                onChange={() =>
                  setAnswers((previous) => {
                    const selected = Array.isArray(previous[question.id])
                      ? previous[question.id]
                      : [];
                    return {
                      ...previous,
                      [question.id]:
                        question.multiSelect || question.multi
                          ? selected.includes(option.label)
                            ? selected.filter((label) => label !== option.label)
                            : [...selected, option.label]
                          : [option.label],
                    };
                  })
                }
              />
              {option.label}
              {option.description ? ` — ${option.description}` : ""}
            </label>
          ))}
        </fieldset>
      ))}
      <p role="status">
        {{
          pending: "等待回答",
          decided: "回答已保存，等待发送",
          sent: "回答已发送，原生确认不可用",
          closed:
            request.delivery.write_state === "written"
              ? "回答已发送，所属作业已结束"
              : "问题已关闭",
          indeterminate: "回应结果需要核对",
        }[request.state] ?? request.state}
      </p>
      {request.state === "pending" && (
        <>
          <button
            type="button"
            disabled={!ready || pending || !complete || !action.allowed}
            title={action.reason ?? undefined}
            onClick={() => {
              setPending(true);
              Promise.resolve(
                act(() =>
                  clientModels.command("cli.respond", {
                    interaction_id: request.interaction_id,
                    expected_revision: request.revision,
                    task_epoch: request.task_epoch,
                    request_sha256: request.request_sha256,
                    answer: { kind: "question", answers },
                  }),
                ),
              ).finally(() => setPending(false));
            }}
          >
            提交回答
          </button>
          {action.reason && <p className="muted">{action.reason}</p>}
        </>
      )}
      {request.decision && (
        <details>
          <summary>已保存回答</summary>
          <pre>{JSON.stringify(request.decision.answer, null, 2)}</pre>
        </details>
      )}
    </article>
  );
}
function Permission({ request, ready, act }) {
  const [pending, setPending] = useState(false);
  const respond = actionFor(request, "respond"),
    approve = actionFor(request, "approve");
  return (
    <article aria-label={`CLI 审批 ${request.interaction_id}`}>
      <h4>CLI 工具审批</h4>
      <p>{request.body.tool_name}</p>
      <pre aria-label="CLI 审批参数">
        {JSON.stringify(request.body.tool_call, null, 2)}
      </pre>
      <p role="status">
        {request.state} · {request.delivery.write_state}
      </p>
      {request.state === "pending" &&
        request.body.options.map((option) => {
          const available =
            option.kind === "reject_once"
              ? respond
              : option.kind === "allow_once"
                ? approve
                : { allowed: false, reason: "该选项需要额外的权限能力证据。" };
          return (
            <button
              key={option.optionId}
              type="button"
              disabled={!ready || pending || !available.allowed}
              title={available.reason ?? undefined}
              onClick={() => {
                setPending(true);
                Promise.resolve(
                  act(() =>
                    clientModels.command("cli.respond", {
                      interaction_id: request.interaction_id,
                      expected_revision: request.revision,
                      task_epoch: request.task_epoch,
                      request_sha256: request.request_sha256,
                      answer: {
                        kind: "permission",
                        option_id: option.optionId,
                      },
                    }),
                  ),
                ).finally(() => setPending(false));
              }}
            >
              {option.name}
            </button>
          );
        })}
      {request.body.scope_reason && <p>{request.body.scope_reason}</p>}
      {request.state === "pending" && (
        <>
          {approve.reason && <p className="muted">{approve.reason}</p>}
          <button
            type="button"
            disabled={
              !ready ||
              pending ||
              !actionFor(request, "request_scope_change").allowed
            }
            onClick={() => {
              setPending(true);
              Promise.resolve(
                act(() =>
                  clientModels.command("cli.respond", {
                    interaction_id: request.interaction_id,
                    expected_revision: request.revision,
                    task_epoch: request.task_epoch,
                    request_sha256: request.request_sha256,
                    answer: {
                      kind: "scope_change",
                      note: "用户请求停止旧作业，核对已有执行效果后重新明确授权。",
                    },
                  }),
                ),
              ).finally(() => setPending(false));
            }}
          >
            更改权限并停止旧作业
          </button>
          <p>
            停止后在作业详情核对实际效果，再到授权页面选择新范围并关联此 Task。
          </p>
        </>
      )}
      {request.decision && (
        <details>
          <summary>授权及决定依据</summary>
          <pre>
            {JSON.stringify(
              {
                authorization_id: request.authorization_id,
                authorization_revision: request.authorization_revision,
                decision: request.decision,
                delivery: request.delivery,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </article>
  );
}
function Plan({ request, ready, act }) {
  const [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false);
  const available = actionFor(request, "respond");
  async function decide(accepted) {
    setPending(true);
    try {
      await act(() =>
        clientModels.command("cli.respond", {
          interaction_id: request.interaction_id,
          expected_revision: request.revision,
          task_epoch: request.task_epoch,
          request_sha256: request.request_sha256,
          answer: { kind: "plan", accepted, plan_sha256: request.body.sha256 },
        }),
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <article aria-label={`CLI 计划 ${request.interaction_id}`}>
      <h4>CLI 计划确认</h4>
      {request.source === "host_plan_confirmation" && (
        <p>
          原生会话已生成计划。本次确认由宿主保存，后续执行通过关联的新 Run
          启动。
        </p>
      )}
      <p>
        版本 {request.body.version} · {request.body.sha256}
      </p>
      <pre>{request.body.text}</pre>
      <p role="status">{request.state}</p>
      {request.state === "pending" && (
        <>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!ready || pending || !available.allowed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            已阅读这份计划，确认内容与当前授权范围
          </label>
          <button
            type="button"
            disabled={!ready || pending || !confirmed || !available.allowed}
            onClick={() => decide(true)}
          >
            确认计划
          </button>
          <button
            type="button"
            disabled={!ready || pending || !available.allowed}
            onClick={() => decide(false)}
          >
            拒绝计划
          </button>
          {available.reason && <p>{available.reason}</p>}
        </>
      )}
      {request.decision && (
        <details>
          <summary>计划决定与交付记录</summary>
          <pre>
            {JSON.stringify(
              { decision: request.decision, delivery: request.delivery },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </article>
  );
}
export default function CliInteractions({ taskId, ready, visible, act }) {
  const supported = clientModels.capabilities?.includes("cli.interactions");
  const model = clientModels.resource("cli.interactions", { task_id: taskId });
  const state = useClientModel(model, ready && visible && supported);
  if (!supported) return <p>当前 Core 需要升级以支持 CLI 运行时交互。</p>;
  return (
    <section aria-label="CLI 运行时交互">
      {state.error && (
        <p role="alert" className="message-problem">
          {state.error.message}
        </p>
      )}
      {state.data?.items.map((request) =>
        React.createElement(
          request.kind === "question"
            ? Question
            : request.kind === "plan"
              ? Plan
              : Permission,
          {
            key: `${request.interaction_id}-${request.request_sha256}`,
            request,
            ready,
            act,
          },
        ),
      )}
      {state.data?.next_cursor && (
        <button type="button" onClick={() => model.more()}>
          更早交互
        </button>
      )}
    </section>
  );
}
