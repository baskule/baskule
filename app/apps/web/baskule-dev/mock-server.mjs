// baskule: mock front with in-memory Better Auth-shaped /auth and /api/baskule routes.
// /s/:space proxies real T3 servers; /downloads serves fake apps; other routes serve Vite or dist.
// T3 uses one OpenCode CLI backed by the fake LLM. MOCK_PORT/WEB/VITE_PORT/T3_PORT_BASE/OPENCODE_URL
// choose listeners; MOCK_STATE_DIR holds state; MOCK_BACKENDS disables T3; MOCK_INJECT_AUTHOR stamps messages.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { createPluginMock } from "./mock-plugins.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const WEB_ROOT = NodePath.resolve(HERE, "..");
const REPO_ROOT = NodePath.resolve(WEB_ROOT, "../..");
const authConfig = { mode: "authenticated", password: true, providers: [] };
let productSettings = {
  organizationName: "Mock organisation",
  idleMinutes: 10,
  ai: {
    providerId: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: {
      id: "mistral-large-4",
      name: "Mistral Large 4",
      image: true,
      pdf: true,
      limit: { context: 524288, output: 262144 },
      cost: { input: 0.68, output: 2.09, cache_read: 0.07 },
      settings: {},
    },
  },
  transcription: {
    enabled: true,
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-transcribe",
  },
};
/** What each built-in provider lists for any accepted key (shape of platform/src/control/ai-models.ts). */
const MOCK_PROVIDER_MODELS = {
  mistral: [
    {
      id: "mistral-large-4",
      name: "Mistral Large 4",
      limit: { context: 524288, output: 262144 },
      cost: { input: 0.68, output: 2.09, cache_read: 0.07 },
    },
    {
      id: "mistral-small-2603",
      name: "Mistral Small 4",
      limit: { context: 262144, output: 256000 },
      cost: { input: 0.15, output: 0.6, cache_read: 0.015 },
    },
    {
      id: "codestral-2508",
      name: "Codestral",
      limit: { context: 256000, output: 4096 },
      cost: { input: 0.3, output: 0.9, cache_read: 0.03 },
    },
    {
      id: "magistral-medium-latest",
      name: "Magistral Medium",
      limit: { context: 128000, output: 16384 },
      cost: { input: 2, output: 5 },
    },
    { id: "ministral-8b-latest", name: "ministral-8b-latest" },
  ],
  openai: [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      limit: { context: 1050000, output: 128000 },
      cost: { input: 2, output: 10, cache_read: 0.1 },
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      limit: { context: 1050000, output: 128000 },
      cost: { input: 10, output: 50, cache_read: 1 },
    },
    {
      id: "gpt-5-mini",
      name: "GPT-5 mini",
      limit: { context: 400000, output: 128000 },
      cost: { input: 0.25, output: 2, cache_read: 0.025 },
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      limit: { context: 1000000, output: 128000 },
      cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    },
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      limit: { context: 1000000, output: 128000 },
      cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    },
    { id: "claude-haiku-5", name: "Claude Haiku 5" },
  ],
};
/** Mock provider rules: keys starting with "bad" are rejected, "missing-model" does not exist. */
async function checkMockConnection({ providerId, baseUrl, apiKey, modelId }) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (providerId === "opencode" || providerId === "custom") {
    if (modelId === "missing-model")
      return { status: 400, code: "ai_model_not_found", message: "The model does not exist" };
    return null;
  }
  const key = apiKey ?? (configuredKeys.has(keySlot({ providerId, baseUrl })) ? "saved" : "");
  if (!key) return { status: 400, code: "ai_key_missing", message: "Enter the provider's API key" };
  if (key.startsWith("bad"))
    return { status: 400, code: "ai_key_rejected", message: "The provider rejected the API key" };
  if (
    modelId !== undefined &&
    !MOCK_PROVIDER_MODELS[providerId]?.some((model) => model.id === modelId)
  )
    return {
      status: 400,
      code: "ai_model_not_found",
      message: `The provider has no model ${modelId}`,
    };
  return null;
}
/** Keys live in one slot per provider and endpoint, shared by chat and transcription. */
const configuredKeys = new Set();
const keySlot = (connection) => JSON.stringify([connection.providerId, connection.baseUrl]);
const voiceInputOn = () =>
  productSettings.transcription?.enabled === true &&
  configuredKeys.has(keySlot(productSettings.transcription));
const MOCK_TRANSCRIPT = "dictated words";
const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
/** What the page checks uploaded: `GET /api/baskule/__mock/transcriptions`. */
const transcriptionUploads = [];
/** Shape of platform/src/control/usage.ts: per-person limits, off by default. */
let usageLimits = { enabled: false, rules: [] };
const PORT = Number(process.env.MOCK_PORT ?? 47700);
const WEB_MODE = process.env.MOCK_WEB ?? "dist";
const VITE_PORT = Number(process.env.MOCK_VITE_PORT ?? 47701);
const T3_PORT_BASE = Number(process.env.MOCK_T3_PORT_BASE ?? 47710);
const OPENCODE_URL = process.env.MOCK_OPENCODE_URL ?? "http://127.0.0.1:47703";
const STATE_DIR = NodePath.resolve(
  process.env.MOCK_STATE_DIR ?? NodePath.join(REPO_ROOT, "../.run/wp-e"),
);
const BACKENDS = process.env.MOCK_BACKENDS ?? "t3";
const INJECT_AUTHOR = process.env.MOCK_INJECT_AUTHOR !== "0";
const DIST = NodePath.join(WEB_ROOT, "dist");
/** MOCK_CONTROL=http://127.0.0.1:47600 (platform/dev.sh): real auth and API, T3 spaces from here. */
const CONTROL = process.env.MOCK_CONTROL?.replace(/\/+$/, "") ?? "";

// data (shapes: platform/README.md)

const now = () => Date.now();
const ago = (minutes) => Date.now() - minutes * 60_000;

