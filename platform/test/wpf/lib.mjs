// Helpers of the WP-F feature runner: a signed-in client of the real platform app (Worker + ControlCell + SpaceCell with T3 and
// OpenCode) on the WP-F dev stack, the way the web client talks to it (cookie session, Origin, /s/<id>/ws RPC).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcClient, waitFor } from "../../src/space/test/rpc-client.mjs";

export { waitFor };
const STACK = fileURLToPath(new URL("../../../.run/stack/stack.json", import.meta.url));
const stack = JSON.parse(readFileSync(STACK, "utf8"));
export const BASE = stack.urls.loopback;
export const FRONT = stack.urls.front;
export const COMPUTERD = `http://127.0.0.1:${stack.ports.computerd}`;
export const COMPUTERD_TOKEN = stack.computerdToken;
export const FAKE_LLM = `http://127.0.0.1:${stack.ports["fake-llm"]}`;
export const ADMIN = stack.admin;
export const MODEL = { instanceId: "opencode", model: "custom/fake-model" };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
export const assert = (cond, msg) => {
  if (!cond) throw new Error(typeof msg === "function" ? msg() : msg);
};
export const short = (v, n = 400) => JSON.stringify(v)?.slice(0, n);

/** Read the initial list and close the subscription; no long-lived watcher is needed. */
export const scheduledTasks = (client) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error("schedule snapshot timed out")); }, 30_000);
  const unsubscribe = client.stream("scheduledTasks.subscribe", {}, (snapshot) => {
    clearTimeout(timeout);
    unsubscribe();
    resolve(snapshot.tasks);
  });
});

/** A signed-in person: cookie session, JSON API helper, RPC sockets to their spaces. */
export class Person {
  constructor(email, password, cookie) {
    this.email = email;
    this.password = password;
    this.cookie = cookie;
  }

