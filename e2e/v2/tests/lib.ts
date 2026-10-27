// Shared helpers of the 0.2 browser end-to-end suite (e2e/v2). The stack is the real one (deploy/v2, :47090);
// run.sh holds the stack lock, points the cells at the e2e LLM router and exports the coordinates.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:47090";
export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const V2 = path.join(ROOT, "deploy/v2");
export const ARTIFACTS = path.resolve(import.meta.dirname, "../artifacts");
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
/** Real-model subset enabled (E2E_REAL=1): messages tagged [[real]] go to mistral-large-4 through the router. */
export const REAL = process.env.E2E_REAL === "1";

// ---- .env (never logged) ---------------------------------------------------------------------------------------
export function envGet(key: string): string {
  const line = readFileSync(path.join(V2, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .pop();
  return line ? line.slice(key.length + 1) : "";
}

// ---- shell ----------------------------------------------------------------------------------------------------
export function sh(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    input: opts.input,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** computerd API from inside the stack network (bearer from .env, never printed). */
export function computerd(pathname: string, method: "GET" | "POST" = "GET", body?: unknown): any {
  const args = ["exec", "baskule02-celld-a", "curl", "-s", "-m", "60", "-X", method, "-H", `Authorization: Bearer ${envGet("COMPUTERD_TOKEN")}`];
  if (body !== undefined) args.push("-H", "content-type: application/json", "--data", JSON.stringify(body));
  args.push(`http://baskule-computerd:47094/v1${pathname}`);
  const out = sh("docker", args, { timeoutMs: 90_000 });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** The space computer's status (never starts it): {phase: absent|starting|ready|stopping|stopped|error, running, ...}. */
export function computerStatus(spaceId: string): { phase: string; running: boolean; [k: string]: unknown } {
  return computerd(`/spaces/${spaceId}/computer`);
}

/** Runs a bash script on the space computer (starts it). Returns stdout+stderr; throws on a non-zero exit. */
export function cx(spaceId: string, script: string): string {
  return sh("docker", [
    "run", "--rm", "--network", "baskule02-net", "-e", `COMPUTERD_TOKEN=${envGet("COMPUTERD_TOKEN")}`,
    "-v", `${ROOT}/e2e/v2/infra:/infra:ro`, "--entrypoint", "/infra/cx.sh", "baskule-celld:0.2", spaceId, script,
  ], { timeoutMs: 180_000 });
}

/** Last requests the fake LLM received (bodies), newest last. */
export function fakeRequests(): any[] {
  const out = sh("docker", ["exec", "baskule02-e2e-llm", "node", "-e",
    'fetch("http://127.0.0.1:47099/_fake/requests").then(r=>r.text()).then(t=>process.stdout.write(t))']);
  const j = JSON.parse(out);
  return Array.isArray(j) ? j : j.requests ?? [];
}

export function routerUsage(): { requests: number; input: number; output: number; upperBoundUsd: number } {
  return JSON.parse(sh("docker", ["exec", "baskule02-e2e-llm", "node", "-e",
    'fetch("http://127.0.0.1:47098/_router/usage").then(r=>r.text()).then(t=>process.stdout.write(t))']));
}

/** compose on the 0.2 project (as deploy/v2/lib.sh does). */
export function dc(args: string[], env: Record<string, string> = {}, timeoutMs = 300_000): string {
  return sh("docker", ["compose", "--project-directory", V2, "-f", `${V2}/docker-compose.yml`, ...args], {
    timeoutMs,
    env: { COMPOSE_BAKE: "false", DOCKER_CONFIG: `${process.env.HOME}/.local/baskule02/docker-cli`, ...env },
  });
}

/** Organization idle policy for the run; computers keep running. */
export function applyIdleMinutes(minutes = process.env.E2E_IDLE_MINUTES ?? "1.5"): void {
  sh(process.execPath, [`${ROOT}/e2e/v2/llm/settings.mjs`, "idle", minutes]);
  waitHealthy("baskule02-computerd", 90);
}

export function waitHealthy(container: string, seconds = 180): void {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    let s = "";
    try {
      s = sh("docker", ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container]).trim();
    } catch {}
    if (s === "healthy") return;
    if (Date.now() > deadline) throw new Error(`${container} not healthy (${s})`);
    execFileSync("sleep", ["1"]); // no-fixed-sleep-allow: Poll Docker health until the deadline.
  }
}

// ---- metrics / artifacts --------------------------------------------------------------------------------------
export function metric(scenario: string, data: Record<string, unknown>): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  appendFileSync(path.join(ARTIFACTS, "metrics.jsonl"), JSON.stringify({ scenario, at: new Date().toISOString(), ...data }) + "\n");
}

export async function shot(page: Page, scenario: string, name: string): Promise<void> {
  const dir = path.join(ARTIFACTS, scenario);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

// ---- HTTP API (cookie session) --------------------------------------------------------------------------------
export interface ApiResponse {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export class Api {
  cookie = "";
  bearer = "";
  constructor(readonly label = "anon") {}

  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
    const h: Record<string, string> = { origin: BASE, ...headers };
    if (this.cookie && !("cookie" in headers)) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    for (const [k, v] of Object.entries(h)) if (v === "") delete h[k];
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
      for (const c of set) {
        const kv = c.split(";")[0]!;
        jar.set(kv.split("=")[0]!, kv);
      }
      this.cookie = [...jar.values()].join("; ");
    }
    const tok = r.headers.get("set-auth-token");
    if (tok) this.bearer = tok;
    return { status: r.status, json, text, headers: r.headers };
  }
  get = (p: string, headers?: Record<string, string>) => this.req("GET", p, undefined, headers);
  post = (p: string, body?: unknown, headers?: Record<string, string>) => this.req("POST", p, body ?? {}, headers);

  async signIn(email: string, password: string): Promise<this> {
    const r = await this.post("/auth/sign-in/email", { email, password });
    if (r.status !== 200) throw new Error(`${this.label}: sign-in ${r.status} ${r.text.slice(0, 200)}`);
    return this;
  }
}

// ---- the test world (people and spaces shared by the scenarios of one run) -------------------------------------
export interface Person {
  name: string;
  email: string;
  password: string;
  id: string;
  personal: string; // personal space id
}
export interface World {
  run: string;
  admin: { email: string; password: string };
  alice: Person;
  bob: Person;
  acme: { id: string; name: string };
}

export const RUN = process.env.E2E_RUN ?? new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
/**
 * Each Playwright worker slot has its own fixture world (people, team space), so specs never depend on another spec
 * having run first and parallel workers never see each other's membership changes. Slot 0 keeps the historical names
 * and file (`E2E_RUN`, `world.json` / `E2E_WORLD_FILE`); the serial lifecycle phase runs in slot 0 and reuses it.
 */
export function slot(): number {
  try {
    return test.info().parallelIndex;
  } catch {
    return 0; // outside a test (setup scripts)
  }
}
/** The fixture id of this worker slot: names, emails and the saved world use it. */
export const runId = (): string => (slot() === 0 ? RUN : `${RUN}w${slot()}`);
const WORLD = () => {
  const base = process.env.E2E_WORLD_FILE ?? path.join(ARTIFACTS, "world.json");
  return slot() === 0 ? base : base.replace(/(\.json)?$/, `-w${slot()}.json`);
};

export function adminCreds(): { email: string; password: string } {
  return { email: envGet("ADMIN_EMAIL") || "admin@baskule.local", password: process.env.E2E_ADMIN_PASSWORD || envGet("ADMIN_PASSWORD") };
}

export function names(run = runId()) {
  return {
    alice: { name: `Alice ${run}`, email: `alice-${run}@e2e.test`, password: `alice-${run}-pw-0001` },
    bob: { name: `Bob ${run}`, email: `bob-${run}@e2e.test`, password: `bob-${run}-pw-0001` },
    acme: `Acme ${run}`,
  };
}

export function loadWorld(): World | null {
  if (!existsSync(WORLD())) return null;
  const w = JSON.parse(readFileSync(WORLD(), "utf8")) as World;
  return w.run === runId() ? w : null;
}
export function saveWorld(w: World): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(WORLD(), JSON.stringify(w, null, 2));
}