/** @type {Map<string, any>} */
const users = new Map();
/** @type {Map<string, any>} */
const spaces = new Map();
/** @type {Map<string, any>} token -> invitation */
const invitations = new Map();
const connectCodes = new Map();
/** @type {Map<string, string>} session token -> user id */
const sessions = new Map();

// Usage: deterministic figures per person and UTC day (shapes: contracts/src/baskule-usage.ts).
// Today's tokens are fixed so a page check can set a limit that Alice nears and Bob passes.
const DAY_MS = 86_400_000;
const TODAY_TOKENS = { "u-admin": 300_000, "u-alice": 1_700_000, "u-bob": 2_400_000 };
const PRICE_PER_MILLION = 2;
const utcDay = (time) => new Date(time).toISOString().slice(0, 10);
const todayStart = () => Math.floor(Date.now() / DAY_MS) * DAY_MS;
function dayUsage(userId, date) {
  const isToday = date === utcDay(Date.now());
  let hash = 0;
  for (const char of `${userId}:${date}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const tokens = isToday ? (TODAY_TOKENS[userId] ?? 100_000) : (hash % 9) * 150_000;
  return {
    tokens,
    costUsd: (tokens / 1e6) * PRICE_PER_MILLION,
    turns: Math.round(tokens / 60_000),
  };
}
function sumDays(userId, fromTime, toTime) {
  const total = { tokens: 0, costUsd: 0, turns: 0 };
  for (let time = fromTime; time <= toTime; time += DAY_MS) {
    const day = dayUsage(userId, utcDay(time));
    total.tokens += day.tokens;
    total.costUsd += day.costUsd;
    total.turns += day.turns;
  }
  return total;
}
function usageWindowBounds(window) {
  const start = todayStart();
  const date = new Date(start);
  if (window === "daily") return { start, end: start + DAY_MS };
  if (window === "weekly") {
    const monday = start - ((date.getUTCDay() + 6) % 7) * DAY_MS;
    return { start: monday, end: monday + 7 * DAY_MS };
  }
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return { start: first, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
function windowUsed(userId, window) {
  const { tokens, costUsd } = sumDays(userId, usageWindowBounds(window).start, todayStart());
  return { tokens, costUsd };
}
function myUsage(userId) {
  const today = todayStart();
  const limits = usageLimits.enabled
    ? usageLimits.rules.map(({ window, ...limit }) => {
        const used = windowUsed(userId, window);
        return {
          window,
          used,
          limit,
          resetsAt: new Date(usageWindowBounds(window).end).toISOString(),
          blocked:
            (limit.tokens !== undefined && used.tokens >= limit.tokens) ||
            (limit.costUsd !== undefined && used.costUsd >= limit.costUsd),
        };
      })
    : [];
  const daily = [];
  for (let index = 89; index >= 0; index -= 1) {
    const date = utcDay(today - index * DAY_MS);
    daily.push({ date, ...dayUsage(userId, date) });
  }
  const total = daily.reduce((sum, day) => sum + day.tokens, 0);
  return {
    limits,
    totals: {
      today: windowUsed(userId, "daily"),
      week: windowUsed(userId, "weekly"),
      month: windowUsed(userId, "monthly"),
    },
    daily,
    byModel: [
      {
        provider: "mistral",
        model: "mistral-large-4",
        tokens: Math.round(total * 0.8),
        costUsd: (total * 0.8 * PRICE_PER_MILLION) / 1e6,
      },
      {
        provider: "mistral",
        model: "mistral-small-2603",
        tokens: Math.round(total * 0.2),
        costUsd: (total * 0.2 * PRICE_PER_MILLION) / 1e6,
      },
    ],
  };
}
function adminUsage(fromParam, toParam) {
  const to = toParam ?? utcDay(Date.now());
  const from = fromParam ?? utcDay(todayStart() - 89 * DAY_MS);
  const [fromTime, toTime] = [Date.parse(from), Math.min(Date.parse(to), todayStart())];
  const people = [...users.values()].filter((user) => !user.banned);
  const byUser = people
    .map((user) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      ...sumDays(user.id, fromTime, toTime),
    }))
    .map((row) => ({ ...row, chats: Math.ceil(row.turns / 4) }));
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const totals = {
    tokens: sum(byUser, "tokens"),
    costUsd: sum(byUser, "costUsd"),
    turns: sum(byUser, "turns"),
    chats: sum(byUser, "chats"),
    activeUsers: byUser.filter((row) => row.tokens > 0).length,
  };
  const daily = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += DAY_MS) {
    const date = utcDay(time);
    const day = people.map((user) =>
      time > todayStart() ? { tokens: 0, costUsd: 0, turns: 0 } : dayUsage(user.id, date),
    );
    daily.push({
      date,
      tokens: sum(day, "tokens"),
      costUsd: sum(day, "costUsd"),
      turns: sum(day, "turns"),
    });
  }
  const share = (part) => ({
    tokens: Math.round(totals.tokens * part),
    costUsd: totals.costUsd * part,
    turns: Math.round(totals.turns * part),
    chats: Math.round(totals.chats * part),
  });
  const bySpace = spaces.values().map((space, index, all) => ({
    spaceId: space.id,
    name: space.name,
    ...share(1 / all.length),
  }));
  return {
    from,
    to,
    totals,
    byUser,
    byModel: [
      { provider: "mistral", model: "mistral-large-4", ...share(0.8) },
      { provider: "mistral", model: "mistral-small-2603", ...share(0.2) },
    ],
    bySpace,
    daily,
  };
}

function createPersonalSpace(userId) {
  const id = `p-${userId}-${NodeCrypto.randomBytes(2).toString("hex")}`;
  spaces.set(id, {
    id,
    name: "Personal",
    kind: "personal",
    personalUserId: userId,
    createdAt: now(),
    members: [{ userId, role: "owner" }],
    computer: "stopped",
  });
  return id;
}

function addUser({
  id,
  name,
  email,
  password,
  role = "member",
  banned = false,
  signedIn = true,
  personalId,
}) {
  users.set(id, {
    id,
    name,
    email,
    password,
    role,
    banned,
    createdAt: ago(60 * 24 * 7),
    firstSignInAt: signedIn ? ago(60 * 24 * 6) : null,
  });
  if (personalId) {
    spaces.set(personalId, {
      id: personalId,
      name: "Personal",
      kind: "personal",
      personalUserId: id,
      createdAt: ago(60 * 24 * 7),
      members: [{ userId: id, role: "owner" }],
      computer: "stopped",
    });
  } else createPersonalSpace(id);
}

addUser({
  id: "u-admin",
  name: "Ada Admin",
  email: "admin@baskule.test",
  password: "baskule-admin",
  role: "admin",
  personalId: "p-admin",
});
addUser({
  id: "u-alice",
  name: "Alice Martin",
  email: "alice@baskule.test",
  password: "baskule-alice",
  personalId: "p-alice",
});
addUser({
  id: "u-bob",
  name: "Bob Durand",
  email: "bob@baskule.test",
  password: "baskule-bob",
  personalId: "p-bob",
});
addUser({
  id: "u-carol",
  name: "Carol Petit",
  email: "carol@baskule.test",
  password: "temporary-1",
  signedIn: false,
  personalId: "p-carol",
});
addUser({
  id: "u-dave",
  name: "Dave Leroy",
  email: "dave@baskule.test",
  password: "baskule-dave",
  banned: true,
  personalId: "p-dave",
});

spaces.set("acme", {
  id: "acme",
  name: "Acme",
  kind: "team",
  createdAt: ago(60 * 24 * 3),
  computer: "running",
  members: [
    { userId: "u-alice", role: "owner" },
    { userId: "u-bob", role: "member" },
  ],
});
spaces.set("lab", {
  id: "lab",
  name: "Lab",
  kind: "team",
  createdAt: ago(60 * 24 * 2),
  computer: "stopped",
  members: [
    { userId: "u-admin", role: "owner" },
    { userId: "u-alice", role: "member" },
  ],
});
const DEMO_INVITE_TOKEN = "demo-invitation-token-0123456789";
invitations.set(DEMO_INVITE_TOKEN, {
  id: "inv-erin",
  email: "erin@baskule.test",
  role: "member",
  spaces: [{ spaceId: "acme", role: "member" }],
  createdAt: ago(60),
  expiresAt: Date.now() + 7 * 864e5,
  acceptedAt: null,
  revokedAt: null,
});

const memberRole = (space, userId) => space.members.find((m) => m.userId === userId)?.role ?? null;
const membersOf = (space) =>
  space.members.flatMap((m) => {
    const user = users.get(m.userId);
    return user ? [{ userId: user.id, name: user.name, email: user.email, role: m.role }] : [];
  });
const spacesOf = (userId) =>
  spaces
    .values()
    .filter((space) => memberRole(space, userId) !== null)
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1,
    )
    .map((space) => ({
      id: space.id,
      name: space.name,
      kind: space.kind,
      role: memberRole(space, userId),
      base: `/s/${space.id}`,
    }));
const pluginMock = createPluginMock({ users, spaces });
const canCreateSpaces = (user) => pluginMock.canCreateSpaces(user);
const activeSessions = (userId) =>
  [...sessions.values()].filter((owner) => owner === userId).length;
const wireUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  banned: user.banned,
  createdAt: user.createdAt,
  firstSignInAt: user.firstSignInAt,
  activeSessions: activeSessions(user.id),
});

// http helpers

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}
const fail = (res, status, code, message) =>
  send(res, status, { error: code, ...(message ? { message } : {}) });

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index < 0
        ? []
        : [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
    }),
  );
}
const SESSION_COOKIE = "baskule.session_token";
function currentUser(req) {
  const token = cookies(req)[SESSION_COOKIE];
  const userId = token ? sessions.get(token) : undefined;
  const user = userId ? users.get(userId) : undefined;
  return user && !user.banned ? user : null;
}
function startSession(user) {
  const token = NodeCrypto.randomBytes(24).toString("base64url");
  sessions.set(token, user.id);
  user.firstSignInAt ??= now();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}
function endSessionsOf(userId) {
  for (const [token, owner] of sessions) if (owner === userId) sessions.delete(token);
  for (const socket of liveSockets) if (socket.userId === userId) socket.destroy();
}

// API (in memory, like WP-C's ControlCell)

async function handleApi(req, res, url) {
  const method = req.method ?? "GET";
  const p = url.pathname;
  let r;

  if (p === "/auth/sign-in/email" && method === "POST") {
    const body = await readBody(req);
    const user = [...users.values()].find(
      (u) => u.email.toLowerCase() === String(body.email ?? "").toLowerCase(),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!user || user.password !== body.password)
      return send(res, 401, {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      });
    if (user.banned)
      return send(res, 403, {
        code: "BANNED_USER",
        message: "You have been banned from this application",
      });
    return send(
      res,
      200,
      { redirect: false, user: { id: user.id, email: user.email, name: user.name } },
      { "set-cookie": startSession(user) },
    );
  }
  // Connect codes (one-time sign-in of another device): issued for a session, redeemed once.
  if (p === "/auth/connect/code" && method === "POST") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { message: "Unauthorized" });
    const code = NodeCrypto.randomBytes(32).toString("base64url");
    connectCodes.set(code, user.id);
    return send(res, 200, { code, expiresAt: Date.now() + 600_000 });
  }
  if (p === "/auth/connect/redeem" && method === "POST") {
    const body = await readBody(req);
    const userId = connectCodes.get(String(body.code ?? ""));
    connectCodes.delete(String(body.code ?? ""));
    const user = userId ? users.get(userId) : undefined;
    if (!user)
      return send(res, 404, {
        message: "This connection link is not valid, has expired or was already used.",
      });
    return send(
      res,
      200,
      { user: { id: user.id, email: user.email, name: user.name } },
      { "set-cookie": startSession(user) },
    );
  }
  if (p === "/auth/sign-out" && method === "POST") {
    const token = cookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return send(
      res,
      200,
      { success: true },
      { "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` },
    );
  }
  if (p === "/auth/change-password" && method === "POST") {
    const me = currentUser(req);
    if (!me) return fail(res, 401, "unauthenticated");
    const body = await readBody(req);
    if (body.currentPassword !== me.password)
      return send(res, 400, { code: "INVALID_PASSWORD", message: "Invalid password" });
    me.password = String(body.newPassword);
    return send(res, 200, { token: null });
  }
  if (p === "/auth/reset-password" && method === "POST") {
    const body = await readBody(req);
    const userId = resetTokens.get(body.token);
    if (!userId) return send(res, 400, { code: "INVALID_TOKEN", message: "Invalid token" });
    resetTokens.delete(body.token);
    users.get(userId).password = String(body.newPassword);
    endSessionsOf(userId);
    return send(res, 200, { status: true });
  }
  if (p === "/api/baskule/downloads") {
    return send(res, 200, {
      files: [
        {
          name: "Baskule-0.2.0-x86_64.AppImage",
          size: 118_000_000,
          sha256: "0".repeat(64),
          modified: new Date().toISOString(),
          url: "/downloads/Baskule-0.2.0-x86_64.AppImage",
        },
        {
          name: "Baskule-0.2.0-linux-x64.tar.gz",
          size: 112_400_000,
          sha256: "1".repeat(64),
          modified: new Date().toISOString(),
          url: "/downloads/Baskule-0.2.0-linux-x64.tar.gz",
        },
      ],
    });
  }

  // Public invitations.
  if (p === "/api/baskule/invitations/lookup" && method === "POST") {
    const inv = validInvitation((await readBody(req)).token);
    if (!inv) return fail(res, 404, "invalid_invitation");
    return send(res, 200, {
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
      spaces: inv.spaces.map((x) => ({
        id: x.spaceId,
        role: x.role,
        name: spaces.get(x.spaceId)?.name ?? null,
      })),
    });
  }
  if (p === "/api/baskule/invitations/accept" && method === "POST") {
    const body = await readBody(req);
    const inv = validInvitation(body.token);
    if (!inv) return fail(res, 404, "invalid_invitation");
    if (!body.name || String(body.password ?? "").length < 8)
      return fail(res, 400, "invalid_password", "password: 8 to 256 characters");
    inv.acceptedAt = now();
    const id = `u-${NodeCrypto.randomBytes(4).toString("hex")}`;
    addUser({
      id,
      name: String(body.name),
      email: inv.email,
      password: String(body.password),
      role: inv.role,
      signedIn: false,
    });
    for (const x of inv.spaces) spaces.get(x.spaceId)?.members.push({ userId: id, role: x.role });
    return send(
      res,
      201,
      { user: { id, email: inv.email, name: body.name }, spaces: spacesOf(id) },
      { "set-cookie": startSession(users.get(id)) },
    );
  }

  const me = currentUser(req);
  if (!me) return fail(res, 401, "unauthenticated");
  const isAdmin = me.role === "admin";
  const api = p.slice("/api/baskule".length);
  if (await pluginMock.handle({ req, res, url, api, me, isAdmin, send, fail, readBody })) return;

  if (api === "/usage/me" && method === "GET") return send(res, 200, myUsage(me.id));
  if (api === "/admin/usage" && method === "GET") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    return send(res, 200, adminUsage(url.searchParams.get("from"), url.searchParams.get("to")));
  }
  if (api === "/admin/usage/limits") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    if (method === "PUT") usageLimits = await readBody(req);
    return send(res, 200, usageLimits);
  }
  if ((api === "/admin/ai/models" || api === "/admin/ai/verify") && method === "POST") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    const check = await readBody(req);
    if (api === "/admin/ai/verify" && !check.modelId) return fail(res, 400, "invalid_connection");
    const problem = await checkMockConnection(check);
    if (problem) return fail(res, problem.status, problem.code, problem.message);
    if (api === "/admin/ai/verify") return send(res, 200, { ok: true });
    return send(res, 200, { models: MOCK_PROVIDER_MODELS[check.providerId] ?? [] });
  }
  if (api === "/admin/settings") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    if (method === "PATCH") {
      const { apiKey, transcriptionApiKey, ...settings } = await readBody(req);
      const { cost: _cost, ...model } = settings.ai.model;
      const sameAI =
        JSON.stringify({ ...settings.ai, model }) ===
        JSON.stringify({
          ...productSettings.ai,
          model: { ...productSettings.ai.model, cost: undefined },
        });
      if (!sameAI || apiKey !== undefined) {
        const problem = await checkMockConnection({ ...settings.ai, apiKey, modelId: model.id });
        if (problem) return fail(res, problem.status, problem.code, problem.message);
      }
      // Built-in prices are the ControlCell's: the listed model's, or none.
      if (settings.ai.providerId !== "custom") {
        const cost = sameAI
          ? productSettings.ai.model.cost
          : MOCK_PROVIDER_MODELS[settings.ai.providerId]?.find((entry) => entry.id === model.id)
              ?.cost;
        settings.ai = { ...settings.ai, model: cost ? { ...model, cost } : model };
      }
      productSettings = settings;
      for (const [connection, key] of [
        [settings.ai, apiKey],
        [settings.transcription, transcriptionApiKey],
      ]) {
        if (key === undefined || !connection) continue;
        if (key) configuredKeys.add(keySlot(connection));
        else configuredKeys.delete(keySlot(connection));
      }
    }
    return send(res, 200, {
      ...productSettings,
      apiKeyConfigured: configuredKeys.has(keySlot(productSettings.ai)),
      transcriptionApiKeyConfigured: Boolean(
        productSettings.transcription && configuredKeys.has(keySlot(productSettings.transcription)),
      ),
      authentication: authConfig,
    });
  }
  if (api === "/transcriptions" && method === "POST") {
    if (!voiceInputOn()) return fail(res, 404, "voice_input_disabled");
    const type = String(req.headers["content-type"] ?? "");
    if (!type.split(";")[0].trim().startsWith("audio/")) return fail(res, 400, "invalid_audio");
    const audio = await readRaw(req);
    if (audio.length === 0) return fail(res, 400, "invalid_audio");
    if (audio.length > MAX_TRANSCRIPTION_BYTES) return fail(res, 413, "audio_too_large");
    transcriptionUploads.push({ type, bytes: audio.length });
    return send(res, 200, { text: MOCK_TRANSCRIPT });
  }
  if (api === "/__mock/transcriptions" && method === "GET") {
    return send(res, 200, { uploads: transcriptionUploads });
  }
  if (api === "/me") {
    return send(res, 200, {
      user: {
        id: me.id,
        name: me.name,
        email: me.email,
        role: me.role,
        canCreateSpaces: canCreateSpaces(me),
      },
      session: { id: "mock" },
      organization: { id: "org", name: productSettings.organizationName },
      authentication: authConfig,
      voiceInput: voiceInputOn(),
      spaces: spacesOf(me.id),
    });
  }
  if (api === "/people")
    return send(res, 200, {
      people: [...users.values()]
        .filter((u) => !u.banned)
        .map((u) => ({ id: u.id, name: u.name, email: u.email })),
    });
  if (api === "/spaces" && method === "GET") return send(res, 200, { spaces: spacesOf(me.id) });
  if (api === "/spaces" && method === "POST") {
    if (!canCreateSpaces(me)) return fail(res, 403, "forbidden", "not allowed to create spaces");
    const name = String((await readBody(req)).name ?? "").trim();
    if (!name) return fail(res, 400, "invalid_name");
    const id = `t-${NodeCrypto.randomBytes(4).toString("hex")}`;
    spaces.set(id, {
      id,
      name,
      kind: "team",
      createdAt: now(),
      computer: "stopped",
      members: [{ userId: me.id, role: "owner" }],
    });
    return send(res, 201, {
      space: { id, name, kind: "team", role: "owner", base: `/s/${id}` },
      members: membersOf(spaces.get(id)),
    });
  }
  if ((r = /^\/spaces\/([^/]+)(\/members(?:\/([^/]+))?)?$/.exec(api))) {
    const space = spaces.get(r[1]);
    const role = space ? memberRole(space, me.id) : null;
    if (
      !space ||
      (!role && !(isAdmin && space.kind === "team") && !(isAdmin && method === "DELETE" && !r[2]))
    )
      return fail(res, 404, "not_found");
    const manager = isAdmin || role === "owner";
    if (!r[2]) {
      if (method === "GET")
        return send(res, 200, {
          space: {
            id: space.id,
            name: space.name,
            kind: space.kind,
            role,
            base: `/s/${space.id}`,
            createdAt: space.createdAt,
          },
          members: membersOf(space),
        });
      if (method === "PATCH") {
        if (space.kind !== "team") return fail(res, 409, "personal_space");
        if (!manager) return fail(res, 403, "forbidden");
        space.name = String((await readBody(req)).name ?? space.name).trim() || space.name;
        return send(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        if (space.kind === "personal" ? !isAdmin : !manager) return fail(res, 403, "forbidden");
        spaces.delete(space.id);
        stopBackend(space.id);
        if (space.kind === "personal") createPersonalSpace(space.personalUserId);
        return send(res, 200, { ok: true });
      }
    }
    if (space.kind !== "team") return fail(res, 409, "personal_space");
    const owners = space.members.filter((m) => m.role === "owner").length;
    if (r[2] && !r[3] && method === "POST") {
      if (!manager) return fail(res, 403, "forbidden");
      const body = await readBody(req);
      if (!users.has(body.userId)) return fail(res, 404, "user_not_found");
      if (memberRole(space, body.userId)) return fail(res, 409, "already_member");
      space.members.push({ userId: body.userId, role: body.role === "owner" ? "owner" : "member" });
      return send(res, 201, { members: membersOf(space) });
    }
    const member = space.members.find((m) => m.userId === r[3]);
    if (!member) return fail(res, 404, "not_found");
    if (method === "PATCH") {
      if (!manager) return fail(res, 403, "forbidden");
      const next = (await readBody(req)).role === "owner" ? "owner" : "member";
      if (member.role === "owner" && next !== "owner" && owners <= 1)
        return fail(res, 409, "last_owner");
      member.role = next;
      return send(res, 200, { members: membersOf(space) });
    }
    if (method === "DELETE") {
      if (!manager && member.userId !== me.id) return fail(res, 403, "forbidden");
      if (member.role === "owner" && owners <= 1) return fail(res, 409, "last_owner");
      space.members = space.members.filter((m) => m !== member);
      for (const socket of liveSockets)
        if (socket.userId === member.userId && socket.spaceId === space.id) socket.destroy();
      return send(res, 200, { ok: true });
    }
  }

  if (api === "/invitations" && method === "POST") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    const body = await readBody(req);
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, "invalid_email");
    if ([...users.values()].some((u) => u.email === email))
      return fail(
        res,
        409,
        "user_exists",
        "this person already has an account: add them to spaces directly",
      );
    const token = NodeCrypto.randomBytes(24).toString("base64url");
    const inv = {
      id: `inv-${NodeCrypto.randomBytes(3).toString("hex")}`,
      email,
      role: body.role === "admin" ? "admin" : "member",
      spaces: body.spaces ?? [],
      createdAt: now(),
      expiresAt: Date.now() + 7 * 864e5,
      acceptedAt: null,
      revokedAt: null,
    };
    invitations.set(token, inv);
    return send(res, 201, {
      ...inv,
      token,
      url: `http://${req.headers.host}/invite#token=${token}`,
    });
  }
  if (api === "/invitations" && method === "GET") {
    if (!isAdmin) return fail(res, 403, "forbidden");
    return send(res, 200, { invitations: [...invitations.values()] });
  }
  if ((r = /^\/invitations\/([^/]+)$/.exec(api)) && method === "DELETE") {
    for (const inv of invitations.values())
      if (inv.id === r[1] && !inv.acceptedAt) inv.revokedAt = now();
    return send(res, 200, { ok: true });
  }

  if (api.startsWith("/admin/")) {
    if (!isAdmin) return fail(res, 403, "forbidden");
    const a = api.slice("/admin".length);
    if (a === "/users" && method === "GET")
      return send(res, 200, {
        users: [...users.values()].sort((x, y) => x.name.localeCompare(y.name)).map(wireUser),
      });
    if (a === "/users" && method === "POST") {
      const body = await readBody(req);
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      if ([...users.values()].some((u) => u.email === email)) return fail(res, 409, "user_exists");
      if (String(body.password ?? "").length < 8) return fail(res, 400, "invalid_password");
      const id = `u-${NodeCrypto.randomBytes(4).toString("hex")}`;
      addUser({
        id,
        name: String(body.name),
        email,
        password: String(body.password),
        role: body.role === "admin" ? "admin" : "member",
        signedIn: false,
      });
      return send(res, 201, { user: wireUser(users.get(id)) });
    }
    if ((r = /^\/users\/([^/]+)(?:\/([a-z-]+))?$/.exec(a))) {
      const user = users.get(r[1]);
      if (!user) return fail(res, 404, "not_found");
      const admins = [...users.values()].filter((u) => u.role === "admin" && !u.banned).length;
      switch (`${method} ${r[2] ?? ""}`) {
        case "PATCH ": {
          const body = await readBody(req);
          if (body.role && body.role !== "admin" && user.role === "admin" && admins <= 1)
            return fail(res, 409, "last_admin", "keep at least one admin");
          if (body.role) user.role = body.role === "admin" ? "admin" : "member";
          return send(res, 200, { user: wireUser(user) });
        }
        case "DELETE ":
          if (user.id === me.id) return fail(res, 409, "self");
          endSessionsOf(user.id);
          users.delete(user.id);
          for (const space of spaces.values()) {
            if (space.personalUserId === user.id) spaces.delete(space.id);
            else space.members = space.members.filter((m) => m.userId !== user.id);
          }
          return send(res, 200, { ok: true });
        case "POST deactivate":
          if (user.id === me.id) return fail(res, 409, "self");
          user.banned = true;
          endSessionsOf(user.id);
          return send(res, 200, { ok: true });
        case "POST activate":
          user.banned = false;
          return send(res, 200, { ok: true });
        case "POST sign-out-everywhere":
          endSessionsOf(user.id);
          return send(res, 200, { ok: true });
        case "POST password": {
          if (user.firstSignInAt) return fail(res, 409, "already_signed_in");
          user.password = String((await readBody(req)).password ?? "");
          return send(res, 200, { ok: true });
        }
        case "POST reset-link": {
          const token = NodeCrypto.randomBytes(24).toString("base64url");
          resetTokens.set(token, user.id);
          return send(res, 201, {
            token,
            expiresAt: Date.now() + 3600_000,
            url: `http://${req.headers.host}/reset-password#token=${token}`,
          });
        }
      }
    }
    if (a.startsWith("/spaces")) {
      const live = url.searchParams.get("status") === "live";
      if (a === "/spaces" && method === "GET") {
        return send(res, 200, {
          spaces: spaces.values().map((space) => ({
            id: space.id,
            name: space.name,
            kind: space.kind,
            createdAt: space.createdAt,
            memberCount: space.members.length,
            owner:
              space.kind === "personal"
                ? {
                    userId: space.personalUserId,
                    name: users.get(space.personalUserId)?.name ?? null,
                    email: users.get(space.personalUserId)?.email ?? null,
                  }
                : undefined,
            members: space.kind === "team" ? membersOf(space) : undefined,
            status: live || backends.has(space.id) ? statusOf(space) : null,
            checkedAt: now(),
          })),
        });
      }
      if ((r = /^\/spaces\/([^/]+)\/stop$/.exec(a)) && method === "POST") {
        const space = spaces.get(r[1]);
        if (!space) return fail(res, 404, "not_found");
        space.computer = "stopped";
        stopBackend(space.id);
        return send(res, 200, { ok: true, status: statusOf(space) });
      }
    }
  }
  return fail(res, 404, "not_found");
}

