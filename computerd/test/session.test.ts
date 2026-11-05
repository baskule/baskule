import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeBackend } from './fake-backend.ts';
import { startExec, runCollect, killExec, killArgv } from '../src/exec.ts';
import { closeSessions } from '../src/session.ts';

test('local agent: streaming, isolation, failure and recovery', { timeout: 15000 }, async t => {
  const backend = new FakeBackend();
  backend.sandboxes.set('local', { name: 'local', phase: 'ready', image: '', labels: {}, error: null });
  t.after(() => backend.close());
  const run = (argv: string[], options = {}) => runCollect(backend, { sandbox: 'local', argv, ...options });
  const r = await run(['sh', '-c', 'printf "$MARKER:$PWD"; printf err >&2; exit 23'], { cwd: '/tmp', env: { MARKER: 'value' } });
  assert.equal(r.stdout.toString(), 'value:/tmp'); assert.equal(r.stderr.toString(), 'err'); assert.equal(r.code, 23);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 97);
  assert.deepEqual((await run(['cat'], { stdin: bytes })).stdout, bytes);
  assert.equal((await run(['/no-such-executable'])).code, 127);
  assert.equal((await run(['sh', '-c', 'kill -TERM $$'])).code, 143);
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => run(['true']).then(r => r.code))), Array(12).fill(0));
  const large = startExec(backend, { sandbox: 'local', argv: ['head', '-c', '8388608', '/dev/zero'] });
  assert.equal((await run(['true'])).code, 0);
  let size = 0;
  for await (const e of large.events) if ('stdout' in e) size += e.stdout.length;
  assert.equal(size, 8388608);
  for (const direct of [true, false]) {
    const id = randomUUID();
    const job = startExec(backend, { sandbox: 'local', id, argv: ['sh', '-c', 'echo ready; exec sleep 60'] });
    const events = job.events[Symbol.asyncIterator]();
    assert.ok('stdout' in (await events.next()).value);
    if (direct) assert.equal(await killExec(backend, 'local', id, 'KILL'), true);
    else assert.equal((await run(killArgv(id, 'KILL'))).code, 0);
    let code;
    for (;;) { const e = await events.next(); if (e.done) break; if ('exit' in e.value) code = e.value.exit; }
    assert.equal(code, 137);
  }
  const dying = startExec(backend, { sandbox: 'local', argv: ['sh', '-c', 'kill -KILL "$PPID"'] });
  await assert.rejects(async () => { for await (const _ of dying.events) {} }, /exec stream ended without an exit status/);
  assert.equal((await run(['true'])).code, 0);
  assert.equal(backend.execs.length, 2);
  closeSessions(backend);
});

test('malformed exec inputs stay isolated and concurrent stdin is serialized', { timeout: 15000 }, async t => {
  const backend = new FakeBackend();
  backend.sandboxes.set('local', { name: 'local', phase: 'ready', image: '', labels: {}, error: null });
  t.after(() => backend.close());
  const run = (argv: string[], options = {}) => runCollect(backend, { sandbox: 'local', argv, ...options });
  assert.equal((await run(['true', '\x01'.repeat(60000)])).code, 0);
  const failure = await run(['/missing/' + 'a'.repeat(150000)]);
  assert.notEqual(failure.code, 0);
  assert.ok(failure.stderr.length <= 4096);
  const cwd = await run(['true'], { cwd: '/no/such/directory' });
  assert.equal(cwd.code, 1);
  assert.match(cwd.stderr.toString(), /cd:.*No such file/);
  const id = randomUUID();
  const { mkdirSync, rmSync } = await import('node:fs');
  mkdirSync('/tmp/.osj/' + id, { recursive: true });
  try { assert.equal((await run(['true'], { id })).code, 0); }
  finally { rmSync('/tmp/.osj/' + id, { recursive: true }); }
  const job = startExec(backend, { sandbox: 'local', argv: ['wc', '-c'], interactive: true });
  await Promise.all([job.write(Buffer.alloc(1500000)), job.write(Buffer.alloc(1500000))]);
  job.endStdin();
  let output = '';
  for await (const e of job.events) if ('stdout' in e) output += e.stdout;
  assert.equal(output.trim(), '3000000');
  assert.equal((await run(['true'])).code, 0);
  assert.equal(backend.execs.length, 1);
  assert.equal(backend.execs[0].command[0], '/usr/local/bin/node');
});

test('untrusted agent output and numbers close the session', async () => {
  const { ExecSession } = await import('../src/session.ts');
  const { PassThrough } = await import('node:stream');
  for (const [type, payload] of [[8, '-1'], [8, 'NaN'], [6, '256'], [6, '1.5'], [9, ''], [99, ''], [4, Buffer.alloc(65537)]] as const) {
    const events = new PassThrough({ objectMode: true });
    let cancelled = false;
    const session = new ExecSession({ events, writeStdin: async () => {}, endStdin() {}, cancel() { cancelled = true; } });
    const job = session.start({ machine: 'local', command: ['true'] }, 'test');
    const body = Buffer.from(payload);
    const frame = Buffer.alloc(body.length + 9);
    frame.writeUInt32BE(body.length + 5); frame[4] = type; frame.writeUInt32BE(1, 5); body.copy(frame, 9);
    events.write({ stdout: frame });
    await assert.rejects(async () => { for await (const _ of job.events) {} }, /exec stream ended/);
    assert.ok(cancelled);
    events.destroy();
  }
});

test('unopened sessions expire', async t => {
  const { ExecSession } = await import('../src/session.ts');
  const { PassThrough } = await import('node:stream');
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const events = new PassThrough({ objectMode: true });
  const session = new ExecSession({ events, writeStdin: async () => {}, endStdin() {}, cancel() {} });
  const job = session.start({ machine: 'local', command: ['true'] }, 'timeout');
  t.mock.timers.tick(75000);
  await assert.rejects(async () => { for await (const _ of job.events) {} }, /exec stream ended/);
  events.destroy();
});

test('start frame size: large starts work, oversized starts fail alone', { timeout: 15000 }, async t => {
  const backend = new FakeBackend();
  backend.sandboxes.set('size', { name: 'size', phase: 'ready', image: '', labels: {}, error: null });
  t.after(() => backend.close());
  const run = (argv: string[], options = {}) => runCollect(backend, { sandbox: 'size', argv, ...options });
  const bystander = run(['sh', '-c', 'sleep 0.5; echo survived']);
  // Each value stays under Linux's 128 KiB per-string limit; control characters escape six-fold in JSON.
  const env = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`BASKULE_BIG${i}`, '\x01'.repeat(100 * 1024)]));
  const escaped = await run(['sh', '-c', 'printf %s "${#BASKULE_BIG0}"'], { env: env(12) }); // ~7 MiB start frame
  assert.equal(escaped.code, 0); assert.equal(escaped.stdout.toString(), String(100 * 1024));
  const oversized = await run(['true'], { env: env(30) }); // ~18 MiB
  assert.equal(oversized.code, 126); assert.match(oversized.stderr.toString(), /exceed 16 MiB/);
  assert.equal((await bystander).stdout.toString(), 'survived\n');
  assert.equal(backend.execs.length, 1);
});
