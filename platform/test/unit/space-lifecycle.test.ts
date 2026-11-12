import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../src/control/settings";
import { RUN_HEARTBEAT_MS, SpaceCell } from "../../src/space/index";
import { fakeStorage } from "../support/fake-storage";

const createServer = vi.hoisted(() => vi.fn());
vi.mock("../../src/space/t3/space-cell.js", () => ({
  createSpaceServer: createServer,
  createSpaceSqlClient: async () => ({ client: {}, stats: {} }),
}));

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => { resolve = r; }), resolve: () => resolve() };
};
const server = (dispose = vi.fn(async () => {})) => ({
  bootMs: 0, activeRuns: () => 0, nextWakeAt: () => null, sockets: () => [], dispose,
});
/** A cell whose database has these tables (default: an existing space, OpenCode's schema present). */
const control = { getByName: () => ({ fetch: async () => Response.json({ ...defaultSettings, apiKey: "test", plugins: { servers: [], skills: [] } }) }) };
const cell = (put = vi.fn(async () => {}), tables = ["session"], waitUntil: (promise: Promise<unknown>) => void = () => {}) => new SpaceCell({ id: { name: "test-space" }, waitUntil, storage: {
  put,
  get: vi.fn(async () => undefined),
  delete: vi.fn(async () => true),
  deleteAlarm: vi.fn(async () => {}),
  sql: { exec: () => ({ toArray: () => tables.map((name) => ({ name })) }) },
} } as never, { CONTROL: control } as never) as any;

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("SpaceCell cold agent alarms", () => {
  function setup() {
    const sql = fakeStorage(), keys = new Map<string, unknown>();
    let physicalAlarm: number | null = null;
    const storage = { ...sql,
      get: async (key: string) => keys.get(key),
      put: async (key: string, value: unknown) => { keys.set(key, value); },
      delete: async (key: string) => keys.delete(key),
      setAlarm: async (at: number) => { physicalAlarm = at; },
      deleteAlarm: async () => { physicalAlarm = null; },
    };
    const c = new SpaceCell({ storage } as never, {} as never) as any;
    const alarm = vi.fn(async () => {});
    c.createLocalAgent = vi.fn(async () => ({ alarm }));
    return { c, storage, keys, alarm, physicalAlarm: () => physicalAlarm };
  }

  function usageSchema(storage: ReturnType<typeof fakeStorage>) {
    storage.db.exec(`create table baskule_usage_outbox(message_id text primary key, record text);
      create table baskule_usage_context(prompt_id text primary key, session_id text, context text);
      create table session_message(id text primary key, session_id text, type text, data text);`);
  }

  it.each(["absent", "receipts", "unattributed"])("completes an idle agent claim without constructing the runtime, usage=%s", async usage => {
    const h = setup();
    try {
      if (usage !== "absent") {
        usageSchema(h.storage);
        h.storage.db.exec(`insert into session_message values('answer','session','assistant','{"time":{"completed":1},"tokens":{}}');
          insert into session_message values('running','session','assistant','{"time":{},"tokens":{}}');`);
        if (usage === "receipts") h.storage.db.exec(`insert into baskule_usage_context values('turn','session','{}');
          insert into baskule_usage_outbox values('answer',null);`);
      }
      const future = Date.now() + 60_000;
      h.keys.set("baskule:status", { activeRuns: 0, nextWakeAt: future, updatedAt: Date.now() });
      await h.c.alarms.set("space", future);
      // A claim recovered from a process that stopped during an idle alarm is also idle.
      h.keys.set("baskule:alarm-running:agent", true);
      await h.c.alarm();
      expect(h.c.createLocalAgent).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
      expect(h.keys.has("baskule:alarm-running:agent")).toBe(false);
      // The space's own checks still run and retain its scheduled work.
      expect(h.physicalAlarm()).toBe(future);
    } finally { h.storage.db.close(); }
  });

  it.each(["busy", "outbox", "uncaptured", "child", "existing", "starting"])("runs the agent alarm for %s work", async work => {
    const h = setup();
    try {
      if (work === "busy") h.keys.set("baskule:busy", true);
      if (["outbox", "uncaptured", "child"].includes(work)) {
        usageSchema(h.storage);
        if (work === "outbox") h.storage.db.exec("insert into baskule_usage_outbox values('answer','{}')");
        else h.storage.db.exec(`insert into baskule_usage_context values('turn','session','{}');
          insert into session_message values('answer','${work === "child" ? "child-session" : "session"}','assistant','{"time":{"completed":1},"tokens":{}}');`);
      }
      if (work === "existing") h.c.agent = { alarm: h.alarm };
      if (work === "starting") h.c.agentStarting = Promise.resolve({ alarm: h.alarm });
      const retryAt = Date.now() + 5_000;
      if (work === "outbox") h.alarm.mockImplementation(async () => h.c.alarms.set("agent", retryAt));
      h.keys.set("baskule:alarm-running:agent", true);
      await h.c.alarm();
      expect(h.alarm).toHaveBeenCalledOnce();
      expect(h.keys.has("baskule:alarm-running:agent")).toBe(false);
      if (work === "outbox") expect(h.physicalAlarm()).toBe(retryAt);
    } finally { h.storage.db.close(); }
  });
});