/** @type {Map<string, string>} reset token -> user id */
const resetTokens = new Map();

function validInvitation(token) {
  const inv = typeof token === "string" ? invitations.get(token) : undefined;
  return inv && !inv.acceptedAt && !inv.revokedAt && inv.expiresAt > Date.now() ? inv : undefined;
}

function statusOf(space) {
  const backend = backends.get(space.id);
  return {
    awake: backend?.state === "ready",
    sockets: [...liveSockets].filter((socket) => socket.spaceId === space.id).length,
    activeRuns: 0,
    computer: space.computer,
  };
}

// space backends (T3 servers)

/** @type {Map<string, {port: number, state: "starting"|"ready"|"failed", ready: Promise<void>, child?: any}>} */
const backends = new Map();
let nextPort = T3_PORT_BASE;
const T3_SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = NodeHttp.get(
        { host: "127.0.0.1", port, path: "/.well-known/t3/environment", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () =>
      Date.now() > deadline ? reject(new Error("backend did not start")) : setTimeout(attempt, 500);
    attempt();
  });
}

function ensureBackend(spaceId) {
  const existing = backends.get(spaceId);
  if (existing) return existing;
  const port = nextPort++;
  const base = NodePath.join(STATE_DIR, "spaces", spaceId);
  NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(base, "cwd"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        opencode: {
          driver: "opencode",
          enabled: true,
          config: { serverUrl: OPENCODE_URL, serverPassword: "baskule-mock" },
        },
      },
      defaultModelSelection: { instanceId: "opencode", model: "llm/m" },
      textGenerationModelSelection: { instanceId: "opencode", model: "llm/m" },
    }),
  );
  const log = NodeFS.openSync(NodePath.join(base, "server.log"), "a");
  const child = NodeChildProcess.spawn(
    "nice",
    [
      "-n",
      "10",
      process.execPath,
      T3_SERVER_ENTRY,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      base,
      "--no-browser",
    ],
    {
      cwd: NodePath.join(base, "cwd"),
      env: {
        ...process.env,
        BASKULE: "1",
        BASKULE_AUTH_MODE: "none",
        T3CODE_TELEMETRY_ENABLED: "false",
        GIT_CEILING_DIRECTORIES: STATE_DIR,
        HOME: NodePath.join(base, "home"),
      },
      stdio: ["ignore", log, log],
    },
  );
  const entry = { port, state: "starting", child, ready: Promise.resolve() };
  entry.ready = waitForPort(port, 90_000).then(
    () => {
      entry.state = "ready";
      console.log(`[mock] space ${spaceId} awake on ${port}`);
    },
    (error) => {
      entry.state = "failed";
      console.error(`[mock] space ${spaceId} failed: ${error.message} (see ${base}/server.log)`);
      throw error;
    },
  );
  child.on("exit", (code) => {
    console.log(`[mock] space ${spaceId} backend exited (${code})`);
    if (backends.get(spaceId) === entry) backends.delete(spaceId);
  });
  backends.set(spaceId, entry);
  return entry;
}

