import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../src/control/settings";
import { SpaceCell } from "../../src/space/index";

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
const cell = (put = vi.fn(async () => {}), tables = ["session"], waitUntil: (promise: Promise<unknown>) => void = () => {}) => new SpaceCell({ waitUntil, storage: {
  put,
  get: vi.fn(async () => undefined),
  delete: vi.fn(async () => true),
  deleteAlarm: vi.fn(async () => {}),
  sql: { exec: () => ({ toArray: () => tables.map((name) => ({ name })) }) },
} } as never, { CONTROL: control } as never) as any;

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

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

  it("a replacement waits for the shared runtime to close and keeps its own timer", async () => {
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
    expect(vi.getTimerCount()).toBe(1);
    expect(oldEnded).toBe(false);
    closing.resolve();
    await oldDispose;
    await replacement;
    expect(oldEnded).toBe(true);
    let replacementEnded = false;
    void lifetimes[1]!.then(() => { replacementEnded = true; });
    expect(vi.getTimerCount()).toBe(1);
    expect(c.server).not.toBeNull();
    expect(c.releaseBootKeepAlive).toBeTypeOf("function");
    expect(replacementEnded).toBe(false);
    await c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(replacementEnded).toBe(true);
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