export async function adminApi(): Promise<Api> {
  return personApi({ ...adminCreds(), name: "admin" });
}

/**
 * A signed-in API session for a person, reused across scenarios (the front rate-limits sign-ins to 10 per minute
 * per client address, and the whole suite comes from one address). Cached in memory and in artifacts/sessions.json
 * (test accounts only); revalidated with /me. `fresh: true` signs in anew (scenarios that sign out or revoke).
 */
const sessionCache = new Map<string, Api>();
const SESSIONS = () => path.join(ARTIFACTS, "sessions.json");
export async function personApi(p: { email: string; password: string; name?: string }, opts: { fresh?: boolean } = {}): Promise<Api> {
  if (!opts.fresh) {
    let api = sessionCache.get(p.email);
    if (!api && existsSync(SESSIONS())) {
      const saved = JSON.parse(readFileSync(SESSIONS(), "utf8"))[p.email];
      if (saved?.run === RUN) {
        api = new Api(p.name ?? p.email);
        api.cookie = saved.cookie;
      }
    }
    if (api && (await api.get("/api/baskule/me")).status === 200) {
      sessionCache.set(p.email, api);
      return api;
    }
  }
  const api = await signInPatiently(new Api(p.name ?? p.email), p.email, p.password);
  if (!opts.fresh) {
    sessionCache.set(p.email, api);
    mkdirSync(ARTIFACTS, { recursive: true });
    const all = existsSync(SESSIONS()) ? JSON.parse(readFileSync(SESSIONS(), "utf8")) : {};
    all[p.email] = { run: RUN, cookie: api.cookie };
    writeFileSync(SESSIONS(), JSON.stringify(all), { mode: 0o600 });
  }
  return api;
}