function stopBackend(spaceId) {
  const entry = backends.get(spaceId);
  if (entry?.child && !entry.child.killed) entry.child.kill("SIGTERM");
  backends.delete(spaceId);
}

/** Resolves the space of a `/s/<id>/...` request after the front's checks; null = answered. */
/** MOCK_CONTROL mode: who is calling, and their spaces, according to the real ControlCell. */
async function callerFromControl(req) {
  const response = await fetch(`${CONTROL}/api/baskule/me`, {
    headers: { cookie: req.headers.cookie ?? "", host: req.headers.host ?? "" },
  }).catch(() => null);
  if (!response?.ok) return null;
  const me = await response.json();
  return {
    user: { ...me.user },
    spaces: me.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      kind: space.kind,
      members: [{ userId: me.user.id, role: space.role }],
    })),
  };
}

async function authorizeSpaceRequest(req, res, url) {
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const spaceId = decodeURIComponent(match[1]);
  const rest = match[2] ?? "/";
  if (rest.startsWith("/_baskule/")) {
    fail(res, 404, "not_found");
    return null;
  }
  const caller = CONTROL ? await callerFromControl(req) : null;
  const user = CONTROL ? caller?.user : currentUser(req);
  if (!user) {
    fail(res, 401, "unauthenticated");
    return null;
  }
  const space = CONTROL ? caller.spaces.find((entry) => entry.id === spaceId) : spaces.get(spaceId);
  if (!space || memberRole(space, user.id) === null) {
    fail(res, 404, "not_found");
    return null;
  }
  return { space, user, rest: `${rest}${url.search}` };
}

