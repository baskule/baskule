// Real worktree API: cookie sessions and the same space RPCs used by the browser.
import { RpcClient } from "../../platform/src/space/test/rpc-client.mjs";

import { expect } from "@playwright/test";
async function waitFor(label, fn, timeout = 60000) { let value; await expect.poll(async () => Boolean(value = await fn()), { message: label, timeout }).toBe(true); return value; }
export function createApi(stack) {
  const BASE = stack.urls.loopback;
  const FRONT = stack.urls.front;
  const ADMIN = stack.admin;
  const MODEL = { instanceId: "opencode", model: "custom/fake-model" };

  /** A signed-in person: cookie session, JSON API helper, RPC sockets to their spaces. */
  class Person {
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

  function openRpc(spaceId, headers) {
    const url = `${BASE.replace(/^http/, "ws")}/s/${spaceId}/ws?orchestrationProtocol=2`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new RpcClient(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = (e) => reject(new Error(`upgrade refused: ${e.message ?? "error"}`));
    });
  }

  let admin;
  async function adminSession() {
    admin ??= await Person.signIn(ADMIN.email, ADMIN.password);
    return admin;
  }

  /** Creates a fresh person with a temporary password and signs them in. */
  async function person(name, run) {
    const a = await adminSession();
    const email = `${name.toLowerCase()}-${run}@wpf.test`;
    const password = `pw-${name}-${run}-0123456789`;
    const r = await a.http("POST", "/api/baskule/admin/users", { email, name, password });
    if (!r.ok) throw new Error(`create ${email}: ${r.status} ${await r.text()}`);
    return Person.signIn(email, password);
  }

  async function teamSpace(owner, name, members = []) {
    const created = await owner.json("POST", "/api/baskule/spaces", { name, members: members.map((m) => ({ userId: m.me.user.id })) });
    return created.space?.id ?? created.id;
  }

  const personalSpace = (p) => p.me.spaces.find((s) => s.kind === "personal").id;

  // ---- T3 streams -----------------------------------------------------------------------------------------------

  /** Shell state from a subscribeShell stream: threads by id, kept current. */
  function watchShell(client) {
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
  function watchThread(client, threadId) {
    const state = { messages: new Map(), runs: new Map(), items: new Map(), requests: new Map(), events: [], raw: [], assistantUpdates: 0 };
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
      if (e.type === "message.updated" && e.payload?.role === "assistant") state.assistantUpdates++;
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

  async function launch(client, projectId, text, title = "WP-F chat", extra = {}) {
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

  const dispatch = (client, command) => client.ok("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
  const send = (client, threadId, text, mode = { type: "queue_after_active" }, extra = {}) =>
    dispatch(client, { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `message:wpf:${crypto.randomUUID()}`, text, attachments: [], dispatchMode: mode, ...extra });

  const createUser = (details) => adminSession().then((a) => a.json("POST", "/api/baskule/admin/users", details));
  const createInvitation = (details) => adminSession().then((a) => a.json("POST", "/api/baskule/invitations", details));
  const readFile = (client, cwd, relativePath) => client.ok("projects.readFile", { cwd, relativePath });
  const waitRun = (state) => waitFor("run settled", () => state.settled());
  return { createUser, createInvitation, readFile, waitRun, BASE, FRONT, MODEL, Person, waitFor, adminSession, person, teamSpace, personalSpace, watchShell, watchThread, launch, dispatch, send, openRpc };
}
