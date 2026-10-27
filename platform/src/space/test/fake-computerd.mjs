#!/usr/bin/env node
// Fake computerd (E4 subset) for the SpaceCell tests: files GET/PUT and exec, per space, over a
// host directory standing in for each computer's /sandbox. Also /v1/spaces/:id/computer(/stop).
//   node fake-computerd.mjs --port 47552 --root <dir> [--token test-computerd-token]
import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const PORT = Number(arg("port", 47552));
const ROOT = path.resolve(arg("root", "/tmp/baskule-wpb-computers"));
const TOKEN = arg("token", "test-computerd-token");
const calls = [];
const state = new Map();

const hostPath = (space, p) => {
  if (p !== "/sandbox" && !p.startsWith("/sandbox/")) throw new Error(`outside sandbox: ${p}`);
  const base = path.join(ROOT, space);
  const out = path.resolve(base, "." + p.slice("/sandbox".length));
  if (out !== base && !out.startsWith(base + "/")) throw new Error("escape");
  return out;
};
const body = (req) => new Promise((r) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => r(Buffer.concat(parts))); });
const frame = (o) => JSON.stringify(o) + "\n";

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/_fake/calls") return res.end(JSON.stringify(calls.slice(-200)));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end("bad token"); }
  const m =/^\/v1\/spaces\/([A-Za-z0-9_-]+)\/(files|exec|computer|computer\/stop|computer\/delete)$/.exec(url.pathname);
  if (!m) { res.statusCode = 404; return res.end("not found"); }
  const [, space, what] = m;
  calls.push(`${req.method} ${space} ${what} ${url.searchParams.get("path") ?? ""}`);
  fs.mkdirSync(path.join(ROOT, space), { recursive: true });
  try {
    if (what === "computer") return res.end(JSON.stringify({ state: state.get(space) ?? "stopped" }));
    if (what === "computer/stop") { state.set(space, "stopped"); return res.end(JSON.stringify({ stopped: true })); }
    if (what === "computer/delete") {
      const { confirm } = JSON.parse((await body(req)).toString() || "{}");
      if (confirm !== space) { res.statusCode = 400; return res.end(JSON.stringify({ error: "confirm must equal the space id" })); }
      const existed = fs.existsSync(path.join(ROOT, space));
      fs.rmSync(path.join(ROOT, space), { recursive: true, force: true });
      state.delete(space);
      return res.end(JSON.stringify({ spaceId: space, sandbox: `os-${space}`, sandboxDeleted: existed, volumeDeleted: existed }));
    }
    state.set(space, "running");
    if (what === "files") {
      const p = hostPath(space, url.searchParams.get("path") ?? "");
      const kind = (st) => (st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other");
      const info = (q, st) => ({ path: q, type: kind(st), size: st.size, mtime: st.mtime.toISOString(), mode: st.mode & 0o7777 });
      const q = url.searchParams.get("path");
      if (req.method === "PUT") {
        if (url.searchParams.get("type") === "dir") fs.mkdirSync(p, { recursive: true });
        else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, await body(req)); }
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(info(q, fs.statSync(p))));
      }
      if (!fs.existsSync(p)) { res.statusCode = 404; return res.end(JSON.stringify({ error: "not found" })); }
      const st = fs.statSync(p);
      res.setHeader("content-type", "application/json");
      if (url.searchParams.get("stat") === "1") return res.end(JSON.stringify(info(q, st)));
      if (st.isDirectory()) {
        const entries = fs.readdirSync(p).map((name) => ({ name, ...info(name, fs.lstatSync(path.join(p, name))) }));
        return res.end(JSON.stringify({ ...info(q, st), entries }));
      }
      const data = fs.readFileSync(p);
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("x-baskule-file-mode", String(st.mode & 0o7777));
      const r = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? "");
      if (r) {
        const start = Number(r[1]); const end = r[2] === undefined ? data.length - 1 : Math.min(Number(r[2]), data.length - 1);
        res.statusCode = 206; return res.end(data.subarray(start, end + 1));
      }
      return res.end(data);
    }
    const spec = JSON.parse((await body(req)).toString());
    calls.push(`  exec ${spec.argv.slice(3).join(" ")} :: ${String(spec.argv[2]).slice(0, 40)}`);
    const base = path.join(ROOT, space);
    const argv = spec.argv.map((a) => (a.startsWith("/sandbox") ? hostPath(space, a) : a));
    const out = spawnSync(argv[0], argv.slice(1), { cwd: spec.cwd ? hostPath(space, spec.cwd) : base, input: spec.stdin ? Buffer.from(spec.stdin, "base64") : undefined });
    const back = (b) => Buffer.from(b.toString().split(base).join("/sandbox")).toString("base64");
    res.setHeader("content-type", "application/x-ndjson");
    if (out.error) return res.end(frame({ t: "err", msg: String(out.error) }));
    res.end(frame({ t: "o", d: back(out.stdout) }) + frame({ t: "e", d: back(out.stderr) }) + frame({ t: "x", code: out.status ?? 1 }));
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
}).listen(PORT, "127.0.0.1", () => console.log(`fake computerd on 127.0.0.1:${PORT} root ${ROOT}`));