function proxyHeaders(req, port, user, space) {
  const headers = { ...req.headers };
  // As the Worker does: drop any inbound identity, then state the caller.
  for (const key of Object.keys(headers)) if (key.startsWith("x-baskule-")) delete headers[key];
  headers.host = `127.0.0.1:${port}`;
  if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
  delete headers.cookie;
  delete headers["accept-encoding"];
  headers["x-baskule-identity"] = Buffer.from(
    JSON.stringify({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sessionId: "mock",
      spaceRole: memberRole(space, user.id),
    }),
  ).toString("base64url");
  headers["x-baskule-base"] = `/s/${space.id}`;
  return headers;
}

async function proxySpaceHttp(req, res, url) {
  const target = await authorizeSpaceRequest(req, res, url);
  if (!target) return;
  if (BACKENDS === "none")
    return fail(res, 503, "space_unavailable", "space backends are off (MOCK_BACKENDS=none)");
  const backend = ensureBackend(target.space.id);
  try {
    await backend.ready;
  } catch {
    return fail(res, 503, "space_unavailable", "the space did not start");
  }
  const upstream = NodeHttp.request(
    {
      host: "127.0.0.1",
      port: backend.port,
      method: req.method,
      path: target.rest,
      headers: proxyHeaders(req, backend.port, target.user, target.space),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      delete headers["set-cookie"];
      const stamp =
        INJECT_AUTHOR &&
        target.space.kind === "team" &&
        target.rest.startsWith("/api/orchestration/") &&
        String(headers["content-type"] ?? "").includes("json") &&
        !headers["content-encoding"];
      if (!stamp) {
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        return void upstreamRes.pipe(res);
      }
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = stampAuthors(Buffer.concat(chunks).toString("utf8"), target.space);
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode ?? 502, {
          ...headers,
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      });
    },
  );
  upstream.on("error", () => fail(res, 502, "space_unavailable", "the space did not answer"));
  req.pipe(upstream);
}

