import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Duplex, PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import type { Backend, Machine, MachineSpec, ExecStart, ExecHandle, ExecEvent } from './backend.ts';

export interface KubernetesOptions {
  baseUrl?: string; token?: string; tokenFile?: string; ca?: string | Buffer; namespace?: string;
  storageClass?: string; storageSize?: string; runtimeClassName?: string;
  nodeSelector?: Record<string, string>; tolerations?: Record<string, unknown>[];
  imagePullSecrets?: { name: string }[]; timeoutMs?: number;
}
type Resource = {
  metadata: { name: string; resourceVersion?: string; generation?: number; deletionTimestamp?: string;
    ownerReferences?: { kind: string; name: string }[]; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: { operatingMode?: string; podTemplate?: { spec?: { containers?: { name?: string; image: string; resources?: { limits?: { cpu?: string; memory?: string } } }[] } } };
  status?: { selector?: string; phase?: string; message?: string; conditions?: { type: string; status: string; reason?: string; message?: string; observedGeneration?: number }[] };
};
class ApiError extends Error {
  code: number;
  constructor(code: number, body: string) { super(`Kubernetes ${code}: ${body}`); this.code = code; }
}
const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
const encode = encodeURIComponent;
// v1.0.9 appends the Sandbox name to the template name. Restore snapshots into this
// PVC with agents.x-k8s.io/adoptable=true and no old controller owner reference.
export function pvcName(name: string, disk: string): string { return `${disk}-${name}`; }

export class KubernetesBackend implements Backend {
  private options: KubernetesOptions;
  private base: string;
  private token: string;
  private tokenReadAt = Date.now();
  private ca: string | Buffer;
  private sandboxes: string;
  private core: string;
  private podNames = new Map<string, string>();
  private sockets = new Set<WebSocket>();
  private abort = new AbortController();
  constructor(options: KubernetesOptions = {}) {
    this.options = options;
    const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
    this.base = options.baseUrl ?? `https://${host.includes(':') ? `[${host}]` : host}:${process.env.KUBERNETES_SERVICE_PORT ?? '443'}`;
    this.token = options.token ?? readFileSync(options.tokenFile ?? `${serviceAccount}/token`, 'utf8').trim();
    this.ca = options.ca ?? readFileSync(`${serviceAccount}/ca.crt`);
    const namespace = options.namespace ?? readFileSync(`${serviceAccount}/namespace`, 'utf8').trim();
    this.core = `/api/v1/namespaces/${encode(namespace)}`;
    this.sandboxes = `/apis/agents.x-k8s.io/v1beta1/namespaces/${encode(namespace)}/sandboxes`;
  }
  private authorization(): string {
    if (this.options.token === undefined && Date.now() - this.tokenReadAt >= 60_000) {
      this.token = readFileSync(this.options.tokenFile ?? `${serviceAccount}/token`, 'utf8').trim();
      this.tokenReadAt = Date.now();
    }
    return `Bearer ${this.token}`;
  }
  private response(path: string, method = 'GET', body?: unknown, signal = this.abort.signal) {
    const url = new URL(path, this.base);
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method, ca: this.ca, signal,
        headers: { ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }), Authorization: this.authorization(), 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' },
      }, resolve);
      req.on('error', reject);
      req.setTimeout(this.options.timeoutMs ?? 180000, () => req.destroy(new Error('Kubernetes request timed out')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  private async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await this.response(path, method, body);
    let text = ''; for await (const chunk of res) text += chunk;
    if ((res.statusCode ?? 500) >= 300) throw new ApiError(res.statusCode ?? 500, text);
    return JSON.parse(text || '{}');
  }
  private async resource(path: string): Promise<Resource | null> {
    try { return await this.api<Resource>(path); } catch (e) { if (e instanceof ApiError && e.code === 404) return null; throw e; }
  }
  private async pod(sandbox: Resource): Promise<Resource | null> {
    const selector = sandbox.status?.selector;
    if (!selector) return null;
    const query = new URLSearchParams({ labelSelector: selector });
    const pods = await this.api<{ items: Resource[] }>(`${this.core}/pods?${query}`);
    return this.selectPod(pods.items);
  }
  private selectPod(pods: Resource[]): Resource | null {
    return pods.find(p => !p.metadata.deletionTimestamp && p.status?.phase === 'Running') ?? pods[0] ?? null;
  }
  private async machine(s: Resource, suppliedPod?: Resource | null): Promise<Machine> {
    const p = suppliedPod === undefined ? await this.pod(s) : suppliedPod;
    const conditions = s.status?.conditions?.filter(c => c.observedGeneration === undefined || c.observedGeneration === s.metadata.generation) ?? [];
    const failed = conditions.find(c => c.type === 'Ready' && c.status === 'False' && /Failed|Error|Crash|Invalid/i.test(c.reason ?? ''));
    const error = p?.status?.phase === 'Failed' ? p.status.message ?? 'Pod failed' : failed ? failed.message ?? failed.reason ?? 'Sandbox failed' : null;
    const suspended = s.spec?.operatingMode === 'Suspended';
    const phase = s.metadata.deletionTimestamp ? 'stopping' : suspended ? (p ? 'stopping' : 'stopped') : error ? 'error' :
      p && !p.metadata.deletionTimestamp && conditions.some(c => c.type === 'Ready' && c.status === 'True') && p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ? 'ready' : 'starting';
    const limits = s.spec?.podTemplate?.spec?.containers?.[0]?.resources?.limits;
    return { cpus: limits?.cpu, memory: limits?.memory, name: s.metadata.name, phase, image: s.spec?.podTemplate?.spec?.containers?.[0]?.image ?? '', labels: s.metadata.labels ?? {}, error: phase === 'error' ? error : null };
  }
  async imageId(_image: string): Promise<string | null> { return null; }
  async get(name: string) { const s = await this.resource(`${this.sandboxes}/${encode(name)}`); return s ? this.machine(s) : null; }
  async list(labels: Record<string, string>) {
    const query = new URLSearchParams({ labelSelector: Object.entries(labels).map(([k,v]) => `${k}=${v}`).join(',') });
    const list = await this.api<{ items: Resource[] }>(`${this.sandboxes}?${query}`);
    const pods = await this.api<{ items: Resource[] }>(`${this.core}/pods?${new URLSearchParams({ labelSelector: 'baskule.computer=true' })}`);
    const bySandbox = new Map<string, Resource[]>();
    for (const pod of pods.items) {
      const name = pod.metadata.ownerReferences?.find(owner => owner.kind === 'Sandbox')?.name ?? pod.metadata.labels?.['agents.x-k8s.io/sandbox-name'];
      if (!name) continue;
      const group = bySandbox.get(name) ?? [];
      group.push(pod); bySandbox.set(name, group);
    }
    return Promise.all(list.items.map(s => this.machine(s, this.selectPod(bySandbox.get(s.metadata.name) ?? []))));
  }
  // LIST supplies a race-free resourceVersion, WATCH observes subsequent changes;
  // expiration (410) relists, normal watch timeout reconnects until the deadline.
  private async wait(collection: string, name: string, done: (s: Resource | null) => Promise<boolean>): Promise<void> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 180000)]);
    while (!signal.aborted) {
      const selector = new URLSearchParams({ fieldSelector: `metadata.name=${name}` });
      const listed = await this.api<{ metadata: { resourceVersion: string }; items: Resource[] }>(`${collection}?${selector}`);
      if (await done(listed.items[0] ?? null)) return;
      selector.set('watch', 'true'); selector.set('resourceVersion', listed.metadata.resourceVersion); selector.set('timeoutSeconds', '30');
      const res = await this.response(`${collection}?${selector}`, 'GET', undefined, signal);
      if (res.statusCode === 410) { res.resume(); continue; }
      if (res.statusCode !== 200) { res.resume(); throw new Error(`Watch failed: ${res.statusCode}`); }
      try {
        for await (const line of createInterface({ input: res })) {
          const event: { type: string; object: Resource & { code?: number } } = JSON.parse(line);
          if (event.type === 'ERROR') { if (event.object.code === 410) break; throw new Error(`Watch error: ${line}`); }
          if (event.type === 'BOOKMARK') continue;
          if (await done(event.type === 'DELETED' ? null : event.object)) return;
        }
      } finally { res.destroy(); }
    }
    signal.throwIfAborted();
  }
  private async ready(name: string): Promise<Machine> {
    let result: Machine | null = null;
    await this.wait(this.sandboxes, name, async s => {
      if (!s) throw new Error(`Sandbox ${name} disappeared`);
      result = await this.machine(s);
      if (result.phase === 'error') throw new Error(result.error ?? 'Sandbox failed');
      return result.phase === 'ready';
    });
    if (!result) throw new Error('Missing ready machine');
    return result;
  }
  private sandbox(spec: MachineSpec) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(spec.disk) || spec.disk.length > 63 || pvcName(spec.name, spec.disk).length > 253) throw new Error('Invalid disk template name');
    const resources = { cpu: spec.cpus, memory: spec.memory };
    const object = {
      apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox',
      metadata: { name: spec.name, labels: spec.labels, annotations: spec.annotations },
      spec: { operatingMode: 'Running',
        volumeClaimTemplates: [{ metadata: { name: spec.disk }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: this.options.storageClass, resources: { requests: { storage: this.options.storageSize ?? '10Gi' } } } }],
        podTemplate: { metadata: { labels: { ...spec.labels, 'baskule.computer': 'true' }, annotations: spec.annotations }, spec: {
          automountServiceAccountToken: false, enableServiceLinks: false, terminationGracePeriodSeconds: 1,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch", runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          runtimeClassName: this.options.runtimeClassName, nodeSelector: this.options.nodeSelector, tolerations: this.options.tolerations, imagePullSecrets: this.options.imagePullSecrets,
          containers: [{ name: 'computer', image: spec.image, command: ['/usr/bin/tini', '--', 'sleep', 'infinity'], resources: { requests: resources, limits: resources },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }, volumeMounts: [{ name: spec.disk, mountPath: '/sandbox/space' }] }],
        } },
      },
    };
    return object;
  }
  async create(spec: MachineSpec): Promise<Machine> {
    const object = this.sandbox(spec);
    try { await this.api(this.sandboxes, 'POST', object); } catch (e) { if (e instanceof ApiError && e.code === 409) return this.start(spec.name); throw e; }
    return this.ready(spec.name);
  }
  async start(name: string) { this.podNames.delete(name); await this.api(`${this.sandboxes}/${encode(name)}`, 'PATCH', { spec: { operatingMode: 'Running' } }); return this.ready(name); }
  async recreate(spec: MachineSpec): Promise<Machine> {
    this.podNames.delete(spec.name);
    const path = `${this.sandboxes}/${encode(spec.name)}`;
    const existing = await this.resource(path);
    if (!existing) throw new Error(`Sandbox ${spec.name} disappeared`);
    const podTemplate = this.sandbox(spec).spec.podTemplate;
    await this.api(path, 'PUT', { ...existing, spec: { ...existing.spec, operatingMode: 'Running', podTemplate } });
    return this.ready(spec.name);
  }
  async stop(name: string) {
    this.podNames.delete(name);
    const s = await this.resource(`${this.sandboxes}/${encode(name)}`); if (!s) return;
    await this.api(`${this.sandboxes}/${encode(name)}`, 'PATCH', { spec: { operatingMode: 'Suspended' } });
    const podName = (await this.pod(s))?.metadata.name;
    if (podName) await this.wait(`${this.core}/pods`, podName, async p => !p);
    await this.wait(this.sandboxes, name, async current => !current || (await this.machine(current)).phase === 'stopped');
  }
  async remove(name: string, disk: string) {
    this.podNames.delete(name);
    const remove = async (collection: string, id: string) => {
      let deleted = true;
      try { await this.api(`${collection}/${encode(id)}`, 'DELETE', { propagationPolicy: 'Foreground' }); }
      catch (e) { if (e instanceof ApiError && e.code === 404) deleted = false; else throw e; }
      await this.wait(collection, id, async s => !s); return deleted;
    };
    const diskExisted = !!await this.resource(`${this.core}/persistentvolumeclaims/${encode(pvcName(name, disk))}`);
    const machineDeleted = await remove(this.sandboxes, name);
    const diskDeleted = await remove(`${this.core}/persistentvolumeclaims`, pvcName(name, disk));
    return { machineDeleted, diskDeleted: diskExisted || diskDeleted };
  }
  private async socket(name: string, action: string, query: URLSearchParams, protocols: string[]): Promise<WebSocket> {
    let pod = this.podNames.get(name);
    if (!pod) {
      const s = await this.resource(`${this.sandboxes}/${encode(name)}`);
      pod = s ? (await this.pod(s))?.metadata.name : undefined;
    }
    if (!pod) throw new Error(`No pod for ${name}`);
    const podName = pod;
    const invalidate = () => { if (this.podNames.get(name) === podName) this.podNames.delete(name); };
    const url = new URL(`${this.core}/pods/${encode(pod)}/${action}?${query}`, this.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols, { ca: this.ca, headers: { Authorization: this.authorization() }, handshakeTimeout: this.options.timeoutMs ?? 180000 });
      this.sockets.add(ws); ws.on('close', () => this.sockets.delete(ws));
      ws.once('open', () => { this.podNames.set(name, podName); ws.pause(); resolve(ws); }); ws.on('error', e => { invalidate(); reject(e); });
      ws.once('unexpected-response', (_req, res) => { invalidate(); ws.terminate(); reject(new ApiError(res.statusCode ?? 500, 'WebSocket upgrade refused')); });
    });
  }
  exec(start: ExecStart): ExecHandle {
    const output = new PassThrough({ objectMode: true });
    let ws: WebSocket | undefined; let canceled = false; let exited = false;
    const query = new URLSearchParams({ container: 'computer', stdin: 'true', stdout: 'true', stderr: 'true', tty: 'false' });
    start.command.forEach(c => query.append('command', c));
    const opened = (async () => {
      ws = await this.socket(start.machine, 'exec', query, ['v5.channel.k8s.io']).catch(cause => { throw new Error('Kubernetes exec requires an API server supporting v5.channel.k8s.io', { cause }); });
      if (canceled) { ws.close(); throw new Error('Exec canceled'); }
      ws.on('message', data => {
        try {
          const b = Buffer.from(data as Buffer);
          if (b[0] === 1 || b[0] === 2) output.write(b[0] === 1 ? { stdout: b.subarray(1) } : { stderr: b.subarray(1) });
          if (b[0] === 3) {
            const status = JSON.parse(b.subarray(1).toString());
            const cause = status.details?.causes?.find((c: { reason: string }) => c.reason === 'ExitCode');
            const code = status.status === 'Success' ? 0 : status.reason === 'NonZeroExitCode' && cause ? Number(cause.message) : NaN;
            if (!Number.isInteger(code)) throw new Error(`Exec status: ${b.subarray(1)}`);
            exited = true; output.end({ exit: code }); ws?.close();
          }
        } catch (e) { output.destroy(e instanceof Error ? e : new Error(String(e))); ws?.close(); }
      });
      ws.on('error', e => output.destroy(e));
      ws.on('close', () => { if (!exited) output.destroy(new Error('Exec closed without exit status')); });
      ws.resume();
      return ws;
    })();
    void opened.catch(e => output.destroy(e));
    return { events: output as AsyncIterable<ExecEvent>, writeStdin: async chunk => { const socket = await opened; await new Promise<void>((resolve, reject) => socket.send(Buffer.concat([Buffer.from([0]), chunk]), e => e ? reject(e) : resolve())); },
      endStdin: () => { void opened.then(s => s.send(Buffer.from([255, 0]))).catch(() => {}); },
      cancel: () => { canceled = true; ws?.close(); } };
  }
  connect(name: string, port: number): Duplex {
    let ws: WebSocket | undefined;
    const seen = new Set<number>();
    const opened = this.socket(name, 'portforward', new URLSearchParams({ ports: String(port) }), ['v4.channel.k8s.io', 'portforward.k8s.io']);
    const stream = new Duplex({ read() { ws?.resume(); }, write(chunk, _encoding, callback) { void opened.then(s => s.send(Buffer.concat([Buffer.from([0]), chunk]), callback)).catch(callback); }, final(callback) { ws?.close(); callback(); }, destroy(error, callback) { ws?.close(); callback(error); } });
    Object.assign(stream, { setNoDelay: () => stream, setKeepAlive: () => stream, setTimeout: () => stream, ref: () => stream, unref: () => stream });
    void opened.then(s => {
      ws = s; if (stream.destroyed) { s.close(); return; }
      s.on('message', data => {
        const b = Buffer.from(data as Buffer); const channel = b[0];
        let payload = b.subarray(1);
        if (!seen.has(channel)) { seen.add(channel); if (payload.length < 2) { stream.destroy(new Error('Missing port prefix')); return; } payload = payload.subarray(2); }
        if (channel === 1 && payload.length) stream.destroy(new Error(payload.toString()));
        else if (channel === 0 && !stream.push(payload)) s.pause();
      });
      s.on('error', e => stream.destroy(e)); s.on('close', () => stream.push(null)); s.resume();
    }).catch(e => stream.destroy(e));
    return stream;
  }
  close() { this.abort.abort(); for (const ws of this.sockets) ws.terminate(); }
}