/** Sign-in that waits out the front's rate limit (429) instead of failing. */
export async function signInPatiently(api: Api, email: string, password: string): Promise<Api> {
  for (let i = 0; ; i++) {
    const r = await api.post("/auth/sign-in/email", { email, password });
    if (r.status === 200) return api;
    if (r.status !== 429 || i >= 8) throw new Error(`${api.label}: sign-in ${r.status} ${r.text.slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 10_000)); // no-fixed-sleep-allow: Back off after HTTP 429 before retrying sign-in.
  }
}

/** Opens the app signed in as `p` by reusing its API session cookie (no sign-in request). */
export async function signInBrowser(page: Page, p: { email: string; password: string; name?: string }, url = "/"): Promise<Api> {
  const api = await personApi(p);
  const cookies = api.cookie.split("; ").filter(Boolean).map((kv) => {
    const i = kv.indexOf("=");
    return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
  });
  await page.context().addCookies(cookies);
  await page.goto(url);
  await waitShell(page);
  return api;
}

async function me(api: Api): Promise<any> {
  const r = await api.get("/api/baskule/me");
  if (r.status !== 200) throw new Error(`me ${r.status}`);
  return r.json;
}

/** The fixture world of this run and worker slot, created through the API on first use (declared setup). */
export async function world(): Promise<World> {
  const w = await loadOrCreateWorld();
  if (!knownSpaces.includes(w.acme.name)) knownSpaces.push(w.acme.name);
  return w;
}

async function loadOrCreateWorld(): Promise<World> {
  const saved = loadWorld();
  if (saved) return saved;
  const n = names();
  const admin = await adminApi();
  const people: Record<"alice" | "bob", Person> = {} as any;
  for (const who of ["alice", "bob"] as const) {
    const p = n[who];
    const r = await admin.post("/api/baskule/admin/users", { email: p.email, name: p.name, password: p.password });
    if (r.status !== 201 && r.status !== 200 && r.status !== 409) throw new Error(`create ${who}: ${r.status} ${r.text}`);
    const m = await me(await personApi(p));
    people[who] = { ...p, id: m.user.id, personal: m.spaces.find((s: any) => s.kind === "personal").id };
  }
  const s = await admin.post("/api/baskule/spaces", {
    name: n.acme,
    members: [{ email: n.alice.email, role: "owner" }, { email: n.bob.email, role: "member" }],
  });
  if (s.status !== 201) throw new Error(`create acme: ${s.status} ${s.text}`);
  const w: World = { run: runId(), admin: adminCreds(), alice: people.alice, bob: people.bob, acme: { id: s.json.space.id, name: n.acme } };
  saveWorld(w);
  return w;
}

// ---- raw HTTP (WebSocket upgrades, unnormalised paths) -----------------------------------------------------------
/** Sends a WebSocket upgrade request; resolves with the HTTP status (101 = accepted). */
export function upgradeStatus(p: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: p, method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/** GET with the path sent byte-for-byte (no URL normalisation), e.g. `..` or encoded segments. */
export function rawGet(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: "GET", headers });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** One Effect-RPC call over a space's WebSocket, from Node (cookie + Origin as a browser would send). */
export async function spaceRpc(api: Api, spaceId: string, tag: string, payload: unknown, headers: Record<string, string> = {}): Promise<any> {
  const url = `${BASE.replace(/^http/, "ws")}${wsPath(spaceId)}`;
  // Node's WebSocket (undici) accepts extra headers.
  const ws = new (globalThis as any).WebSocket(url, { headers: { cookie: api.cookie, origin: BASE, ...headers } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`rpc ${tag}: timeout`)); }, 30_000);
    ws.onerror = (e: any) => { clearTimeout(timer); reject(new Error(`rpc ${tag}: socket error ${e?.message ?? ""}`)); };
    ws.onclose = (e: any) => { clearTimeout(timer); reject(new Error(`rpc ${tag}: closed ${e.code} ${e.reason}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
    ws.onmessage = (m: any) => {
      const msg = JSON.parse(String(m.data));
      if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
      if (msg._tag === "Exit" && String(msg.requestId) === "1") {
        clearTimeout(timer);
        ws.onclose = null;
        ws.close();
        resolve(msg.exit);
      }
    };
  });
}

