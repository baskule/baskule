// Live-suite helper: invoked only by the explicitly authorized live runners. No deployment or secret export.
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(readFileSync(`${root}/deploy/v2/.env`, "utf8").split("\n").flatMap(line => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line); return match ? [[match[1], match[2]]] : [];
}));
const base = process.env.E2E_BASE_URL ?? `http://${env.BASKULE02_BIND || "127.0.0.1"}:${env.BASKULE02_PORT || "47090"}`;
const backup = `${root}/.run/e2e-product-settings.json`;
const headers = { "content-type": "application/json", origin: base };
const config = (await (await fetch(`${base}/.well-known/baskule`)).json()).authentication;
if (config.mode !== "anonymous") {
  const login = await fetch(`${base}/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD || env.ADMIN_PASSWORD }) });
  const token = login.headers.get("set-auth-token");
  if (!login.ok || !token) throw new Error("Live-suite settings require administrator credentials (E2E_ADMIN_PASSWORD)");
  headers.authorization = `Bearer ${token}`;
}
const currentResponse = await fetch(`${base}/api/baskule/admin/settings`, { headers });
if (!currentResponse.ok) throw new Error(`Read product settings: HTTP ${currentResponse.status}`);
const { apiKeyConfigured: _apiKeyConfigured, transcriptionApiKeyConfigured: _transcriptionApiKeyConfigured, authentication: _authentication, ...current } = await currentResponse.json();
const [action, endpoint, idle] = process.argv.slice(2);
if (action === "status") { console.log(current.ai.baseUrl); process.exit(0); }
let settings;
if (action === "restore") {
  if (!existsSync(backup)) process.exit(0);
  settings = JSON.parse(readFileSync(backup, "utf8"));
} else if (["router", "idle"].includes(action)) {
  mkdirSync(`${root}/.run`, { recursive: true });
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(current), { mode: 0o600 });
  if (action === "router" && process.env.E2E_REAL === "1" && !process.env.E2E_REAL_API_KEY)
    throw new Error("Real router checks require a privately supplied E2E_REAL_API_KEY");
  settings = { ...current,
    ...(action === "router" ? {
      ai: { ...current.ai, providerId: "custom", baseUrl: endpoint },
      apiKey: process.env.E2E_REAL === "1" ? process.env.E2E_REAL_API_KEY : "",
    } : {}),
    idleMinutes: Number(action === "idle" ? endpoint : idle || "1.5"),
  };
} else throw new Error("Expected router, restore or status");
const saved = await fetch(`${base}/api/baskule/admin/settings`, { method: "PATCH", headers, body: JSON.stringify(settings) });
if (!saved.ok) throw new Error(`Save product settings: HTTP ${saved.status}`);
if (action === "restore") unlinkSync(backup);