// WebSocket proxy

/** @type {Set<NodeNet.Socket & {userId?: string, spaceId?: string}>} */
const liveSockets = new Set();

/** Server-to-client frames, parsed only to stamp `author` (MOCK_INJECT_AUTHOR). */
function createFrameRewriter(rewrite) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const out = [];
    for (;;) {
      if (buffer.length < 2) break;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) break;
      const payload = buffer.subarray(offset, offset + length);
      const frame = buffer.subarray(0, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1 || (opcode === 0 && fragments.length > 0)) {
        fragments.push(Buffer.from(payload));
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        out.push(encodeTextFrame(rewrite(text)));
      } else {
        out.push(Buffer.from(frame));
      }
    }
    return Buffer.concat(out);
  };
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(payload.length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

/**
 * Stands in for WP-B's server-side authorship: user-created messages and turn items get the
 * author of their space (a fixed cast, so shared chats show several names).
 */
const AUTHOR_CAST = [
  { id: "u-alice", name: "Alice Martin" },
  { id: "u-bob", name: "Bob Durand" },
];
/** Messages alternate between the cast in the order the mock first sees them. */
const assignedAuthors = new Map();
const authorFor = (messageId) => {
  const key = String(messageId);
  if (!assignedAuthors.has(key)) {
    assignedAuthors.set(key, AUTHOR_CAST[assignedAuthors.size % AUTHOR_CAST.length]);
  }
  return assignedAuthors.get(key);
};
function stampAuthors(text, space) {
  if (space.kind !== "team" || !text.includes('"creationSource"')) return text;
  try {
    const value = JSON.parse(text);
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (
        (node.role === "user" || node.kind === "user_message" || node.type === "user_message") &&
        "creationSource" in node &&
        !node.author
      ) {
        node.author = authorFor(node.messageId ?? node.id ?? "");
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(value);
    return JSON.stringify(value);
  } catch {
    return text;
  }
}

async function proxySpaceUpgrade(req, socket, head, url) {
  const fakeRes = {
    writeHead(status) {
      socket.write(
        `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return this;
    },
    end() {},
  };
  const target = await authorizeSpaceRequest(req, fakeRes, url);
  if (!target || BACKENDS === "none") {
    if (target) fakeRes.writeHead(503);
    return;
  }
  const backend = ensureBackend(target.space.id);
  try {
    await backend.ready;
  } catch {
    return fakeRes.writeHead(503);
  }
  const headers = proxyHeaders(req, backend.port, target.user, target.space);
  // No permessage-deflate, so frames can be read for the author stand-in.
  delete headers["sec-websocket-extensions"];
  const upstream = NodeNet.connect(backend.port, "127.0.0.1", () => {
    const lines = [
      `GET ${target.rest} HTTP/1.1`,
      ...Object.entries(headers).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`),
      ),
    ];
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    let handshakeDone = false;
    let pending = Buffer.alloc(0);
    const rewrite = INJECT_AUTHOR
      ? createFrameRewriter((text) => stampAuthors(text, target.space))
      : (chunk) => chunk;
    upstream.on("data", (chunk) => {
      if (handshakeDone) return void socket.write(rewrite(chunk));
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.write(pending.subarray(0, end + 4));
      handshakeDone = true;
      const restBytes = pending.subarray(end + 4);
      if (restBytes.length) socket.write(rewrite(restBytes));
    });
    socket.pipe(upstream);
  });
  Object.assign(socket, { userId: target.user.id, spaceId: target.space.id });
  liveSockets.add(socket);
  const close = () => {
    liveSockets.delete(socket);
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
}

// web app

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function serveDist(req, res, url) {
  let file = NodePath.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) return fail(res, 404, "not_found");
  if (!NodeFS.existsSync(file) || NodeFS.statSync(file).isDirectory())
    file = NodePath.join(DIST, "index.html");
  if (!NodeFS.existsSync(file))
    return fail(res, 500, "no_build", `no web build in ${DIST}: build it or use MOCK_WEB=dev`);
  res.writeHead(200, {
    "content-type": MIME[NodePath.extname(file)] ?? "application/octet-stream",
  });
  NodeFS.createReadStream(file).pipe(res);
}

