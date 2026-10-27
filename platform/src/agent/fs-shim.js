// celld's node:fs has no createWriteStream/createReadStream, and its /tmp is request-local. OpenCode's Shell
// service streams each command's output to a file under its data dir and reads it back by range. Keep those
// files in isolate memory instead (patched module objects stay in this isolate, see celld cloudflare-compat).
import fs from "node:fs";
import fsp from "node:fs/promises";
import { EventEmitter } from "node:events";

const files = new Map(); // path -> { chunks: Uint8Array[], size }
const concat = (f) => {
  const out = new Uint8Array(f.size);
  let o = 0;
  for (const c of f.chunks) { out.set(c, o); o += c.length; }
  f.chunks = [out];
  return out;
};

fs.createWriteStream = (path) => {
  const f = { chunks: [], size: 0 };
  files.set(String(path), f);
  const s = new EventEmitter();
  s.write = (chunk) => { const b = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk); f.chunks.push(b); f.size += b.length; return true; };
  s.end = (cb) => { queueMicrotask(() => { s.emit("finish"); s.emit("close"); cb?.(); }); return s; };
  queueMicrotask(() => s.emit("open"));
  return s;
};
fs.createReadStream = (path, opts = {}) => {
  const s = new EventEmitter();
  queueMicrotask(() => {
    const f = files.get(String(path));
    if (!f) return s.emit("error", Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }));
    const all = concat(f);
    const start = opts.start ?? 0;
    const end = opts.end === undefined ? all.length : opts.end + 1;
    s.emit("data", Buffer.from(all.subarray(start, end)));
    s.emit("end");
    s.emit("close");
  });
  return s;
};
const mkdir = fsp.mkdir;
fsp.mkdir = async (...a) => { try { return await mkdir(...a); } catch { return undefined; } };
const unlink = fsp.unlink;
fsp.unlink = async (p) => { if (files.delete(String(p))) return; return unlink?.(p); };
export const shimFiles = files;

