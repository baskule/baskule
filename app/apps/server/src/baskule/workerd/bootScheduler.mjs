import { AsyncLocalStorage } from "node:async_hooks";

// The T3 and OpenCode bundles share an isolate but have separate module graphs.
const key = Symbol.for("baskule.bootScheduler");
const owners = globalThis[key] ??= new AsyncLocalStorage();

/** Capture a Promise dispatcher while the caller's boot event is retained with waitUntil (#258). */
export function withBootScheduler(run, signal) {
  let pending = [];
  let wake;
  const arm = () => {
    new Promise(resolve => { wake = resolve; }).then(() => {
      const batch = pending;
      pending = [];
      if (!signal?.aborted) arm();
      for (const start of batch) start();
    });
  };
  const schedule = task => {
    if (signal?.aborted) throw new Error("OpenCode boot scheduler is closed");
    let cancelled = false;
    let cancel;
    pending.push(() => {
      if (cancelled) return;
      if (typeof globalThis.setImmediate === "function") {
        const timer = globalThis.setImmediate(task);
        cancel = () => globalThis.clearImmediate(timer);
      } else {
        const timer = setTimeout(task, 0);
        cancel = () => clearTimeout(timer);
      }
    });
    wake();
    return () => { cancelled = true; cancel?.(); };
  };
  return owners.run(schedule, () => { arm(); return run(); });
}

/** Bind once per fiber dispatcher; a foreign request must not take ownership of its next yield. */
export const bindBootScheduler = () => {
  const owner = owners.getStore();
  if (!owner) throw new Error("OpenCode boot scheduler context is missing");
  return owner;
};