function proxyVite(req, res) {
  const upstream = NodeHttp.request(
    { host: "127.0.0.1", port: VITE_PORT, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  upstream.on("error", () =>
    fail(res, 502, "no_vite", `Vite dev server not running on ${VITE_PORT}`),
  );
  req.pipe(upstream);
}

// server

export const server = NodeHttp.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (
    CONTROL &&
    (url.pathname.startsWith("/auth/") ||
      url.pathname.startsWith("/api/baskule/") ||
      url.pathname.startsWith("/downloads"))
  ) {
    const target = new URL(CONTROL);
    const upstream = NodeHttp.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => fail(res, 502, "no_control", `platform not running at ${CONTROL}`));
    return void req.pipe(upstream);
  }
  if (url.pathname === "/.well-known/baskule") {
    return send(res, 200, {
      product: "baskule",
      name: "Baskule (mock)",
      authentication: authConfig,
    });
  }
  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/baskule/")) {
    void handleApi(req, res, url).catch((error) => fail(res, 500, "internal_error", error.message));
    return;
  }
  if (url.pathname.startsWith("/s/")) return void proxySpaceHttp(req, res, url);
  if (url.pathname === "/downloads/") {
    // Like the Worker: the folder itself is a listing page, its files are attachments.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><title>Downloads</title><h1>Downloads</h1>");
  }
  if (url.pathname.startsWith("/downloads/")) {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${NodePath.basename(url.pathname)}"`,
    });
    return res.end("mock app file\n");
  }
  if (WEB_MODE === "dev") return proxyVite(req, res);
  return serveDist(req, res, url);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/s/")) return void proxySpaceUpgrade(req, socket, head, url);
  if (WEB_MODE === "dev") {
    // Vite HMR.
    const upstream = NodeNet.connect(VITE_PORT, "127.0.0.1", () => {
      const lines = [
        `GET ${req.url} HTTP/1.1`,
        ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`),
      ];
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    return;
  }
  socket.destroy();
});

const shutdown = () => {
  for (const id of backends.keys()) stopBackend(id);
  server.close();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, process.env.MOCK_HOST ?? "127.0.0.1", () => {
  console.log(
    `[mock] Baskule mock front on http://127.0.0.1:${server.address().port} (web: ${WEB_MODE}, backends: ${BACKENDS})`,
  );
  console.log(
    `[mock] accounts: admin@baskule.test / baskule-admin, alice@baskule.test / baskule-alice, bob@baskule.test / baskule-bob; invitation /invite#token=${DEMO_INVITE_TOKEN}`,
  );
});
