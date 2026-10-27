#!/usr/bin/env node
// Baskule fake LLM: a deterministic OpenAI-compatible chat-completions mock (no dependencies, Node >= 20).
//
//   node dev/fake-llm/server.mjs [--port 47601] [--host 127.0.0.1]     (env: FAKE_LLM_PORT, FAKE_LLM_HOST, FAKE_LLM_KEY)
//
// Endpoints: POST /v1/chat/completions (stream or not), GET /v1/models, GET /_fake/requests (last 50 request bodies),
// POST /_fake/reset, GET /health. The `/v1` prefix is optional.
//
// T3 title-generation prompts receive valid title/needsRefinement JSON independently of nested chat markers.
// Behaviour is chosen by markers in the LAST user message (falls back to the system prompt):
//   (none)                         → "Fake answer: <first 80 chars of the user text>" (+ an attachment summary)
//   [[fake:text <text>]]           → replies <text> exactly
//   [[fake:long <n>]]              → replies n deterministic words ("word1 word2 …")
//   [[fake:tool <name> <json>]]    → a tool call to <name> with <json> arguments. Repeat the marker for a sequence:
//                                    step k (= number of tool results after the last user message) uses marker k;
//                                    <name> "*suffix" = the offered tool whose name ends with suffix (MCP prefixes);
//                                    after the last one it answers "Done: <name>=<first 200 chars of result> …".
//   [[fake:reasoning <text>]]      → also streams <text> as `reasoning_content` before the answer
//   [[fake:delay <ms>]]            → waits <ms> between streamed chunks (default 5)
//   [[fake:error <status>]]        → answers HTTP <status> with an OpenAI-style error body
//   [[fake:describe]]              → replies only with the attachment summary
//   <<fake:…>>                     → same markers, used only when the message has no [[fake:…]] marker (a prompt
//                                    nested in another marker's JSON, e.g. a delegated child task)
// Attachments: `image_url` parts (data: or http URLs), `file` / `input_file` parts (OpenAI `file.file_data` data URLs),
// `input_audio` are accepted and summarised as "[attachments: image/png x1, application/pdf x1]".
// Deterministic: ids derive from a counter; `created` is fixed; no randomness.
import http from "node:http";

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(arg("port", process.env.FAKE_LLM_PORT ?? 47601));
const HOST = arg("host", process.env.FAKE_LLM_HOST ?? "127.0.0.1");
const KEY = process.env.FAKE_LLM_KEY ?? ""; // when set, require `Authorization: Bearer <KEY>`
const CREATED = 1767225600; // fixed timestamp (2026-01-01)
const MODELS = ["fake-model", "mistral-large-4"];

let counter = 0;
const recent = [];

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text" || p?.type === "input_text").map((p) => p.text ?? "").join("\n");
  return "";
}

function mimeOfDataUrl(u) {
  const m = /^data:([^;,]+)[;,]/.exec(u ?? "");
  return m ? m[1] : null;
}

function attachmentsOf(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (p?.type === "image_url") {
      const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      out.push(mimeOfDataUrl(u) ?? "image/*");
    } else if (p?.type === "file" || p?.type === "input_file") {
      const f = p.file ?? p;
      out.push(mimeOfDataUrl(f.file_data) ?? (f.filename?.endsWith(".pdf") ? "application/pdf" : "application/octet-stream"));
    } else if (p?.type === "input_audio") out.push(`audio/${p.input_audio?.format ?? "*"}`);
  }
  return out;
}

function summary(list) {
  if (!list.length) return "";
  const counts = new Map();
  for (const m of list) counts.set(m, (counts.get(m) ?? 0) + 1);
  return `[attachments: ${[...counts].map(([m, n]) => `${m} x${n}`).join(", ")}]`;
}

function parseMarkers(text) {
  const markers = [];
  const re = /\[\[fake:(\w+)(?:\s+([\s\S]*?))?\]\]/g;
  let m;
  while ((m = re.exec(text))) markers.push({ kind: m[1], arg: (m[2] ?? "").trim() });
  if (markers.length) return markers;
  // Nested form for prompts carried inside another marker's JSON (e.g. a delegated task's prompt).
  const nested = /<<fake:(\w+)(?:\s+([\s\S]*?))?>>/g;
  while ((m = nested.exec(text))) markers.push({ kind: m[1], arg: (m[2] ?? "").trim() });
  return markers;
}