// ---- UI ----------------------------------------------------------------------------------------------------------
export async function newDevice(browser: Browser, kind: "desktop" | "phone" = "desktop"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    kind === "desktop"
      ? { viewport: DESKTOP, acceptDownloads: true, baseURL: BASE }
      : { viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true, baseURL: BASE },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${kind} pageerror] ${e.message.slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon/.test(m.text())) console.log(`[${kind} console.error] ${m.text().slice(0, 300)}`);
  });
  return { context, page };
}

/**
 * Chrome runs on the Docker host: container starts/stops anywhere on the host (veth churn) can abort in-flight
 * module loads with net::ERR_NETWORK_CHANGED, which shows the boot error. Real clients never see this: one reload.
 */
async function settle(page: Page, ready: ReturnType<Page["locator"]>, timeout = 90_000): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bootError = page.locator("#boot-error");
    await expect(ready.or(bootError).first()).toBeVisible({ timeout });
    if (!(await bootError.isVisible().catch(() => false))) return;
    await page.reload();
  }
  await expect(ready.first()).toBeVisible({ timeout });
}

export async function signInUI(page: Page, who: { email: string; password: string }, next = "/"): Promise<void> {
  await page.goto(`/login${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}`);
  await settle(page, page.getByLabel("Email"));
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  for (let i = 0; ; i++) {
    await page.getByRole("button", { name: "Sign in" }).click();
    const ok = await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 }).then(() => true, () => false);
    if (ok) break;
    // The front allows 10 sign-ins per minute per address; the suite shares one address.
    if (i >= 8 || !(await page.getByRole("alert").innerText().catch(() => "")).match(/too many|try again/i)) {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
      break;
    }
    await page.waitForTimeout(10_000); // no-fixed-sleep-allow: Back off after the rate-limit alert before retrying sign-in.
  }
  await waitShell(page);
}

