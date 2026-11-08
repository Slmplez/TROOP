// React-free observable queries. A view owns observation, never execution lifetime.
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export class QueryModel {
  constructor(
    owner,
    load,
    {
      interval = 0,
      cursor = null,
      order = null,
      revision = null,
      appendOnly = false,
      refreshPages = false,
      identity = (item) => item.id,
    } = {},
  ) {
    this.owner = owner;
    this.load = load;
    this.interval = interval;
    this.cursor = cursor;
    this.order = order;
    this.revision = revision;
    this.appendOnly = appendOnly;
    this.refreshPages = refreshPages;
    this.pageCount = 1;
    this.identity = identity;
    this.listeners = new Set();
    this.serial = 0;
    this.pending = null;
    this.expanded = false;
    this.state = Object.freeze({ data: null, loading: false, error: null });
  }
  getSnapshot = () => this.state;
  publish(patch) {
    if (patch.data) freeze(patch.data);
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener) => {
    // Each returned handle owns one observation, even with the same callback.
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      this.owner.observe(this, true);
      this.start();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(notify);
      if (!this.listeners.size) {
        this.suspend();
        this.owner.observe(this, false);
      }
    };
  };
  start() {
    if (!this.owner.ready) return;
    void this.refresh();
    if (this.interval && !this.timer)
      this.timer = this.owner.clock.setInterval(
        () => void this.refresh(),
        this.interval,
      );
  }
  suspend() {
    if (this.timer) this.owner.clock.clearInterval(this.timer);
    this.timer = null;
    this.serial++;
    this.pending = null;
    this.dirty = false;
    this.morePending = null;
    this.moreRequested = false;
  }
  reset() {
    this.suspend();
    this.expanded = false;
    this.pageCount = 1;
    this.publish({ data: null, loading: false, error: null });
    if (this.listeners.size) this.start();
  }
  async refresh() {
    if (!this.owner.ready) return;
    if (this.pending) {
      this.dirty = true;
      return this.pending;
    }
    return this.fetch(false);
  }
  async more() {
    if (this.morePending) return this.morePending;
    const token = this.serial;
    this.moreRequested = true;
    const work = (async () => {
      if (this.pending) await this.pending;
      // Releasing observation or switching generation invalidates a queued page too.
      if (
        token !== this.serial ||
        !this.owner.ready ||
        !this.cursor ||
        this.state.data?.[this.cursor] == null
      )
        return;
      return this.fetch(true);
    })();
    this.morePending = work;
    try {
      return await work;
    } finally {
      if (this.morePending === work) {
        this.moreRequested = false;
        this.morePending = null;
        if (this.dirty && this.listeners.size) {
          this.dirty = false;
          void this.refresh();
        }
      }
    }
  }
  async fetch(older) {
    const token = ++this.serial;
    const cursor = older ? this.state.data[this.cursor] : null;
    this.publish({ loading: true, error: null });
    // Assign the promise before invoking loaders, including synchronous fake adapters.
    const pending = Promise.resolve()
      .then(async () => {
        let data = await this.load(cursor);
        if (!older && this.refreshPages && this.cursor) {
          for (let page = 1; page < this.pageCount; page++) {
            if (token !== this.serial || !this.owner.ready) return data;
            if (data[this.cursor] == null) break;
            const next = await this.load(data[this.cursor]);
            data = { ...next, items: [...data.items, ...next.items] };
          }
        }
        return data;
      })
      .then((data) => {
        if (token !== this.serial || !this.owner.ready) return;
        const previous = this.state.data;
        if (
          previous &&
          this.revision &&
          this.revision(data) < this.revision(previous)
        )
          return;
        if (
          this.cursor &&
          previous &&
          (older || (this.expanded && !this.refreshPages) || this.appendOnly)
        ) {
          const items = new Map(
            previous.items.map((item) => [this.identity(item), item]),
          );
          for (const item of data.items)
            if (!older || !items.has(this.identity(item)))
              items.set(this.identity(item), item);
          data = {
            ...data,
            items: [...items.values()].sort(this.order),
            [this.cursor]:
              older || !this.expanded
                ? data[this.cursor]
                : previous[this.cursor],
          };
        }
        if (older) {
          this.expanded = true;
          this.pageCount++;
        }
        this.publish({ data, error: null });
      })
      .catch((error) => {
        if (token === this.serial)
          this.publish({
            error,
            data: error.kind === "request_rejected" ? null : this.state.data,
          });
      })
      .finally(() => {
        if (token !== this.serial) return;
        this.pending = null;
        this.publish({ loading: false });
        if (this.dirty && !this.moreRequested) {
          this.dirty = false;
          void this.refresh();
        }
      });
    this.pending = pending;
    return pending;
  }
}