/** Decide the scripted response for a request body. Pure and deterministic (exported for tests). */
export function plan(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { lastUser = i; break; }
  const user = lastUser >= 0 ? messages[lastUser] : null;
  const userText = textOf(user?.content);
  const system = messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => textOf(m.content)).join("\n");
  if (userText.includes("Return JSON with keys title and needsRefinement")) {
    return { text: JSON.stringify({ title: "Fake chat title", needsRefinement: false }), delay: 5, reasoning: "" };
  }
  let markers = parseMarkers(userText);
  if (!markers.length) markers = parseMarkers(system);
  const after = lastUser >= 0 ? messages.slice(lastUser + 1) : [];
  const toolResults = after.filter((m) => m?.role === "tool");
  const atts = messages.flatMap((m) => (m?.role === "user" ? attachmentsOf(m.content) : []));
  const attSummary = summary(atts);
  const delay = Number(markers.find((m) => m.kind === "delay")?.arg ?? 5);
  const reasoning = markers.find((m) => m.kind === "reasoning")?.arg ?? "";

  const err = markers.find((m) => m.kind === "error");
  if (err) return { error: Number(err.arg) || 500, delay };

  const tools = markers.filter((m) => m.kind === "tool").map((m) => {
    const sp = m.arg.search(/\s/);
    const name = sp < 0 ? m.arg : m.arg.slice(0, sp);
    const json = sp < 0 ? "{}" : m.arg.slice(sp + 1).trim() || "{}";
    // "*suffix": the offered tool whose name ends with suffix (MCP tools carry a per-thread server prefix).
    const offered = (Array.isArray(body?.tools) ? body.tools : []).map((t) => t?.function?.name).filter(Boolean);
    const resolved = name.startsWith("*") ? offered.find((n) => n.endsWith(name.slice(1))) ?? name.slice(1) : name;
    return { name: resolved, arguments: json };
  });
  if (tools.length) {
    const step = toolResults.length;
    if (step < tools.length) return { toolCall: tools[step], step, delay, reasoning };
    const results = toolResults.map((t, i) => `${tools[i]?.name ?? "tool"}=${textOf(t.content).slice(0, 200)}`);
    return { text: `Done: ${results.join(" | ")}`, delay, reasoning };
  }
  const t = markers.find((m) => m.kind === "text");
  if (t) return { text: t.arg, delay, reasoning };
  const long = markers.find((m) => m.kind === "long");
  if (long) {
    const n = Math.max(1, Math.min(100000, Number(long.arg) || 50));
    return { text: Array.from({ length: n }, (_, i) => `word${i + 1}`).join(" "), delay, reasoning };
  }
  if (markers.some((m) => m.kind === "describe")) return { text: attSummary || "[attachments: none]", delay, reasoning };
  const base = `Fake answer: ${userText.replace(/\s+/g, " ").trim().slice(0, 80)}`;
  return { text: attSummary ? `${base} ${attSummary}` : base, delay, reasoning };
}

function chunksOf(text) {
  // Split into word-ish chunks that keep whitespace, so the concatenation equals the text exactly.
  return text.match(/\s*\S+|\s+$/g) ?? [""];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(body, outText) {
  const prompt = JSON.stringify(body?.messages ?? []).length;
  const completion = (outText ?? "").length;
  const p = Math.ceil(prompt / 4), c = Math.ceil(completion / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

async function handleCompletion(req, res, body) {
  const p = plan(body);
  const id = `chatcmpl-fake-${++counter}`;
  const model = body?.model ?? "fake-model";
  if (p.error) {
    res.writeHead(p.error, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `fake error ${p.error}`, type: "fake_error", code: String(p.error) } }));
    return;
  }
  const toolCall = p.toolCall
    ? { id: `call_fake_${counter}_${p.step}`, type: "function", function: { name: p.toolCall.name, arguments: p.toolCall.arguments } }
    : null;
  const finish = toolCall ? "tool_calls" : "stop";
  const outText = toolCall ? toolCall.function.arguments : p.text;

  if (!body?.stream) {
    const message = { role: "assistant", content: toolCall ? null : p.text };
    if (p.reasoning) message.reasoning_content = p.reasoning;
    if (toolCall) message.tool_calls = [toolCall];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: CREATED, model, choices: [{ index: 0, message, finish_reason: finish }], usage: usage(body, outText) }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  req.on("close", () => (closed = true));
  const send = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: CREATED, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);

  send({ role: "assistant", content: "" });
  if (p.reasoning) for (const c of chunksOf(p.reasoning)) { if (closed) return; await sleep(p.delay); send({ reasoning_content: c }); }
  if (toolCall) {
    send({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.function.name, arguments: "" } }] });
    const a = toolCall.function.arguments;
    for (let i = 0; i < a.length; i += 16) { if (closed) return; await sleep(p.delay); send({ tool_calls: [{ index: 0, function: { arguments: a.slice(i, i + 16) } }] }); }
  } else {
    for (const c of chunksOf(p.text)) { if (closed) return; await sleep(p.delay); send({ content: c }); }
  }
  // Mistral reports usage on the terminal choice without OpenAI's include_usage request flag.
  send({}, finish, body?.stream_options?.include_usage ? {} : { usage: usage(body, outText) });
  if (body?.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: CREATED, model, choices: [], usage: usage(body, outText) })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0].replace(/^\/v1(?=\/)/, "");
      if (path === "/health") return res.end("ok\n");
      if (KEY && req.headers.authorization !== `Bearer ${KEY}` && !path.startsWith("/_fake/")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid api key", type: "invalid_request_error" } }));
      }
      if (req.method === "GET" && path === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: CREATED, owned_by: "baskule-fake" })) }));
      }
      if (req.method === "GET" && path === "/_fake/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(recent));
      }
      if (req.method === "POST" && path === "/_fake/reset") { recent.length = 0; counter = 0; return res.end("ok\n"); }
      if (req.method === "POST" && path === "/chat/completions") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "invalid JSON", type: "invalid_request_error" } }));
        }
        recent.push(body);
        if (recent.length > 50) recent.shift();
        return await handleCompletion(req, res, body);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}`, type: "not_found" } }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: "server_error" } }));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, HOST, () => console.error(`fake-llm listening on http://${HOST}:${PORT}/v1`));
}