/** The signed-in app shell (the phone mounts the user menu only in the drawer). */
export async function waitShell(page: Page): Promise<void> {
  await settle(page, page.locator('[data-sidebar-control], [data-testid="baskule-user-menu"]'));
}

export function composer(page: Page) {
  return page.locator('[contenteditable="true"]').first();
}

/** Waits until the spaces answered and the composer is usable. */
export async function waitComposer(page: Page, timeout = 90_000): Promise<void> {
  await settle(page, composer(page), timeout);
}

const THREAD_URL = /\/(?!draft\/)([^/?#]+)\/([0-9a-f-]{36})(?:[?#].*)?$/;
export function threadIdOf(page: Page): string {
  const m = THREAD_URL.exec(page.url());
  if (!m) throw new Error(`not a thread URL: ${page.url()}`);
  return m[2]!;
}

/** Sidebar: on the phone the list lives in a drawer. */
export async function ensureSidebar(page: Page): Promise<void> {
  const newChat = page.getByTestId("baskule-new-chat");
  if (await newChat.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Toggle main sidebar" }).first().click();
  await expect(newChat).toBeVisible();
  // The phone drawer slides in and re-renders its rows: wait until it stops moving.
  let last = "";
  for (let i = 0; i < 20; i++) {
    const box = JSON.stringify(await newChat.boundingBox().catch(() => null));
    if (box === last) break;
    last = box;
    await page.waitForTimeout(150); // no-fixed-sleep-allow: Sample drawer position until stable, at most twenty attempts.
  }
}

export async function closeDrawerIfPhone(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) > 600) return;
  if (await page.getByTestId("baskule-new-chat").isVisible().catch(() => false)) await page.keyboard.press("Escape");
}

/**
 * The draft chat's space picker is the combobox labelled "Run on".
 */
export function spacePicker(page: Page) {
  return page.getByRole("combobox", { name: "Run on", exact: true });
}

/** Lists the "Run on" entries of the picker (in order). */
export async function spaceOptions(page: Page, spaces: string[]): Promise<string[]> {
  await spacePicker(page).click();
  const items = page.getByRole("option");
  await expect(items.first()).toBeVisible();
  const all = (await items.allInnerTexts()).map((s) => s.trim());
  await page.keyboard.press("Escape");
  return all.filter((s) => spaces.includes(s));
}

/** Picks the space of the draft chat. */
export async function chooseSpace(page: Page, spaceName: string): Promise<void> {
  const picker = spacePicker(page);
  await expect(picker).toBeVisible();
  if ((await picker.innerText()).trim() === spaceName) return;
  await picker.click();
  await page.getByRole("option", { name: spaceName, exact: true }).click();
  await expect(spacePicker(page)).toHaveText(spaceName);
}

/** Space names the helpers recognise in the picker (the world's spaces; scenarios may add theirs). */
export const knownSpaces: string[] = ["Personal"];

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reuse an empty draft, or wait for New chat's asynchronous navigation before editing it.
 * New chat first awaits its scratch project; an existing composer can still belong to the old route.
 */
export async function openNewChat(page: Page): Promise<void> {
  await ensureSidebar(page);
  const previous = page.url();
  const isDraft = /^\/draft\/[^/]+$/.test(new URL(previous).pathname);
  const empty = isDraft && (await composer(page).innerText()).trim() === "";
  if (!empty) {
    await page.getByTestId("baskule-new-chat").click();
    await page.waitForURL((url) => url.href !== previous && /^\/draft\/[^/]+$/.test(url.pathname), { timeout: 90_000 });
  }
  await closeDrawerIfPhone(page);
  await waitComposer(page);
}

/** Starts a new chat (optionally in a space) with `text`; returns the thread id. */
export async function startChat(page: Page, text: string, spaceName?: string): Promise<string> {
  if (spaceName && !knownSpaces.includes(spaceName)) knownSpaces.push(spaceName);
  await openNewChat(page);
  await chooseSpace(page, spaceName ?? "Personal");
  return sendInCurrent(page, text);
}

export async function sendInCurrent(page: Page, text: string): Promise<string> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(userMessages(page).filter({ hasText: visiblePrefix(text) }).last()).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(THREAD_URL, { timeout: 30_000 });
  return threadIdOf(page);
}