it("persists status changes used for recovery without rewriting an unchanged status", async () => {
  let saved: unknown;
  const c = cell();
  const put = c.ctx.storage.put;
  put.mockImplementation(async (_key: string, value: unknown) => { saved = value; });
  c.ctx.storage.get.mockImplementation(async (key: string) => key === "baskule:status" ? saved : undefined);
  let activeRuns = 0;
  let nextWakeAt: number | null = null;
  const runtime = { ...server(), activeRuns: () => activeRuns, nextWakeAt: () => nextWakeAt };
  await c.cacheStatus(runtime);
  await c.cacheStatus(runtime);
  expect(put).toHaveBeenCalledTimes(1);
  activeRuns = 1;
  await c.cacheStatus(runtime);
  expect(saved).toMatchObject({ activeRuns: 1, nextWakeAt: null });
  nextWakeAt = 123;
  await c.cacheStatus(runtime);
  expect(saved).toMatchObject({ activeRuns: 1, nextWakeAt: 123 });
  activeRuns = 0;
  nextWakeAt = null;
  await c.cacheStatus(runtime);
  expect(saved).toMatchObject({ activeRuns: 0, nextWakeAt: null });
  expect(put).toHaveBeenCalledTimes(4);
});

it("runs synchronous release cleanup on a forced native cell release", async () => {
  vi.useFakeTimers();
  const released = vi.fn();
  createServer.mockImplementationOnce(async (config) => {
    config.onRelease(released);
    return server();
  });
  const c = cell();
  await c.boot("released-space");
  const releaseAgent = vi.fn();
  c.agent = { release: releaseAgent };
  c[Symbol.dispose]();
  expect(released).toHaveBeenCalledOnce();
  expect(releaseAgent).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect((await c.fetch(new Request("http://space/ws"))).status).toBe(503);
});

describe("SpaceCell idle alarm", () => {
  it("never schedules an idle check in the past while a socket stays open", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const c = cell();
    let scheduled: number | null = null;
    c.alarms = { get: async () => scheduled, set: async (_: string, at: number) => { scheduled = at; }, clear: async () => { scheduled = null; } };
    c.server = { ...server(), sockets: () => [{}] };
    c.lastActivity = Date.now() - 10 * 60_000;
    await c.scheduleAlarm();
    expect(scheduled).not.toBeNull();
    expect(scheduled!).toBeGreaterThan(Date.now());
  });

  it("schedules the idle check no earlier than a second from now once sockets are gone", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const c = cell();
    let scheduled: number | null = null;
    c.alarms = { get: async () => scheduled, set: async (_: string, at: number) => { scheduled = at; }, clear: async () => { scheduled = null; } };
    c.server = server();
    c.lastActivity = Date.now() - 10 * 60_000;
    await c.scheduleAlarm();
    expect(scheduled).toBe(Date.now() + 1_000);
  });

  it("leaves an idle cell with an active run on the run heartbeat", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const c = cell();
    let scheduled: number | null = null;
    c.alarms = { get: async () => scheduled, set: async (_: string, at: number) => { scheduled = at; }, clear: async () => { scheduled = null; } };
    c.server = { ...server(), activeRuns: () => 1 };
    c.lastActivity = Date.now() - 10 * 60_000;
    await c.scheduleAlarm();
    expect(scheduled).toBe(Date.now() + RUN_HEARTBEAT_MS);
  });
});

