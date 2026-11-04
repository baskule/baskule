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
  const run = (argv: string[], options = {}) => runCollect(backend, '', { sandbox: 'local', argv, ...options });
  const r = await run(['sh', '-c', 'printf "$MARKER:$PWD"; printf err >&2; exit 23'], { cwd: '/tmp', env: { MARKER: 'value' } });
  assert.equal(r.stdout.toString(), 'value:/tmp'); assert.equal(r.stderr.toString(), 'err'); assert.equal(r.code, 23);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 97);
  assert.deepEqual((await run(['cat'], { stdin: bytes })).stdout, bytes);
  assert.equal((await run(['/no-such-executable'])).code, 127);
  assert.equal((await run(['sh', '-c', 'kill -TERM $$'])).code, 143);
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => run(['true']).then(r => r.code))), Array(12).fill(0));
  const large = startExec(backend, '', { sandbox: 'local', argv: ['head', '-c', '8388608', '/dev/zero'] });
  assert.equal((await run(['true'])).code, 0);
  let size = 0;
  for await (const e of large.events) if ('stdout' in e) size += e.stdout.length;
  assert.equal(size, 8388608);
  for (const direct of [true, false]) {
    const id = randomUUID();
    const job = startExec(backend, '', { sandbox: 'local', id, argv: ['sh', '-c', 'echo ready; exec sleep 60'] });
    const events = job.events[Symbol.asyncIterator]();
    assert.ok('stdout' in (await events.next()).value);
    if (direct) assert.equal(await killExec(backend, '', 'local', id, 'KILL'), true);
    else assert.equal((await run(killArgv(id, 'KILL'))).code, 0);
    let code;
    for (;;) { const e = await events.next(); if (e.done) break; if ('exit' in e.value) code = e.value.exit; }
    assert.equal(code, 137);
  }
  const dying = startExec(backend, '', { sandbox: 'local', argv: ['sh', '-c', 'kill -KILL "$PPID"'] });
  await assert.rejects(async () => { for await (const _ of dying.events) {} }, /exec stream ended without an exit status/);
  assert.equal((await run(['true'])).code, 0);
  assert.equal(backend.execs.length, 2);
  closeSessions(backend);
});
