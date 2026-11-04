// Wire: big-endian u32 body length, u8 type, u32 handle, payload.
// 1 start JSON {argv,cwd,env,id}; 2 stdin; 3 EOF; 4 stdout; 5 stderr;
// 6 exit decimal; 7 signal; 8 credit decimal; 9 error; 10 ping; 11 pong;
// 12 detach. Each direction starts with 1 MiB credit per exec; consumers
// replenish only consumed bytes. Frames are at most 256 KiB (data: 64 KiB).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { constants } from 'node:os';
const jobs = new Map();
let buffer = Buffer.alloc(0);
const send = (type, handle, payload = '') => {
  const body = Buffer.from(payload); const frame = Buffer.alloc(9 + body.length);
  frame.writeUInt32BE(5 + body.length); frame[4] = type; frame.writeUInt32BE(handle, 5); body.copy(frame, 9);
  return process.stdout.write(frame);
};
function pump(j) {
  if (j.discard) { j.child.stdout.resume(); j.child.stderr.resume(); return; }
  if (process.stdout.writableNeedDrain) return;
  for (const [stream, type] of [[j.child.stdout, 4], [j.child.stderr, 5]]) {
    stream.read(0);
    while (j.credit > 0 && stream.readableLength) {
      const chunk = stream.read(Math.min(j.credit, stream.readableLength, 65536));
      if (!chunk) break;
      stream.read(0);
      j.credit -= chunk.length;
      if (!send(type, j.handle, chunk)) return;
    }
  }
}
process.stdout.on('drain', () => { for (const j of jobs.values()) pump(j); });
function receive(type, handle, data) {
  if (type === 10) { send(11, 0); return; }
  if (type === 1) {
    const o = JSON.parse(data);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) throw Error('Invalid exec id');
    const child = spawn(o.argv[0], o.argv.slice(1), { detached: true, cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe','pipe','pipe'] });
    const j = { child, handle, credit: 1048576, discard: false };
    jobs.set(handle, j);
    const path = '/tmp/.osj/' + o.id;
    if (child.pid) { mkdirSync('/tmp/.osj', { recursive: true }); writeFileSync(path, String(child.pid)); }
    for (const s of [child.stdout, child.stderr]) s.on('readable', () => pump(j));
    child.stdin.on('error', () => {});
    let failure;
    child.on('error', e => { failure = e.code === 'ENOENT' ? 127 : 126; if (!j.discard) send(5, handle, `${o.argv[0]}: ${e.message}\n`); });
    child.on('close', (code, signal) => {
      try { unlinkSync(path); } catch {}
      jobs.delete(handle);
      if (!j.discard) send(6, handle, String(failure ?? code ?? 128 + (constants.signals[signal] ?? 0)));
    });
    return;
  }
  const j = jobs.get(handle); if (!j) return;
  if (type === 2) j.child.stdin.write(data, () => { if (!j.discard) send(8, handle, String(data.length)); });
  else if (type === 3) j.child.stdin.end();
  else if (type === 7) { try { process.kill(-j.child.pid, 'SIG' + data.toString()); } catch {} }
  else if (type === 8) { j.credit += Number(data); pump(j); }
  else if (type === 12) { j.discard = true; j.child.stdout.removeAllListeners('readable'); j.child.stderr.removeAllListeners('readable'); pump(j); }
}
process.stdin.on('data', chunk => {
  try {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const n = buffer.readUInt32BE(); if (n < 5 || n > 262144) throw Error('Invalid frame');
      if (buffer.length < n + 4) break;
      receive(buffer[4], buffer.readUInt32BE(5), buffer.subarray(9, n + 4)); buffer = buffer.subarray(n + 4);
    }
  } catch { process.exit(1); }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