describe("SpaceCell boot/dispose overlap", () => {
  it("finishes the agent alarm before reconfigure retires its shared database", async () => {
    const started = deferred(), release = deferred(), disposing = deferred();
    const order: string[] = [];
    const c = cell();
    c.alarms = { due: async () => ["agent"], complete: async () => {}, sync: async () => {}, clear: async () => {} };
    c.spaceAlarm = async () => {};
    c.agent = {
      alarm: async () => { started.resolve(); await release.promise; order.push("alarm completed"); },
      dispose: async () => { order.push("disposed"); },
    };
    const disposeCurrent = c.disposeCurrent.bind(c);
    c.disposeCurrent = async () => { disposing.resolve(); await disposeCurrent(); };
    const alarm = c.alarm();
    await started.promise;
    const reload = c.fetch(new Request("http://space/_baskule/reconfigure", { method: "POST" }));
    await disposing.promise;
    await Promise.resolve();
    release.resolve();
    await Promise.all([alarm, reload]);
    expect(order).toEqual(["alarm completed", "disposed"]);
  });

  it("runs a newly delivered agent alarm after an in-flight reconfigure finishes", async () => {
    const started = deferred(), release = deferred(), delivered = deferred();
    const order: string[] = [];
    const c = cell();
    c.alarms = { due: async () => { delivered.resolve(); return ["agent"]; }, complete: async () => {}, sync: async () => {}, clear: async () => {} };
    c.spaceAlarm = async () => {};
    c.agent = { dispose: async () => { started.resolve(); await release.promise; order.push("disposed"); } };
    c.ctx.storage.get.mockImplementation(async (key: string) => key === "baskule:busy" ? true : undefined);
    c.localAgent = async () => ({ alarm: async () => { order.push("alarm completed"); } });
    const reload = c.fetch(new Request("http://space/_baskule/reconfigure", { method: "POST" }));
    await started.promise;
    const alarm = c.alarm();
    await delivered.promise;
    await Promise.resolve();
    release.resolve();
    await Promise.all([reload, alarm]);
    expect(order).toEqual(["disposed", "alarm completed"]);
  });

  it("retains both events while a replacement waits for the shared runtime to close", async () => {
    vi.useFakeTimers();
    const closing = deferred();
    createServer.mockResolvedValueOnce(server(vi.fn(() => closing.promise))).mockResolvedValueOnce(server());
    const lifetimes: Promise<unknown>[] = [];
    const c = cell(undefined, undefined, promise => { lifetimes.push(promise); });
    await c.boot("space");
    let oldEnded = false;
    void lifetimes[0]!.then(() => { oldEnded = true; });
    const oldDispose = c.dispose();
    await vi.waitFor(() => expect(c.server).toBeNull());
    const replacement = c.boot("space");
    await Promise.resolve();
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(lifetimes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(2);
    expect(oldEnded).toBe(false);
    closing.resolve();
    await oldDispose;
    await replacement;
    expect(oldEnded).toBe(true);
    let replacementEnded = false;
    await lifetimes[1];
    void lifetimes[2]!.then(() => { replacementEnded = true; });
    expect(vi.getTimerCount()).toBe(1);
    expect(c.server).not.toBeNull();
    expect(c.releaseBootKeepAlive).toBeTypeOf("function");
    expect(replacementEnded).toBe(false);
    await c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(replacementEnded).toBe(true);
  });

  it("releases the queued event when the replacement boot fails", async () => {
    vi.useFakeTimers();
    const disposing = deferred(), release = deferred();
    createServer.mockResolvedValueOnce(server(vi.fn(async () => { disposing.resolve(); await release.promise; })))
      .mockRejectedValueOnce(new Error("boot failed"));
    const lifetimes: Promise<unknown>[] = [];
    const c = cell(undefined, undefined, promise => { lifetimes.push(promise); });
    await c.boot("space");
    const closing = c.dispose();
    await disposing.promise;
    const replacement = c.boot("space");
    const rejected = expect(replacement).rejects.toThrow("boot failed");
    release.resolve();
    await closing;
    await rejected;
    await Promise.all(lifetimes);
    expect(c.booting).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds new requests behind a reconfigure that is waiting for the current boot", async () => {
    vi.useFakeTimers();
    const booting = deferred(), started = deferred(), closing = deferred(), disposing = deferred();
    const oldFetch = vi.fn(async () => new Response("old settings"));
    createServer.mockImplementationOnce(async () => {
      started.resolve();
      await booting.promise;
      return { ...server(vi.fn(async () => { disposing.resolve(); await closing.promise; })), fetch: oldFetch };
    }).mockResolvedValueOnce({ ...server(), fetch: async () => new Response("new settings") });
    const c = cell();
    const firstBoot = c.boot("space");
    await started.promise;
    const reload = c.fetch(new Request("http://space/_baskule/reconfigure", { method: "POST" }));
    const request = c.fetch(new Request("http://space/ws", { headers: { "x-baskule-base": "/s/space" } }));
    booting.resolve();
    try {
      await disposing.promise;
      expect(oldFetch).not.toHaveBeenCalled();
      closing.resolve();
      await reload;
      expect(await (await request).text()).toBe("new settings");
    } finally {
      booting.resolve(); closing.resolve();
      await Promise.all([firstBoot, reload, request]);
      await c.dispose();
      createServer.mockReset();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still disposes when a pending reconfigure keeps an active run alive", async () => {
    vi.useFakeTimers();
    const scheduling = deferred(), scheduled = deferred();
    const close = vi.fn(async () => {});
    createServer.mockResolvedValueOnce({ ...server(close), activeRuns: () => 1 });
    const c = cell();
    await c.boot("space");
    c.scheduleAlarm = async () => { scheduling.resolve(); await scheduled.promise; };
    const reload = c.fetch(new Request("http://space/_baskule/reconfigure", { method: "POST" }));
    await scheduling.promise;
    const disposed = c.dispose();
    scheduled.resolve();
    try {
      await Promise.all([reload, disposed]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await c.dispose();
      createServer.mockReset();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects late agent requests while the retired runtime's usage writes are draining", async () => {
    vi.useFakeTimers();
    const flushing = deferred(), started = deferred();
    createServer.mockResolvedValueOnce(server());
    const c = cell();
    await c.boot("space");
    c.agent = { dispose: async () => {}, usage: {
      flush: () => { started.resolve(); return flushing.promise; },
      capture: async () => {}, hasPending: async () => false,
    } };
    const createAgent = vi.fn(async () => ({ fetch: async () => Response.json({ ok: true }) }));
    c.createLocalAgent = createAgent;
    const closing = c.dispose();
    await started.promise;
    try {
      const response = await c.fetch(new Request("http://space/_baskule/agent/oc/api/info", {
        headers: { "x-baskule-base": "/s/space" },
      }));
      expect(response.status).toBe(503);
      expect(createAgent).not.toHaveBeenCalled();
    } finally { flushing.resolve(); await closing; }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an in-flight usage flush before replacing the shared SQL client", async () => {
    vi.useFakeTimers();
    const flushing = deferred(), started = deferred();
    createServer.mockResolvedValueOnce(server()).mockResolvedValueOnce(server());
    const lifetimes: Promise<unknown>[] = [];
    const c = cell(undefined, undefined, promise => { lifetimes.push(promise); });
    await c.boot("space");
    let bootEnded = false;
    void lifetimes[0]!.then(() => { bootEnded = true; });
    const database = c.database;
    c.agent = { dispose: async () => {}, usage: {
      flush: () => { started.resolve(); return flushing.promise; },
      capture: async () => {}, hasPending: async () => false,
    } };
    const closing = c.dispose();
    await started.promise;
    expect(bootEnded).toBe(false);
    const replacement = c.boot("space");
    await Promise.resolve();
    expect(c.database).toBe(database);
    expect(createServer).toHaveBeenCalledTimes(1);
    flushing.resolve();
    await closing;
    await replacement;
    expect(createServer).toHaveBeenCalledTimes(2);
    await c.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the runtime and releases its timer even if storage was lost", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(async () => {});
    createServer.mockResolvedValueOnce(server(dispose));
    const c = cell(vi.fn(async () => { throw new Error("storage lost"); }));
    await c.boot("space");
    await c.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});


it("reports a cold cell's existing computer without booting T3", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ phase: "ready" }));
  vi.stubGlobal("fetch", fetcher);
  const get = vi.fn(async (key: string) => key === "baskule:spaceId" ? "space-a" : undefined);
  const c = new SpaceCell({ storage: { get } } as never, {
    COMPUTERD_URL: "http://computerd", COMPUTERD_TOKEN: "test-token",
  } as never);
  const response = await c.fetch(new Request("http://space/_baskule/status"));
  expect(await response.json()).toMatchObject({ awake: false, computer: { phase: "ready" } });
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://computerd/v1/spaces/space-a/computer");
  expect(createServer).not.toHaveBeenCalled();
});


it("restores the embedded agent from persisted identity when the runtime has no name", async () => {
  const get = vi.fn(async (key: string) => key === "baskule:spaceId" ? "restored-space" : undefined);
  const c = new SpaceCell({ id: { name: undefined }, storage: { get } } as never, { CONTROL: control } as never) as any;
  const agent = await c.localAgent();
  expect(agent.spaceId).toBe("restored-space");
  expect(await c.localAgent()).toBe(agent);
  await agent.dispose("restored identity test");
});


it("enters the same cell through a live request before invoking the embedded agent", async () => {
  const fetchAgent = vi.fn(async (_request: Request) => Response.json({ ok: true }));
  const getByName = vi.fn(() => ({ fetch: fetchAgent }));
  const c = cell();
  c.env.SPACE = { getByName };
  createServer.mockResolvedValueOnce(server());
  await c.boot("space-live-event");
  const { agentFetch } = createServer.mock.calls[0]![0];
  const response = await agentFetch(new Request("http://agent/oc/api/info?probe=1", {
    headers: { "x-test": "preserved" },
  }));
  expect(getByName).toHaveBeenCalledWith("space-live-event");
  const forwarded = fetchAgent.mock.calls[0]![0] as Request;
  expect(forwarded.url).toBe("http://agent/_baskule/agent/oc/api/info?probe=1");
  expect(forwarded.headers.get("x-test")).toBe("preserved");
  expect(await response.json()).toEqual({ ok: true });
  expect(c.agent).toBeNull();
  await c.dispose();
});


it("forwards the agent request body independently of the caller's abort signal", async () => {
  const fetchAgent = vi.fn(async (_request: Request) => Response.json({ ok: true }));
  const c = cell();
  c.env.SPACE = { getByName: () => ({ fetch: fetchAgent }) };
  createServer.mockResolvedValueOnce(server());
  await c.boot("space-cancellation");
  try {
    const controller = new AbortController();
    const { agentFetch } = createServer.mock.calls[0]![0];
    const response = agentFetch(new Request("http://agent/oc/api/session?probe=1", {
      method: "POST", headers: { "content-type": "application/json", "x-test": "kept" },
      body: JSON.stringify({ prompt: "kept" }), signal: controller.signal,
    }));
    controller.abort();
    const forwarded = fetchAgent.mock.calls[0]![0];
    expect(forwarded.signal.aborted).toBe(false);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("http://agent/_baskule/agent/oc/api/session?probe=1");
    expect(forwarded.headers.get("x-test")).toBe("kept");
    expect(await forwarded.json()).toEqual({ prompt: "kept" });
    expect(await (await response).json()).toEqual({ ok: true });
  } finally { await c.dispose(); }
});


it("boots OpenCode before T3 in a new space, so OpenCode can create its schema in the empty database", async () => {
  const order: string[] = [];
  const c = cell(undefined, []);
  c.localAgent = vi.fn(async () => ({ boot: async () => { order.push("opencode"); } }));
  createServer.mockImplementationOnce(async () => { order.push("t3"); return server(); });
  await c.boot("new-space");
  expect(order).toEqual(["opencode", "t3"]);
  await c.dispose();
});

it.each([false, true])("refreshes managed skills on an already running v2 computer, clearing=%s", async clear => {
  const installed: { path: string; content: string }[][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/computer")) return Response.json({ phase: "ready", running: true });
    const command = JSON.parse(String(init?.body));
    installed.push(JSON.parse(Buffer.from(command.stdin, "base64").toString()));
    return new Response('{"t":"x","code":0}\n');
  });
  const c = cell();
  c.env.COMPUTERD_URL = "http://computerd";
  c.env.COMPUTERD_TOKEN = "test-token";
  c.ctx.storage.get.mockImplementation(async (key: string) => key === "baskule:spaceId" ? "space-a" : key === "baskule:plugin-skills" ? true : undefined);
  c.env.CONTROL = { getByName: () => ({ fetch: async () => Response.json({ ...defaultSettings, apiKey: "test", plugins: { servers: [], skills: clear ? [] : [{ pluginId: "plugin", name: "notes", description: "Notes", files: [{ path: "SKILL.md", content: btoa("Updated notes"), encoding: "base64" }] }] } }) }) };
  expect((await c.fetch(new Request("http://space/_baskule/reconfigure", { method: "POST" }))).ok).toBe(true);
  expect(installed).toEqual([clear ? [] : [{ path: "plugin/notes/SKILL.md", content: btoa("Updated notes") }]]);
  expect(createServer).not.toHaveBeenCalled();
});


it("releases the agent and boot keepalive even when release callbacks throw", async () => {
  vi.useFakeTimers();
  const c = cell();
  const second = vi.fn();
  const releaseAgent = vi.fn(() => { throw new Error("agent release failed"); });
  c.releaseCallbacks.add(() => { throw new Error("callback failed"); });
  c.releaseCallbacks.add(second);
  c.agent = { release: releaseAgent };
  c.releaseBootKeepAlive = vi.fn();
  const releaseBoot = c.releaseBootKeepAlive;
  expect(() => c[Symbol.dispose]()).toThrow("Space release failed");
  expect(second).toHaveBeenCalledOnce();
  expect(releaseAgent).toHaveBeenCalledOnce();
  expect(releaseBoot).toHaveBeenCalledOnce();
  expect(c.agent).toBeNull();
  expect(c.releaseBootKeepAlive).toBeNull();
  expect(c.releaseCallbacks.size).toBe(0);
});