  static async signIn(email, password) {
    const r = await fetch(`${BASE}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`sign-in ${email}: ${r.status} ${await r.text()}`);
    const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")])
      .filter(Boolean)
      .map((c) => c.split(";")[0])
      .join("; ");
    const p = new Person(email, password, cookie);
    p.me = await p.json("GET", "/api/baskule/me");
    return p;
  }

  headers(extra = {}) {
    return { cookie: this.cookie, origin: BASE, ...extra };
  }

  async http(method, path, body, extra = {}) {
    return fetch(`${BASE}${path}`, {
      method,
      headers: this.headers(body === undefined ? extra : { "content-type": "application/json", ...extra }),
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
  }

  async json(method, path, body) {
    const r = await this.http(method, path, body);
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** RPC socket to a space (as the web client: cookie + Origin, `/s/<id>/ws`). */
  rpc(spaceId) {
    return openRpc(spaceId, this.headers());
  }
}

export function openRpc(spaceId, headers) {
  const url = `${BASE.replace(/^http/, "ws")}/s/${spaceId}/ws?orchestrationProtocol=2`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const client = new RpcClient(ws);
    ws.onopen = () => resolve(client);
    ws.onerror = (e) => reject(new Error(`upgrade refused: ${e.message ?? "error"}`));
  });
}

let admin;
export async function adminSession() {
  admin ??= await Person.signIn(ADMIN.email, ADMIN.password);
  return admin;
}

/** Creates (or reuses) a person with a temporary password and signs them in. */
export async function person(name, run) {
  const a = await adminSession();
  const email = `${name.toLowerCase()}-${run}@wpf.test`;
  const password = `pw-${name}-${run}-0123456789`;
  const r = await a.http("POST", "/api/baskule/admin/users", { email, name, password });
  if (!r.ok && r.status !== 409) throw new Error(`create ${email}: ${r.status} ${await r.text()}`);
  await a.json("PATCH", "/api/baskule/admin/groups/everyone", { permissions: { canCreateSpaces: true } });
  return Person.signIn(email, password);
}

export async function teamSpace(owner, name, members = []) {
  const created = await owner.json("POST", "/api/baskule/spaces", { name, members: members.map((m) => ({ userId: m.me.user.id })) });
  return created.space?.id ?? created.id;
}

export const personalSpace = (p) => p.me.spaces.find((s) => s.kind === "personal").id;

// ---- T3 streams -----------------------------------------------------------------------------------------------

/** Shell state from a subscribeShell stream: threads by id, kept current. */
export function watchShell(client) {
  const shell = { threads: new Map(), events: 0, ready: false };
  shell.stop = client.stream("orchestration.subscribeShell", {}, (v) => {
    shell.events++;
    if (v.kind === "snapshot") {
      for (const t of v.snapshot?.threads ?? []) shell.threads.set(t.id, t);
      shell.ready = true;
    }
    else if (v.thread?.id) {
      if (v.location === "active") shell.threads.set(v.thread.id, v.thread);
      else shell.threads.delete(v.thread.id);
    } else if (v.kind?.startsWith?.("thread") && v.threadId) shell.threads.delete(v.threadId);
  });
  return shell;
}

/** Thread state from subscribeThread: messages, runs, items, requests, events. */
export function watchThread(client, threadId) {
  const state = { messages: new Map(), runs: new Map(), items: new Map(), requests: new Map(), events: [], raw: [] };
  const apply = (p) => {
    for (const m of p?.messages ?? []) state.messages.set(m.id, m);
    for (const r of p?.runs ?? []) state.runs.set(r.id, r);
    for (const i of p?.turnItems ?? p?.items ?? []) state.items.set(i.id, i);
    for (const q of p?.runtimeRequests ?? p?.requests ?? []) state.requests.set(q.id, q);
    if (p?.thread) state.thread = p.thread;
  };
  state.stop = client.stream("orchestration.subscribeThread", { threadId }, (v) => {
    if (v.projection) apply(v.projection);
    if (v.snapshot) apply(v.snapshot.projection ?? v.snapshot);
    const e = v.event;
    if (!e) return;
    state.events.push(e.type);
    state.raw.push(e);
    if (e.type === "message.updated" || e.type === "message.created") state.messages.set(e.payload.id, e.payload);
    if (e.type === "run.updated" || e.type === "run.created") state.runs.set(e.payload.id, e.payload);
    if (/^turn-item\./.test(e.type) || e.type === "item.updated") if (e.payload?.id) state.items.set(e.payload.id, e.payload);
    if (/runtime-request/.test(e.type) && e.payload?.id) state.requests.set(e.payload.id, e.payload);
    if (e.type === "thread.updated" && e.payload) state.thread = e.payload;
  });
  state.assistantText = () => [...state.messages.values()].filter((m) => m.role === "assistant").map((m) => m.text).join("");
  state.userMessages = () => [...state.messages.values()].filter((m) => m.role === "user");
  state.settled = () => state.runs.size > 0 && [...state.runs.values()].every((r) => ["completed", "failed", "cancelled", "interrupted"].includes(r.status));
  return state;
}

export async function launch(client, projectId, text, title = "WP-F chat", extra = {}) {
  const launched = await client.ok("orchestration.launchThread", {
    commandId: crypto.randomUUID(),
    projectId,
    title,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text, attachments: [] },
    ...extra,
  });
  return launched.threadId;
}

export const dispatch = (client, command) => client.ok("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
export const send = (client, threadId, text, mode = { type: "queue_after_active" }, extra = {}) =>
  dispatch(client, { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `message:wpf:${crypto.randomUUID()}`, text, attachments: [], dispatchMode: mode, ...extra });

// ---- computerd / fake LLM ---------------------------------------------------------------------------------------

export async function computerd(method, path, body) {
  const r = await fetch(`${COMPUTERD}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${COMPUTERD_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

/** Runs argv on a space's computer; returns {code, out}. */
export async function cx(spaceId, argv) {
  const r = await fetch(`${COMPUTERD}/v1/spaces/${spaceId}/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${COMPUTERD_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  let out = "";
  let code = null;
  for (const line of (await r.text()).split("\n").filter(Boolean)) {
    const f = JSON.parse(line);
    if (f.t === "o" || f.t === "e") out += Buffer.from(f.d, "base64").toString();
    if (f.t === "x") code = f.code;
    if (f.t === "err") out += `ERR ${f.msg}`;
  }
  return { code, out };
}

export const fakeRequests = async () => (await (await fetch(`${FAKE_LLM}/_fake/requests`)).json());

// ---- dev stack control ------------------------------------------------------------------------------------------
const STACK_COMMAND = fileURLToPath(new URL("../../../scripts/stack", import.meta.url));
export function restartCelld() {
  return execFileSync(STACK_COMMAND, ["restart", "celld"], { encoding: "utf8", timeout: 600_000, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Admin's live status of a space (SpaceCell /_baskule/status through ControlCell). */
export async function spaceStatus(spaceId) {
  const a = await adminSession();
  return a.json("GET", `/api/baskule/admin/spaces/${spaceId}/status`);
}

/** Messages of a thread (fresh projection). */
export async function projection(client, threadId) {
  const p = await client.ok("orchestration.getThreadProjection", { threadId });
  return p.projection ?? p;
}

/** The shared world of a run: Alice (owner) and Bob in a team space, an RPC socket each, the scratch project. */
export async function world(ctx) {
  const s = ctx.state;
  if (s.alice) return s;
  s.alice = await person("Alice", ctx.run);
  s.bob = await person("Bob", ctx.run);
  s.team = await teamSpace(s.alice, `Team ${ctx.run}`, [s.bob]);
  s.alice = await Person.signIn(s.alice.email, s.alice.password); // refresh /me (new space)
  await reconnect(ctx);
  s.projectId = (await s.ca.ok("projects.ensureScratch", {})).projectId;
  return s;
}

/** (Re)opens Alice's and Bob's sockets to the team space (after a restart). */
export async function reconnect(ctx) {
  const s = ctx.state;
  for (const c of [s.ca, s.cb]) try { c?.close(); } catch {}
  s.ca = await waitFor("alice socket", () => s.alice.rpc(s.team).catch(() => null), 120_000, 1000);
  s.cb = await waitFor("bob socket", () => s.bob.rpc(s.team).catch(() => null), 120_000, 1000);
  (ctx.closers ??= []).push(() => s.ca.close(), () => s.cb.close());
  return s;
}

export function disconnect(ctx) {
  const s = ctx.state;
  for (const c of [s.ca, s.cb]) try { c?.close(); } catch {}
  s.ca = s.cb = null;
}

/** After a restart: one short turn, so the next checks start with the space and its agent warm. */
export async function warm(ctx) {
  const s = ctx.state;
  for (let i = 0; i < 3; i++) {
    const id = await launch(s.ca, s.projectId, "warm-up [[fake:text warm]]", "Warm-up");
    const t = watchThread(s.ca, id);
    const ok = await waitFor("warm-up", () => (t.settled() ? t : null), 90_000).then(() => t.assistantText().includes("warm"), () => false);
    t.stop();
    await s.ca.ok("orchestration.dispatchCommand", { type: "thread.delete", commandId: crypto.randomUUID(), threadId: id }).catch(() => {});
    if (ok) return;
  }
  throw new Error("the space did not answer a warm-up turn after the restart");
}