/** The first characters of a message as rendered (markers render as typed). */
export const visiblePrefix = (text: string) => text.replaceAll("`", "").slice(0, 24);

export function userMessages(page: Page) {
  return page.locator('[data-message-role="user"]');
}
export function assistantMessages(page: Page) {
  return page.locator('[data-message-role="assistant"]');
}
export function stopButton(page: Page) {
  return page.getByRole("button", { name: "Stop generation" });
}

export async function lastAssistantText(page: Page): Promise<string> {
  const all = assistantMessages(page);
  const n = await all.count();
  if (n === 0) return "";
  const body = all.nth(n - 1).locator('[data-thread-find-text="true"]').first();
  const t = (await body.innerText().catch(() => "")) || (await all.nth(n - 1).innerText().catch(() => ""));
  return t.trim();
}

/** Waits until an assistant message contains `re` (a run's answer). */
export async function waitAnswer(page: Page, re: RegExp, timeout = 120_000): Promise<string> {
  await expect(assistantMessages(page).filter({ hasText: re }).last()).toBeVisible({ timeout });
  return lastAssistantText(page);
}

/** Waits until the run is over: an assistant message exists and no "Stop generation" button for 1.5 s. */
export async function waitRunDone(page: Page, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const running = await stopButton(page).isVisible().catch(() => false);
    const has = (await assistantMessages(page).count()) > 0;
    if (!running && has) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince > 1500) return;
    } else quietSince = 0;
    await page.waitForTimeout(250); // no-fixed-sleep-allow: Poll until the run has remained quiet, bounded by the deadline.
  }
  throw new Error("run did not finish in time");
}

export function chatRow(page: Page, threadId: string) {
  return page.locator(`[data-thread-id="${threadId}"]`);
}

/** Opens an existing chat the way a user does: from the chat list (drawer on the phone). */
export async function openChat(page: Page, threadId: string): Promise<void> {
  await ensureSidebar(page);
  await expect(chatRow(page, threadId)).toBeVisible({ timeout: 60_000 });
  await chatRow(page, threadId).click();
  await expect(page).toHaveURL(new RegExp(threadId));
  await expect(page.locator('[data-timeline-root="true"]').first()).toBeVisible({ timeout: 60_000 });
}

export async function chatMenu(page: Page, threadId: string, item: string): Promise<void> {
  await ensureSidebar(page);
  const row = chatRow(page, threadId);
  await row.hover();
  await row.getByTestId("baskule-chat-menu-button").click({ force: true });
  await page.getByRole("button", { name: item, exact: true }).or(page.getByRole("menuitem", { name: item, exact: true })).last().click();
}

export async function toggleFiles(page: Page, open = true): Promise<void> {
  const tree = page.getByRole("tree").first();
  if ((await tree.isVisible().catch(() => false)) === open) return;
  await page.getByRole("button", { name: "Toggle right panel" }).click();
}

export async function download(page: Page, button: ReturnType<Page["getByRole"]>): Promise<{ name: string; bytes: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return { name: dl.suggestedFilename(), bytes: readFileSync((await dl.path())!) };
}

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(fn: () => T | Promise<T>, timeoutMs: number, stepMs = 1000, what = "condition"): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what} (last: ${String(last instanceof Error ? last.message : JSON.stringify(last))})`);
    await new Promise((r) => setTimeout(r, stepMs)); // no-fixed-sleep-allow: Poll the caller condition until the deadline.
  }
}

/** A space's WebSocket path as the client opens it (T3 refuses sockets without the protocol version). */
export const wsPath = (spaceId: string) => `/s/${spaceId}/ws?orchestrationProtocol=2`;
