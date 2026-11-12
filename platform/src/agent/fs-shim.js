// celld's node:fs has no createWriteStream/createReadStream, and its /tmp is request-local. OpenCode's Shell
// service streams each command's output to a file under its data dir and reads it back by range. Keep those
// files in isolate memory instead (patched module objects stay in this isolate, see celld cloudflare-compat).
import fs from "node:fs";
import fsp from "node:fs/promises";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

const files = new WeakMap();
const owners = new AsyncLocalStorage();
const owner = () => {
  const value = owners.getStore();
  if (!value?.active) throw new Error("Shell capture has no live Space owner");
  return value;
};
export const createCaptureScope = (spaceId) => {
  const token = { spaceId, active: true };
  return {
    run: (run) => owners.run(token, run),
    release: () => {
      token.active = false;
      for (const file of files.get(token)?.values() ?? []) {
        file.closed = true; file.chunks = []; file.size = 0;
      }
      files.delete(token);
    },
  };
};
const concat = (f) => {
  const out = new Uint8Array(f.size);
  let o = 0;
  for (const c of f.chunks) { out.set(c, o); o += c.length; }
  f.chunks = [out];
  return out;
};

fs.createWriteStream = (path) => {
  const token = owner();
  const captures = files.get(token) ?? new Map();
  const f = { owner: token, chunks: [], size: 0, closed: false };
  captures.set(String(path), f); files.set(token, captures);
  const s = new EventEmitter();
  s.write = (chunk) => { if (f.closed || !f.owner.active) return false; const b = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk); f.chunks.push(b); f.size += b.length; return true; };
  s.end = (cb) => { queueMicrotask(() => { s.emit("finish"); s.emit("close"); cb?.(); }); return s; };
  queueMicrotask(() => s.emit("open"));
  return s;
};
fs.createReadStream = (path, opts = {}) => {
  const token = owner();
  const s = new EventEmitter();
  queueMicrotask(() => {
    const f = token.active ? files.get(token)?.get(String(path)) : undefined;
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
fsp.unlink = async (p) => {
  const token = owners.getStore();
  const captures = token?.active ? files.get(token) : undefined;
  const file = captures?.get(String(p));
  if (!file) return unlink?.(p);
  file.closed = true; file.chunks = []; file.size = 0;
  captures.delete(String(p));
  if (!captures.size) files.delete(token);
};
export const shimFiles = {
  has: (path) => shimFiles.get(path) !== undefined,
  get: (path) => { const token = owners.getStore(); return token?.active ? files.get(token)?.get(String(path)) : undefined; },
};

