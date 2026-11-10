import { AsyncLocalStorage } from "node:async_hooks";

// The T3 and OpenCode bundles share an isolate but have separate module graphs.
const key = Symbol.for("baskule.bootScheduler");
const owners = globalThis[key] ??= new AsyncLocalStorage();

/** Capture a Promise dispatcher while the caller's boot event is retained with waitUntil (#258). */
export function withBootScheduler(run) {
  let pending = [];
  let wake;
  const arm = () => {
    new Promise(resolve => { wake = resolve; }).then(() => {
      const batch = pending;
      pending = [];
      arm();
      for (const start of batch) start();
    });
  };
  arm();
  return owners.run(task => {
    let cancelled = false;
    let timer;
    pending.push(() => {
      if (!cancelled) timer = setTimeout(task, 0);
    });
    wake();
    return () => { cancelled = true; clearTimeout(timer); };
  }, run);
}

/** Bind once per fiber dispatcher; a foreign request must not take ownership of its next yield. */
export const bindBootScheduler = (fallback = task => {
  const timer = setTimeout(task, 0);
  return () => clearTimeout(timer);
}) => owners.getStore() ?? fallback;
