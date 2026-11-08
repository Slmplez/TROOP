const { randomUUID } = require("node:crypto");

// Only the main process owns OS delivery. Renderer reads and read receipts are separate.
function startReminderNotifications({
  core,
  focused,
  create,
  supported,
  interval = 500,
}) {
  const consumer = randomUUID();
  let busy = false,
    stopped = false,
    claim = null,
    claimStarted = null,
    generation = null;
  const completions = new Map(),
    active = new Set();
  const current = () =>
    !stopped &&
    core.state === "ready" &&
    core.snapshot().generation === generation;
  const operation = async (entry) => {
    const receipt = await core.request("operations.execute", entry);
    if (receipt.state !== "committed") {
      const error = Error(receipt.error?.message || "通知回执未提交。");
      error.terminal = receipt.state === "rejected";
      throw error;
    }
    return receipt.result;
  };
  const intent = (method, input) => ({
    operation_id: randomUUID(),
    instance_id: core.snapshot().storage_instance,
    method,
    input,
  });
  function deliver(notification, elapsed) {
    const sourceGeneration = generation;
    let settled = false,
      native = null,
      timer,
      releaseTimer;
    const finish = (outcome, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome !== "shown") active.delete(cancel);
      else {
        releaseTimer = setTimeout(cancel, 60000);
        releaseTimer.unref?.();
      }
      if (!current() || generation !== sourceGeneration) return;
      const entry = intent("notifications.complete", {
        id: notification.id,
        expected_revision: notification.revision,
        consumer_id: consumer,
        attempt_id: notification.attempt_id,
        outcome,
        reason: String(reason).slice(0, 1000),
      });
      completions.set(entry.operation_id, entry);
    };
    const cancel = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(releaseTimer);
      active.delete(cancel);
      native?.close();
    };
    active.add(cancel);
    try {
      if (elapsed >= notification.deadline_ms - notification.claimed_at_ms) {
        finish("expired", "领取回应已错过系统通知投递窗口。");
        return;
      }
      if (!supported()) {
        finish("failed", "当前系统不支持桌面通知。");
        return;
      }
      native = create({ title: notification.title, body: notification.body });
      native.once("close", () => {
        active.delete(cancel);
        clearTimeout(releaseTimer);
      });
      native.once("show", () => finish("shown", "系统通知显示回调已收到。"));
      native.once("failed", (_event, error) =>
        finish("failed", error || "系统通知显示失败。"),
      );
      timer = setTimeout(
        () => finish("indeterminate", "未收到系统显示回调，投递结果待核对。"),
        4000,
      );
      timer.unref?.();
      native.show();
    } catch (error) {
      finish("failed", error.message);
    }
  }
  async function poll() {
    if (busy || stopped || core.state !== "ready") return;
    busy = true;
    try {
      const nextGeneration = core.snapshot().generation;
      if (generation !== nextGeneration) {
        for (const cancel of active) cancel();
        active.clear();
        completions.clear();
        claim = null;
        generation = nextGeneration;
      }
      for (const [id, entry] of completions) {
        try {
          await operation(entry);
        } catch (error) {
          if (!error.terminal) throw error;
        }
        if (!current()) return;
        completions.delete(id);
      }
      if (!claim) {
        const status = await core.request("notifications.pending", {});
        if (!current() || !status.pending) return;
        claim = intent("notifications.claim", {
          consumer_id: consumer,
          focused: focused(),
        });
        claimStarted = { wall: Date.now(), mono: performance.now() };
      }
      const ownedClaim = claim;
      let result;
      try {
        result = await operation(ownedClaim);
      } catch (error) {
        if (error.terminal) claim = null;
        throw error;
      }
      if (!current()) return;
      claim = null;
      if (result.notification)
        deliver(
          result.notification,
          Math.max(
            Date.now() - claimStarted.wall,
            performance.now() - claimStarted.mono,
          ),
        );
    } catch (error) {
      // Keep the operation identity across transport failures. Never repeat show().
      if (core.state === "ready") core.lastError = error.message;
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void poll(), interval);
  timer.unref?.();
  return {
    poll,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const cancel of active) cancel();
      active.clear();
    },
  };
}
module.exports = { startReminderNotifications };
