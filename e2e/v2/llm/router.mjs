#!/usr/bin/env node
// e2e LLM router (runs as container baskule02-e2e-llm on baskule02-net, DNS name baskule-e2e-llm:47098).
// The organization AI endpoint is set to http://baskule-e2e-llm:47098/v1 during an e2e run.
//
//  - Default: every chat completion goes to the fake LLM (platform/dev/fake-llm, started here on 127.0.0.1:47099).
//  - A request whose LAST user message contains "[[real]]" goes to the real provider (REAL_BASE_URL, default
//    https://api.mistral.ai/v1) with the caller's own Authorization header (the key the cell got from ControlCell;
//    the router never stores it), the marker stripped, and stream usage requested. Usage is metered per request in
//    /data/usage.jsonl and served at GET /_router/usage, so every real-model run is logged exactly.
//  - A budget guard: when the metered upper-bound cost reaches REAL_BUDGET_USD, real requests answer 429.
//  - /_fake/* is proxied to the fake (request capture, reset). GET /health.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.ROUTER_PORT ?? 47098);
const FAKE_PORT = 47099;
const REAL_BASE = new URL(process.env.REAL_BASE_URL ?? "https://api.mistral.ai/v1");
const BUDGET = Number(process.env.REAL_BUDGET_USD ?? 0.5);
// mistral-large-4 list prices used for the ledger's upper bound (all input billed at the input price).
const PRICE_IN = Number(process.env.PRICE_IN ?? 1.36) / 1e6;
const PRICE_OUT = Number(process.env.PRICE_OUT ?? 4.18) / 1e6;
const DATA = process.env.ROUTER_DATA ?? "/data";
mkdirSync(DATA, { recursive: true });
const USAGE = `${DATA}/usage.jsonl`;
const MARK = "[[real]]";
const TITLE_PROMPT = "Generate a title that will help";

const fake = spawn(process.execPath, [process.env.FAKE_LLM ?? "/fake/server.mjs", "--port", String(FAKE_PORT), "--host", "127.0.0.1"], {
  stdio: "inherit",
});
fake.on("exit", (c) => { console.error(`fake LLM exited ${c}`); process.exit(1); });

function usageTotals() {
  const t = { requests: 0, input: 0, cached: 0, output: 0, upperBoundUsd: 0 };
  if (!existsSync(USAGE)) return t;
  for (const line of readFileSync(USAGE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const u = JSON.parse(line);
    t.requests++; t.input += u.input; t.cached += u.cached; t.output += u.output;
  }
  t.upperBoundUsd = t.input * PRICE_IN + t.output * PRICE_OUT;
  return t;
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text : "")).join("") : "");
function lastUser(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return msgs[i];
  return null;
}
function stripMarker(msg) {
  if (typeof msg.content === "string") msg.content = msg.content.replaceAll(MARK, "").trim();
  else if (Array.isArray(msg.content)) for (const p of msg.content) if (p?.type === "text") p.text = p.text.replaceAll(MARK, "").trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
  });
}

function pipeTo(req, res, raw, target, headers, onData) {
  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(target, { method: req.method, headers }, (r) => {
    const h = { ...r.headers };
    res.writeHead(r.statusCode ?? 502, h);
    r.on("data", (d) => { onData?.(d); res.write(d); });
    r.on("end", () => res.end());
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `router upstream error: ${e.message}` } }));
  });
  up.end(raw);
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") return res.end("ok");
      if (url.pathname === "/_router/usage") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ...usageTotals(), budgetUsd: BUDGET }));
      }
      const raw = await readBody(req);
      let body = null;
      if (raw.length && (req.headers["content-type"] ?? "").includes("json")) {
        try { body = JSON.parse(raw.toString("utf8")); } catch {}
      }
      const msg = url.pathname.endsWith("/chat/completions") && body ? lastUser(body) : null;
      // T3's chat-title generation (one per turn, through OpenCode, with tools): always answered by the fake with a
      // title from the user's message, so markers in that message neither run tools twice nor spend real tokens.
      if (msg && textOf(msg.content).startsWith(TITLE_PROMPT)) {
        const user = textOf(msg.content).split("User message:\n").pop() ?? "";
        const title = user.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 38) || "E2E chat";
        const out = Buffer.from(JSON.stringify({ ...body, tools: undefined, tool_choice: undefined,
          messages: [{ role: "user", content: `[[fake:text ${JSON.stringify({ title, needsRefinement: false })}]]` }] }));
        const headers = { "content-type": "application/json", "content-length": out.length };
        return pipeTo(req, res, out, new URL(`http://127.0.0.1:${FAKE_PORT}${url.pathname}`), headers);
      }
      if (msg && textOf(msg.content).includes(MARK)) {
        if (usageTotals().upperBoundUsd >= BUDGET) {
          res.writeHead(429, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: `e2e real-model budget of $${BUDGET} reached`, type: "budget" } }));
        }
        // Real model: strip the marker from every user message (history repeats it), meter usage.
        for (const m of body.messages) if (m?.role === "user") stripMarker(m);
        if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
        const out = Buffer.from(JSON.stringify(body));
        const target = new URL(REAL_BASE.pathname.replace(/\/$/, "") + url.pathname.replace(/^\/v1/, "") + url.search, REAL_BASE);
        let tail = "";
        let usage = null;
        const record = () => {
          if (usage) {
            appendFileSync(USAGE, JSON.stringify({ at: new Date().toISOString(), model: body.model,
              input: usage.prompt_tokens ?? 0, cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
              output: usage.completion_tokens ?? 0 }) + "\n");
            usage = null;
          }
        };
        res.on("finish", record);
        res.on("close", record);
        return pipeTo(req, res, out, target,
          { "content-type": "application/json", "content-length": out.length, authorization: req.headers.authorization ?? "",
            accept: req.headers.accept ?? "*/*" },
          (d) => {
            tail = (tail + d.toString("utf8")).slice(-65536);
            // SSE: the usage chunk comes last; non-stream: the body has `usage`.
            for (const m of tail.matchAll(/"usage"\s*:\s*(\{[^{}]*(\{[^{}]*\}[^{}]*)*\})/g)) {
              try { const u = JSON.parse(m[1]); if (u && typeof u.prompt_tokens === "number") usage = u; } catch {}
            }
          });
      }
      // Fake (default).
      const target = new URL(`http://127.0.0.1:${FAKE_PORT}${url.pathname}${url.search}`);
      const headers = { ...req.headers, host: `127.0.0.1:${FAKE_PORT}`, "content-length": raw.length };
      delete headers.authorization;
      return pipeTo(req, res, raw, target, headers);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  })
  .listen(PORT, "0.0.0.0", () => console.error(`e2e LLM router on :${PORT} (fake on :${FAKE_PORT}, real ${REAL_BASE.origin}, budget $${BUDGET})`));
