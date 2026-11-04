import { log } from './log.ts';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Backend, ExecEvent, ExecHandle, ExecStart } from './backend.ts';
const source = readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
const sessions = new WeakMap<Backend, Map<string, ExecSession>>();
// Same cap as the agent. Argv is validated to 200 KiB; a larger start (huge env) fails only its own exec.
const MAX_START_FRAME = 16 * 1024 * 1024;
const deadMessage = 'exec stream ended without an exit status';

export function closeSessions(backend: Backend, machine?: string) {
  const map = sessions.get(backend);
  if (!map) return;
  for (const [name, session] of map) if (machine === undefined || name === machine) session.close();
}
/** True while an agent session to this machine is open: the machine is running. */
export function liveSession(backend: Backend, machine: string): boolean {
  return sessions.get(backend)?.get(machine)?.alive ?? false;
}
export function sessionFor(backend: Backend, machine: string): ExecSession {
  let map = sessions.get(backend);
  if (!map) { map = new Map(); sessions.set(backend, map); }
  let session = map.get(machine);
  if (!session) {
    session = new ExecSession(backend.exec({ machine, command: ['/usr/local/bin/node', '--input-type=module', '-e', source] }), () => map.delete(machine));
    map.set(machine, session);
  }
  return session;
}
interface Job { id: string; output: PassThrough; credit: number; granted: number; writes: Promise<void>; wake: () => void; }
export class ExecSession {
  private jobs = new Map<number, Job>();
  private next = 1;
  private dead = false;
  private opened = false;
  private stderr = Buffer.alloc(0);
  private lastFrame = Date.now();
  /** Opened (the agent answered once) and not closed since. */
  get alive() { return this.opened && !this.dead; }
  private timer: NodeJS.Timeout;
  private transport: ExecHandle;
  private removed: () => void;
  constructor(transport: ExecHandle, removed: () => void = () => {}) {
    this.transport = transport; this.removed = removed;
    // Ping every 15 s; the agent always answers, so 45 s of silence means a half-open stream (lost node).
    this.timer = setInterval(() => {
      if (Date.now() - this.lastFrame > (this.opened ? 45000 : 60000)) this.close();
      else void this.send(10, 0);
    }, 15000);
    this.timer.unref();
    void this.read();
  }
  private async send(type: number, handle: number, payload: Buffer | string = '') {
    if (this.dead) return;
    const body = Buffer.from(payload); const frame = Buffer.alloc(9 + body.length);
    frame.writeUInt32BE(5 + body.length); frame[4] = type; frame.writeUInt32BE(handle, 5); body.copy(frame, 9);
    try { await this.transport.writeStdin(frame); } catch { this.close(); }
  }
  private async read() {
    let buffer: Buffer = Buffer.alloc(0);
    try {
      for await (const event of this.transport.events) {
        if ('stderr' in event) this.stderr = Buffer.concat([this.stderr, event.stderr]).subarray(-4096);
        if (!('stdout' in event)) { if ('exit' in event) break; continue; }
        buffer = Buffer.concat([buffer, event.stdout]);
        while (buffer.length >= 4) {
          const n = buffer.readUInt32BE(); if (n < 5 || n > 262144) throw Error('Invalid frame');
          if (buffer.length < n + 4) break;
          const type = buffer[4], handle = buffer.readUInt32BE(5), payload = buffer.subarray(9, n + 4);
          this.opened = true; this.lastFrame = Date.now();
          if (![4, 5, 6, 8, 9, 11].includes(type)) throw Error('Unknown frame');
          const value = Number(payload);
          if ((type === 8 && (!Number.isSafeInteger(value) || value < 0)) || (type === 6 && (!Number.isInteger(value) || value < 0 || value > 255))) throw Error('Invalid number');
          const j = this.jobs.get(handle);
          if (j) {
            if (type === 4 || type === 5) {
              if (payload.length > 65536 || payload.length > j.granted) throw Error('Output exceeds credit');
              j.granted -= payload.length;
              j.output.write(type === 4 ? { stdout: Buffer.from(payload) } : { stderr: Buffer.from(payload) });
            }
            else if (type === 6) { j.output.end({ exit: Number(payload) }); this.jobs.delete(handle); j.wake(); }
            else if (type === 8) { j.credit += Number(payload); j.wake(); }
            else if (type === 9) throw Error(payload.toString());
          }
          buffer = buffer.subarray(n + 4);
        }
      }
    } catch {} finally { this.close(); }
  }
  close() {
    if (this.dead) return;
    if (this.stderr.length) log.warn('exec agent closed', { stderr: this.stderr.toString() });
    this.dead = true; clearInterval(this.timer); this.removed(); this.transport.endStdin(); this.transport.cancel();
    for (const j of this.jobs.values()) { j.output.destroy(new Error(deadMessage)); j.wake(); }
    this.jobs.clear();
  }
  kill(id: string, signal: string): boolean {
    for (const [handle, j] of this.jobs) if (j.id === id) { void this.send(7, handle, signal); return true; }
    return false;
  }
  start(start: ExecStart, id: string): ExecHandle {
    const handle = this.next++;
    const output = new PassThrough({ objectMode: true });
    output.on('error', () => {});
    const j: Job = { id, output, credit: 1048576, granted: 1048576, writes: Promise.resolve(), wake: () => {} };
    if (this.dead) output.destroy(new Error(deadMessage));
    else this.jobs.set(handle, j);
    const payload = JSON.stringify({ id, argv: start.command, cwd: start.workdir, env: start.environment });
    if (Buffer.byteLength(payload) + 5 > MAX_START_FRAME) {
      this.jobs.delete(handle);
      output.write({ stderr: Buffer.from('command, working directory and environment exceed 16 MiB\n') });
      output.end({ exit: 126 });
    } else void this.send(1, handle, payload);
    const send = this.send.bind(this);
    return {
      events: (async function* (): AsyncIterable<ExecEvent> {
        for await (const event of output) {
          yield event;
          if ('stdout' in event) j.granted += event.stdout.length;
          else if ('stderr' in event) j.granted += event.stderr.length;
          if ('stdout' in event) void send(8, handle, String(event.stdout.length));
          else if ('stderr' in event) void send(8, handle, String(event.stderr.length));
        }
      })(),
      writeStdin: chunk => j.writes = j.writes.then(async () => {
        for (let offset = 0; offset < chunk.length;) {
          if (this.dead || !this.jobs.has(handle)) throw Error(deadMessage);
          if (!j.credit) { await new Promise<void>(resolve => { j.wake = resolve; }); continue; }
          const n = Math.min(j.credit, 65536, chunk.length - offset); j.credit -= n;
          await this.send(2, handle, chunk.subarray(offset, offset + n)); offset += n;
        }
      }),
      endStdin: () => { void j.writes.then(() => this.send(3, handle)).catch(() => {}); },
      cancel: () => { void this.send(12, handle); this.jobs.delete(handle); output.destroy(); j.wake(); },
    };
  }
}
