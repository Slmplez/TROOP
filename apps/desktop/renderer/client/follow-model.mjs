import contract from "../../contracts/execution.cjs";
import { ClientError } from "./troop-client.mjs";
import { QueryModel } from "./query-model.mjs";
// A pull-based follow stream with bounded catch-up. Subscription lifetime never
// controls execution lifetime; only the last accepted cursor can survive reconnect.
export class FollowModel extends QueryModel {
  constructor(owner, load, options) {
    super(owner, load, options);
    this.target = options.follow;
    this.followCursor = null;
    this.followInstance = null;
  }
  reset() {
    if (
      !this.owner.followEnabled ||
      (this.followInstance && this.owner.instance !== this.followInstance)
    ) {
      this.followCursor = null;
      this.followInstance = null;
      return super.reset();
    }
    this.suspend();
    this.publish({ loading: false, error: null });
    if (this.listeners.size) this.start();
  }
  async fetch(older) {
    if (
      !this.owner.followEnabled ||
      !this.owner.followResources.includes(this.target.resource)
    )
      return super.fetch(older);
    const token = ++this.serial;
    const generation = this.owner.generation;
    const instance = this.owner.instance;
    const current = () =>
      token === this.serial &&
      this.owner.ready &&
      this.owner.generation === generation &&
      this.owner.instance === instance;
    this.publish({ loading: true, error: null });
    const pending = Promise.resolve()
      .then(async () => {
        for (let page = 0; page < 8 && current(); page++) {
          const from = this.followCursor;
          const frame = await this.owner.client.request("agent.follow", {
            ...this.target,
            cursor: from,
          });
          if (!current()) return;
          if (
            frame.generation !== generation ||
            frame.instance_id !== instance ||
            frame.resource !== this.target.resource ||
            frame.id !== this.target.id ||
            frame.from_cursor !== from
          )
            throw new ClientError(
              "Follow 帧身份或游标不匹配。",
              "invalid_response",
            );
          if (frame.state === "reset_required") {
            if (from === null)
              throw new ClientError(
                "Follow 无法建立初始快照。",
                "invalid_response",
              );
            this.followCursor = null;
            this.publish({ data: null });
            this.owner.resetFollowEvents(this.target);
            continue;
          }
          if (
            !frame.cursor ||
            (frame.has_more && frame.cursor === from) ||
            (frame.state === "snapshot") !== (from === null)
          )
            throw new ClientError(
              "Follow 游标未连续推进。",
              "invalid_response",
            );
          if (frame.snapshot) {
            contract.validate(
              this.target.resource === "run"
                ? "agent.get"
                : this.target.resource === "invocation"
                  ? "agent.invocation"
                  : "agent.task",
              frame.snapshot.value,
              true,
            );
            const valueId =
              this.target.resource === "run"
                ? frame.snapshot.value.run.id
                : frame.snapshot.value.id;
            if (valueId !== this.target.id || frame.has_more)
              throw new ClientError(
                "Follow 快照边界无效。",
                "invalid_response",
              );
            const previous = this.state.data;
            const version =
              this.target.resource === "run"
                ? frame.snapshot.value.run.revision
                : frame.snapshot.value.revision;
            const previousVersion =
              this.target.resource === "run"
                ? previous?.run.revision
                : previous?.revision;
            if (previousVersion != null && version < previousVersion)
              throw new ClientError(
                "Follow 资源修订发生倒退。",
                "invalid_response",
              );
          } else if (!frame.has_more)
            throw new ClientError("Follow 缺少基线快照。", "invalid_response");
          this.owner.acceptFollowEvents(this.target, frame);
          this.followCursor = frame.cursor;
          this.followInstance = instance;
          if (!frame.snapshot) continue;
          let data = frame.snapshot.value;
          this.publish({ data, error: null });
          // Fetch large text at the snapshot's exact revision. If it changed, keep
          // the consistent truncated preview and obtain a new snapshot next poll.
          if (this.target.resource === "run") {
            const run = { ...data.run };
            for (const field of ["goal", "output"]) {
              if (!run[field + "_truncated"]) continue;
              let offset = 0,
                text = "",
                complete = false;
              for (let chunk = 0; chunk < 256 && current(); chunk++) {
                const part = await this.owner.client.request(
                  "agent.follow-content",
                  { id: this.target.id, field, revision: run.revision, offset },
                );
                if (!current()) return;
                if (part.state === "reset_required") break;
                if (
                  part.revision !== run.revision ||
                  (part.next_offset !== null && part.next_offset <= offset)
                )
                  throw new ClientError(
                    "Follow 内容修订不匹配。",
                    "invalid_response",
                  );
                text += part.text;
                if (part.next_offset === null) {
                  complete = true;
                  break;
                }
                offset = part.next_offset;
              }
              if (complete) {
                run[field] = text;
                run[field + "_truncated"] = false;
              }
            }
            if (current()) this.publish({ data: { ...data, run } });
          }
          return;
        }
        // Yield to the scheduler during a large replay; the next poll continues.
      })
      .catch((error) => {
        if (current()) this.publish({ error });
      })
      .finally(() => {
        if (!current()) return;
        this.pending = null;
        this.publish({ loading: false });
        if (this.dirty && this.listeners.size) {
          this.dirty = false;
          void this.refresh();
        }
      });
    this.pending = pending;
    return pending;
  }
}
