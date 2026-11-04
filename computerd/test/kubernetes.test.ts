import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { KubernetesBackend, pvcName } from '../src/kubernetes.ts';

test('Kubernetes lifecycle, watch, exec and port forwarding', async t => {
  let sandbox: any = null;
  let pod: any = null;
  let disk = false;
  let version = 1;
  let watches = 0;
  let eof = false;
  const deletes: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test');
    const url = new URL(req.url!, 'http://test');
    const path = url.pathname;
    let body = ''; for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : null;
    const send = (value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const kind = path.includes('/sandboxes') ? 'sandbox' : path.includes('/pods') ? 'pod' : 'disk';
    let value = kind === 'sandbox' ? sandbox : kind === 'pod' ? pod : disk ? { metadata: { name: pvcName('machine', 'space') } } : null;
    if (req.method === 'POST') {
      if (sandbox) { send({}, 409); return; }
      assert.equal(data.apiVersion, 'agents.x-k8s.io/v1beta1');
      assert.equal(data.spec.operatingMode, 'Running');
      assert.equal(data.spec.volumeClaimTemplates[0].metadata.name, 'space');
      const template = data.spec.podTemplate;
      assert.equal(template.metadata.labels['baskule.computer'], 'true');
      assert.equal(template.spec.automountServiceAccountToken, false);
      assert.equal(template.spec.enableServiceLinks, false);
      assert.equal(template.spec.terminationGracePeriodSeconds, 1);
      assert.equal(template.spec.securityContext.fsGroup, 1000);
      assert.deepEqual(template.spec.containers[0].securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
      assert.deepEqual(template.spec.containers[0].resources, { requests: { cpu: '2', memory: '3Gi' }, limits: { cpu: '2', memory: '3Gi' } });
      assert.deepEqual(template.spec.containers[0].volumeMounts, [{ name: 'space', mountPath: '/sandbox/space' }]);
      sandbox = data; disk = true; send(sandbox); return;
    }
    if (req.method === 'PATCH') {
      assert.equal(req.headers['content-type'], 'application/merge-patch+json');
      if (data.spec.podTemplate) {
        assert.equal(data.spec.volumeClaimTemplates, undefined);
        sandbox.spec.podTemplate.spec.containers = data.spec.podTemplate.spec.containers;
      }
      sandbox.spec.operatingMode = data.spec.operatingMode;
      if (data.spec.operatingMode === 'Suspended') pod = null;
      else { sandbox.status = {}; pod = null; }
      send(sandbox); return;
    }
    if (req.method === 'DELETE') {
      deletes.push(kind); assert.equal(data.propagationPolicy, 'Foreground');
      if (kind === 'sandbox') { sandbox = null; pod = null; } else disk = false;
      send({}, value ? 200 : 404); return;
    }
    if (url.searchParams.has('watch')) {
      watches++; assert.ok(url.searchParams.get('resourceVersion'));
      sandbox.status = { selector: 'agents.x-k8s.io/sandbox-name-hash=test', conditions: [{ type: 'Ready', status: 'True' }] };
      pod = { metadata: { name: 'pod' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
      sandbox.metadata.resourceVersion = String(++version);
      res.end(JSON.stringify({ type: 'MODIFIED', object: sandbox }) + '\n'); return;
    }
    if (url.searchParams.has('fieldSelector') || url.searchParams.has('labelSelector')) { send({ metadata: { resourceVersion: String(version) }, items: value ? [value] : [] }); return; }
    send(value ?? {}, value ? 200 : 404);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    const url = new URL(req.url!, 'http://test');
    if (url.pathname.endsWith('/exec')) {
      assert.equal(ws.protocol, 'v5.channel.k8s.io');
      assert.deepEqual(url.searchParams.getAll('command'), ['cat']);
      ws.on('message', raw => {
        const b = Buffer.from(raw as Buffer);
        if (b[0] === 0) ws.send(Buffer.concat([Buffer.from([1]), b.subarray(1)]));
        if (b[0] === 255) {
          assert.equal(b[1], 0); eof = true;
          ws.send(Buffer.from([2, ...Buffer.from('stderr')]));
          ws.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '7' }] } }))]));
        }
      });
    } else {
      assert.equal(url.searchParams.get('ports'), '9222');
      ws.send(Buffer.from([0, 6, 36])); ws.send(Buffer.from([1, 6, 36]));
      ws.on('message', raw => ws.send(raw));
    }
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new KubernetesBackend({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test', ca: '', namespace: 'test', timeoutMs: 2000 });
  t.after(() => { backend.close(); wss.close(); server.close(); server.closeAllConnections(); });
  const spec = { name: 'machine', disk: 'space', image: 'computer:test', cpus: '2', memory: '3Gi', labels: { managed: 'true' }, annotations: {} };
  assert.equal((await backend.create(spec)).phase, 'ready');
  assert.equal((await backend.list({ managed: 'true' })).length, 1);
  assert.equal((await backend.create(spec)).phase, 'ready');
  const exec = backend.exec({ machine: 'machine', command: ['cat'] });
  await exec.writeStdin(Buffer.from('hello')); exec.endStdin();
  const events = []; for await (const e of exec.events) events.push(e);
  assert.deepEqual(events, [{ stdout: Buffer.from('hello') }, { stderr: Buffer.from('stderr') }, { exit: 7 }]); assert.ok(eof);
  const stream = backend.connect('machine', 9222);
  const received = once(stream, 'data'); stream.write(Buffer.from('roundtrip'));
  assert.equal((await received)[0].toString(), 'roundtrip'); stream.destroy();
  await backend.stop('machine'); assert.equal((await backend.get('machine'))?.phase, 'stopped');
  assert.equal((await backend.start('machine')).phase, 'ready');
  await t.test('recreate preserves disk and container settings while changing image and limits', async () => {
    await backend.stop('machine');
    const claims = structuredClone(sandbox.spec.volumeClaimTemplates);
    const original = structuredClone(sandbox.spec.podTemplate.spec.containers[0]);
    assert.equal((await backend.recreate({ ...spec, image: 'new:image', cpus: '4', memory: '8Gi' })).phase, 'ready');
    assert.deepEqual(sandbox.spec.volumeClaimTemplates, claims);
    assert.deepEqual(sandbox.spec.podTemplate.spec.containers[0], { ...original, image: 'new:image', resources: { requests: { cpu: '4', memory: '8Gi' }, limits: { cpu: '4', memory: '8Gi' } } });
    assert.ok(disk);
  });
  assert.ok(watches >= 3);
  assert.deepEqual(await backend.remove('machine', 'space'), { machineDeleted: true, diskDeleted: true });
  assert.deepEqual(deletes, ['sandbox', 'disk']);
  assert.deepEqual(await backend.remove('machine', 'space'), { machineDeleted: false, diskDeleted: false });
  assert.equal(await backend.get('machine'), null);
});

test('projected service account token refreshes after 60 seconds', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kube-token-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'first');
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const seen: unknown[] = [];
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.statusCode = 404; res.end(JSON.stringify({ items: [] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new KubernetesBackend({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile, ca: '', namespace: 'test' });
  t.after(() => { backend.close(); server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true }); });
  await backend.get('missing');
  writeFileSync(tokenFile, 'second');
  now += 59999;
  await backend.get('missing');
  now++;
  await backend.get('missing');
  assert.deepEqual(seen, ['Bearer first', 'Bearer first', 'Bearer second']);
});
