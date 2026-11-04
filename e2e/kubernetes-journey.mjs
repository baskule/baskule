#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createApi } from "./journeys/api.mjs";
import { Client, wsExchange } from "../computerd/test/client.ts";
import { namesFor } from "../computerd/src/policy.ts";

const namespace = process.env.BASKULE_K8S_NAMESPACE ?? "baskule";
const release = process.env.BASKULE_K8S_RELEASE ?? "baskule";
const evidence = resolve(process.env.BASKULE_K8S_EVIDENCE ?? ".run/evidence/kubernetes");
mkdirSync(evidence, { recursive: true });
const kube = (...args) => execFileSync("kubectl", ["-n", namespace, ...args], { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }).trim();
const objects = (...args) => JSON.parse(kube(...args, "-o", "json"));
const pass = message => { console.log(`PASS ${message}`); appendFileSync(resolve(evidence, "results.log"), `PASS ${message}\n`); };
const forwards = [];
async function forward(resource, remotePort, localPort = 0) {
  const child = spawn("kubectl", ["-n", namespace, "port-forward", "--address=127.0.0.1", resource, `${localPort}:${remotePort}`], { stdio: ["ignore", "pipe", "pipe"] });
  forwards.push(child);
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`port-forward ${resource} timed out`)), 30_000);
    child.once("exit", code => { clearTimeout(timer); fail(new Error(`port-forward ${resource} exited ${code}`)); });
    child.stdout.on("data", chunk => {
      const port = chunk.toString().match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); done(`http://127.0.0.1:${port}`); }
    });
    child.stderr.on("data", chunk => appendFileSync(resolve(privateDirectory, `${namespace}.port-forward.private.log`), chunk));
  });
}
async function rpc(person, space) {
  let result;
  await expect.poll(async () => {
    try { result = await person.rpc(space); return true; }
    catch { return false; }
  }, { timeout: 120_000, message: "space RPC becomes available after startup or lease recovery" }).toBe(true);
  return result;
}
async function ingressSession(signIn) {
  let session;
  await expect.poll(async () => {
    try { session = await signIn(); return true; }
    catch (error) {
      // GFE can still be converging after NEG registration. Refuse auth and
      // application errors; only retry load-balancer availability failures.
      const message = String(error);
      const edge404 = /: 404 /.test(message) && /<title>404 Not Found<\/title>/.test(message) && message.includes("The requested URL");
      if (!/: 50[234] /.test(message) && !edge404) throw error;
      return false;
    }
  }, { timeout: 180_000 }).toBe(true);
  return session;
}
async function checkIngress(publicUrl) {
  await expect.poll(async () => {
    try { return (await fetch(`${publicUrl}/api/baskule/setup`, { signal: AbortSignal.timeout(10_000) })).status; }
    catch { return 0; }
  }, { timeout: 600_000 }).toBe(200);
  const externalApi = createApi({ urls: { loopback: publicUrl, front: publicUrl }, admin });
  await ingressSession(() => externalApi.adminSession());
  const externalPerson = await ingressSession(() => externalApi.person("Ingress", randomBytes(4).toString("hex")));
  const externalClient = await rpc(externalPerson, externalApi.personalSpace(externalPerson));
  try {
    const externalProject = (await externalClient.ok("projects.ensureScratch", {})).projectId;
    const started = Date.now();
    const words = Array.from({ length: 400 }, (_, i) => `chunk${i}`).join(" ");
    const externalThread = await externalApi.launch(externalClient, externalProject, `[[fake:text LOAD_BALANCER_STREAM_OK ${words}]][[fake:delay 200]]`);
    const externalState = externalApi.watchThread(externalClient, externalThread);
    try {
      await externalApi.waitFor("load balancer text before completion", () => !externalState.settled() && externalState.assistantText().includes("LOAD_BALANCER_STREAM_OK"), 60_000);
      await externalApi.waitFor("WebSocket still streaming after 65 seconds", () => Date.now() - started >= 65_000 && !externalState.settled() && externalState.assistantUpdates >= 2, 90_000);
      const updates = externalState.assistantUpdates;
      await externalApi.waitFor("incremental delivery after 65 seconds", () => externalState.assistantUpdates > updates, 30_000);
      await externalApi.waitFor("load balancer streamed chat", () => externalState.settled() && externalState.assistantText().includes("LOAD_BALANCER_STREAM_OK"), 180_000);
      assert.ok([...externalState.runs.values()].every(run => run.status === "completed"));
      assert.ok(externalState.assistantUpdates >= 2, "incremental updates must traverse the public load balancer");
    } finally { externalState.stop(); }
    writeFileSync(resolve(evidence, "ingress-stream.json"), JSON.stringify({ elapsedMs: Date.now() - started, updates: externalState.assistantUpdates, visibleBeforeCompletion: true, deliveredAfter65Seconds: true }));
    pass("real Ingress load balancer keeps WebSocket and incremental chat streaming beyond 65 seconds");
    // Independent HTTP/SSE probe on the same Ingress, reusing its fake-LLM backend.
    const streamUrl = `${publicUrl}/v1/chat/completions`;
    const request = (text, stream) => fetch(streamUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-model", stream, messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(150_000),
    });
    await expect.poll(async () => {
      try {
        const response = await request("[[fake:text HTTP_STREAM_ROUTE_READY]]", false);
        return response.ok && (await response.json()).choices?.[0]?.message?.content === "HTTP_STREAM_ROUTE_READY";
      } catch { return false; }
    }, { timeout: 600_000, message: "GCE registers the fake-LLM streaming probe backend" }).toBe(true);
    const httpStarted = Date.now();
    const response = await request(`[[fake:text HTTP_STREAM_OK ${words}]][[fake:delay 200]]`, true);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    let text = "", firstContentMs, lateContent = false, contentChunks = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const part = decoder.decode(chunk, { stream: true });
      text += part;
      const elapsed = Date.now() - httpStarted;
      if (firstContentMs === undefined && text.includes("HTTP_STREAM_OK")) firstContentMs = elapsed;
      if (part.includes('"content"')) {
        contentChunks++;
        if (elapsed >= 65_000) lateContent = true;
      }
    }
    assert.ok(firstContentMs < 30_000, "HTTP content must arrive before the complete response can be buffered");
    assert.ok(lateContent && contentChunks >= 20, "HTTP content continues incrementally beyond 65 seconds");
    assert.match(text, /data: \[DONE\]/);
    writeFileSync(resolve(evidence, "ingress-http-stream.json"), JSON.stringify({ elapsedMs: Date.now() - httpStarted, firstContentMs, contentChunks, lateContent }));
    pass("same public Ingress delivers unbuffered HTTP SSE content before completion and beyond 65 seconds");
    if (process.env.BASKULE_K8S_JOURNEY === "ingress") {
      externalClient.close(); await externalClient.closed;
      const oldPod = objects("get", "pod", `${release}-celld-1`);
      kube("delete", "pod", `${release}-celld-1`, "--grace-period=0", "--force", "--wait=true");
      await expect.poll(() => {
        const replacement = objects("get", "pods", "-l", select("celld")).items.find(p => p.metadata.name === oldPod.metadata.name);
        return Boolean(replacement && replacement.metadata.uid !== oldPod.metadata.uid && replacement.status.conditions?.some(c => c.type === "Ready" && c.status === "True"));
      }, { timeout: 240_000 }).toBe(true);
      const signedIn = await ingressSession(() => externalApi.Person.signIn(externalPerson.email, externalPerson.password));
      const reconnected = await rpc(signedIn, externalApi.personalSpace(externalPerson));
      try {
        const recovered = externalApi.watchThread(reconnected, externalThread);
        try {
          await externalApi.waitFor("load balancer chat after celld replacement", () => recovered.assistantText().includes("LOAD_BALANCER_STREAM_OK"), 120_000);
        } finally { recovered.stop(); }
        pass("public Ingress sign-in and persisted chat recover after celld pod replacement");
      } finally { reconnected.close(); await reconnected.closed; }
    }
  } finally { externalClient.close(); await externalClient.closed; }
  // Security test: attacker-controlled earlier XFF entries must not avoid the edge bucket.
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`${publicUrl}/auth/sign-in/email`, {
      method: "POST", headers: { Origin: publicUrl, "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${i + 1}` },
      body: JSON.stringify({ email: externalPerson.email, password: "intentionally-wrong-password" }),
    });
    statuses.push(response.status); await response.body?.cancel();
  }
  assert.ok(statuses.includes(429), "changing forged XFF must not escape sign-in throttling");
  assert.equal(statuses.at(-1), 429);
  writeFileSync(resolve(evidence, "ingress-rate-limit.json"), JSON.stringify({ statuses, differentForgedXff: true, sharedBucketLimit: "GCE forwarding-rule IP; documented production limit" }));
  pass("public GCE sign-in rate limit cannot be bypassed with changing forged XFF entries");
}
const select = component => `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`;
// Keep retry credentials outside uploaded evidence; never print them.
const privateDirectory = resolve(".run/kubernetes-journey");
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const accountFile = resolve(privateDirectory, `${objects("get", "namespace", namespace).metadata.uid}.private.json`);
const admin = existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, "utf8")) : { email: "admin@kubernetes.test", password: randomBytes(24).toString("hex") };
writeFileSync(accountFile, JSON.stringify(admin), { mode: 0o600 });
let client;
try {
  const diagnose = kube("exec", `${release}-celld-0`, "--", "sh", "-ec", 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"');
  writeFileSync(resolve(evidence, "rustfs-diagnose.jsonl"), diagnose);
  const diagnosis = diagnose.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.ok(diagnosis.length > 0, "diagnose must return checks");
  assert.ok(diagnosis.every(check => check.verdict !== "fail"));
  assert.equal(diagnosis.find(check => check.check === "bucket conditional write")?.verdict, "ok");
  const fleet = diagnosis.find(check => check.check === "fleet");
  const replicas = objects("get", "statefulset", `${release}-celld`).spec.replicas;
  assert.equal(fleet?.verdict, "ok");
  assert.equal(fleet.detail, `${replicas} node lease(s) enumerated`);
  pass("celld diagnose verifies RustFS conditional writes and the two-node fleet");
  const publicUrl = process.env.BASKULE_K8S_PUBLIC_URL ?? "http://127.0.0.1:47090";
  // Route initial cell activations to the ordinal used by the later crash drill.
  const base = await forward(`pod/${release}-celld-1`, 47091, Number(new URL(publicUrl).port));
  const localPort = Number(new URL(base).port);
  const secretName = process.env.BASKULE_K8S_SECRET ?? `${release}-secrets`;
  const secret = objects("get", "secret", secretName).data;
  const token = Buffer.from(secret.SETUP_TOKEN, "base64").toString();
  const setup = await (await fetch(`${base}/api/baskule/setup`)).json();
  if (setup.required) {
    const result = await fetch(`${base}/api/baskule/setup`, {
      method: "POST", headers: { Origin: publicUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ ...admin, name: "Kubernetes admin", token }),
    });
    assert.equal(result.status, 201, "first-admin setup");
    pass("setup link creates the first admin");
  }
  const api = createApi({ urls: { loopback: base, front: base }, admin });
  const person = await api.adminSession();
  pass("admin password sign-in works");
  const { apiKeyConfigured: _key, transcriptionApiKeyConfigured: _voice, authentication: _auth, ...settings } = await person.json("GET", "/api/baskule/admin/settings");
  await person.json("PATCH", "/api/baskule/admin/settings", {
    ...settings, apiKey: "fake-llm-key",
    ai: { providerId: "custom", baseUrl: "http://fake-llm:47601/v1", model: { id: "fake-model", name: "fake-model", image: true, pdf: true, limit: { context: 200_000, output: 16_000 }, settings: {} } },
  });
  const selection = process.env.BASKULE_K8S_JOURNEY ?? "full";
  assert.ok(["full", "ingress", "failover"].includes(selection), "journey selection: full, ingress or failover");
  if (selection === "ingress") {
    await checkIngress(publicUrl);
    writeFileSync(resolve(evidence, "summary.json"), JSON.stringify({ at: new Date().toISOString(), selection, ingress: true }));
  } else {
    const chatting = await api.person("Kubernetes", randomBytes(4).toString("hex"));
    const space = api.personalSpace(chatting);
    client = await rpc(chatting, space);
    const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
    const thread = await api.launch(client, projectId, "[[fake:text KUBERNETES_STREAM_OK alpha beta gamma delta epsilon]][[fake:delay 200]]");
    const state = api.watchThread(client, thread);
    await api.waitFor("streamed fake chat", () => state.settled() && state.assistantText().includes("KUBERNETES_STREAM_OK"), 180_000);
    assert.ok([...state.runs.values()].every(run => run.status === "completed"));
    assert.ok(state.assistantUpdates >= 2, "multiple assistant updates prove incremental streaming");
    state.stop();
    pass("fake chat streams through the platform WebSocket");
    const coldNodeImages = objects("get", "nodes").items.flatMap(node => node.status.images ?? []).flatMap(image => image.names);
    const cold = !coldNodeImages.some(name => name.includes("/baskule-computer:"));
    if (process.env.BASKULE_K8S_CROSS_NODE === "1") assert.ok(cold, "first computer must pull onto a cold GKE node");
    const toolThread = await api.launch(client, projectId, '[[fake:tool shell {"command":"printf KUBERNETES_DISK_OK > /sandbox/space/kubernetes-proof.txt; cat /sandbox/space/kubernetes-proof.txt"}]]');
    const tool = api.watchThread(client, toolThread);
    await api.waitFor("computer exec", () => tool.settled() && tool.assistantText().includes("KUBERNETES_DISK_OK"), 300_000);
    tool.stop();
    const files = () => client.ok("projects.readFile", { cwd: "/sandbox/space", relativePath: "kubernetes-proof.txt" });
    assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
    pass("platform invokes computerd and writes verified file bytes on a Kubernetes computer");
    const computerdPod = objects("get", "pods", "-l", select("computerd")).items[0].metadata.name;
    const ready = kube("logs", computerdPod).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(line => line.msg === "computer ready" && line.spaceId === space);
    assert.ok(ready && ready.created && ready.ms > 0, "record the first creating ensure, not a later retry");
    writeFileSync(resolve(evidence, "computer-startup.json"), JSON.stringify({ coldNode: cold, firstEnsureCreated: ready.created, readyMs: ready.ms, timeoutMs: 180_000 }));
    assert.ok(ready.ms < 144_000, "cold start must leave at least 20% of the 180-second readiness budget");
    pass(`computer startup took ${ready.ms} ms (cold node: ${cold})`);
    // Run through the actual HTTP API from the celld trust domain. No extra public service.
    const celldPod = `${release}-celld-0`;
    function computer(action) {
      return execFileSync("kubectl", ["-n", namespace, "exec", "-i", celldPod, "--", "sh", "-ec", 'read -r token; curl -fsS --max-time 180 -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "{}" "http://$1-computerd:47094/v1/spaces/$2/computer/$3"', "sh", release, space, action], {
        input: Buffer.from(secret.COMPUTERD_TOKEN, "base64").toString() + "\n", encoding: "utf8", timeout: 190_000,
      });
    }
    if (selection === "full") {
      computer("stop");
      computer("ensure");
      assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
      pass("per-space PVC preserves file bytes after computer stop/start");
      const sandbox = objects("get", "sandboxes", namesFor(space, release).sandbox);
      const computerPods = () => objects("get", "pods", "-l", "baskule.computer=true").items.filter(pod => pod.metadata.ownerReferences?.some(owner => owner.uid === sandbox.metadata.uid));
      const pods = computerPods();
      assert.equal(pods.length, 1);
      const pod = pods[0];
      const computerPvcs = () => objects("get", "pvc").items.filter(pvc => pvc.metadata.ownerReferences?.some(owner => owner.uid === sandbox.metadata.uid)).map(pvc => pvc.metadata.uid).sort();
      const pvcBefore = computerPvcs();
      assert.ok(pvcBefore.length > 0);
      if (process.env.BASKULE_K8S_CROSS_NODE === "1") kube("cordon", pod.spec.nodeName);
      try {
        kube("delete", "pod", pod.metadata.name, "--wait=true");
        await expect.poll(() => {
          // The next use wakes a Sandbox suspended after its workload pod vanished.
          try { computer("ensure"); } catch { return false; }
          const replacement = computerPods()[0];
          return Boolean(replacement && replacement.metadata.uid !== pod.metadata.uid && replacement.status.conditions?.some(c => c.type === "Ready" && c.status === "True"));
        }, { timeout: 240_000 }).toBe(true);
        if (process.env.BASKULE_K8S_CROSS_NODE === "1") {
          assert.notEqual(computerPods()[0].spec.nodeName, pod.spec.nodeName);
        }
        computer("ensure");
        assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
        assert.deepEqual(computerPvcs(), pvcBefore);
        pass("replacement computer pod mounts the same PVC and preserves file bytes");
      } finally {
        if (process.env.BASKULE_K8S_CROSS_NODE === "1") kube("uncordon", pod.spec.nodeName);
      }
      // A network-policy-enforced workload cannot dial any peer, S3 or private IP.
      const workload = computerPods()[0];
      const probe = 'const net=require("net");const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));s.setTimeout(3000,()=>{s.destroy();process.exit(0)});';
      for (const [host, port] of [
        [objects("get", "pod", celldPod).status.podIP, "47092"],
        [objects("get", "svc", `${release}-rustfs`).spec.clusterIP, "3900"],
        ["169.254.169.254", "80"],
        ["metadata.google.internal", "80"],
        [objects("get", "svc", release).spec.clusterIP, "80"],
        [objects("get", "svc", `${release}-computerd`).spec.clusterIP, "47094"],
        [workload.status.hostIP, "10250"],
      ]) kube("exec", workload.metadata.name, "--", "node", "-e", probe, host, port);
      pass("NetworkPolicy blocks direct computer access to peer, S3 and metadata IPs");
      if (process.env.BASKULE_K8S_CROSS_NODE === "1") {
        kube("exec", celldPod, "--", "curl", "-fsS", "--max-time", "10", "-H", "Metadata-Flavor: Google", "-o", "/dev/null", "http://169.254.169.254/computeMetadata/v1/");
        pass("GKE metadata server exists and is reachable from the trusted platform");
      }
      // Exercise the same network isolation through the product exec API.
      const computerApi = new Client(await forward(`service/${release}-computerd`, 47094), Buffer.from(secret.COMPUTERD_TOKEN, "base64").toString());
      const publicControl = await computerApi.exec(space, { argv: ["curl", "-fsS", "--max-time", "20", "https://example.com/"] });
      assert.equal(publicControl.code, 0, publicControl.stderr);
      const apiService = JSON.parse(execFileSync("kubectl", ["-n", "default", "get", "service", "kubernetes", "-o", "json"], { encoding: "utf8" })).spec.clusterIP;
      for (const target of [
        `https://${apiService}:443/`,
        `http://${objects("get", "svc", release).spec.clusterIP}:80/api/baskule/setup`,
        `http://${release}:80/api/baskule/setup`,
        `http://${objects("get", "svc", `${release}-rustfs`).spec.clusterIP}:3900/`,
        "http://169.254.169.254/computeMetadata/v1/",
      ]) {
        const denied = await computerApi.exec(space, { argv: ["curl", "--silent", "--show-error", "--max-time", "10", "--insecure", "-H", "X-Forwarded-For: 198.51.100.1", target] });
        assert.notEqual(denied.code, 0, `NetworkPolicy must deny ${target}`);
        assert.equal(denied.stdout, "", "no protected response body may escape");
      }
      pass("computer curl permits public HTTPS and denies Kubernetes API, platform Service, RustFS and metadata");
      const cdp = await wsExchange(computerApi.ws(`/v1/spaces/${space}/cdp`), [JSON.stringify({ id: 1, method: "Target.getTargets" })], messages => messages.some(message => message.includes('"id":1')), 60_000);
      const targets = JSON.parse(cdp.msgs.find(message => message.includes('"id":1'))).result.targetInfos;
      assert.ok(targets.some(target => target.type === "page"));
      pass("computer Chromium responds through the real CDP WebSocket tunnel");
      if (process.env.BASKULE_K8S_CROSS_NODE === "1") {
        const claim = objects("get", "pvc").items.find(p => p.metadata.ownerReferences?.some(o => o.uid === sandbox.metadata.uid));
        assert.ok(claim);
        const snapshotName = "restore-proof";
        const apply = object => execFileSync("kubectl", ["-n", namespace, "apply", "-f", "-"], { input: JSON.stringify(object), encoding: "utf8" });
        const command = async argv => {
          const r = await computerApi.exec(space, { argv });
          assert.equal(r.code, 0, r.stderr); return r.stdout;
        };
        await command(["sh", "-c", "mkdir -p /sandbox/space/restore-proof; printf snapshot-proof > /sandbox/space/restore-proof/a; printf second-file > /sandbox/space/restore-proof/b; sync"]);
        const hashes = () => command(["sh", "-c", "cd /sandbox/space/restore-proof && sha256sum a b"]);
        const beforeHashes = await hashes();
        computer("stop");
        apply({ apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshotClass", metadata: { name: "baskule-proof" }, driver: "pd.csi.storage.gke.io", deletionPolicy: "Delete" });
        try {
          apply({ apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot", metadata: { name: snapshotName }, spec: { volumeSnapshotClassName: "baskule-proof", source: { persistentVolumeClaimName: claim.metadata.name } } });
          await expect.poll(() => objects("get", "volumesnapshot", snapshotName).status?.readyToUse, { timeout: 240_000 }).toBe(true);
          await computerApi.json("POST", `/v1/spaces/${space}/computer/delete`, { confirm: space });
          assert.equal(objects("get", "pvc").items.some(p => p.metadata.name === claim.metadata.name), false);
          apply({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: claim.metadata.name, annotations: { "agents.x-k8s.io/adoptable": "true" } }, spec: { accessModes: claim.spec.accessModes, storageClassName: claim.spec.storageClassName, resources: claim.spec.resources, dataSource: { apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: snapshotName } } });
          computer("ensure");
          assert.equal(await hashes(), beforeHashes);
          writeFileSync(resolve(evidence, "restore.json"), JSON.stringify({ pvc: claim.metadata.name, hashes: beforeHashes, restored: true }));
          pass("VolumeSnapshot restores known files into the original PVC name after Sandbox and PVC deletion");
        } finally {
          kube("delete", "volumesnapshot", snapshotName, "--ignore-not-found", "--timeout=180s");
        }
      }

    }
    if (process.env.BASKULE_K8S_CHECK_INGRESS === "1") await checkIngress(publicUrl);
    // Keep the killed ordinal unavailable until another celld owns its cells.
    const victim = `${release}-celld-1`;
    const peer = async name => {
      const url = await forward(`pod/${name}`, 47092);
      return await (await fetch(`${url}/state`)).json();
    };
    const before = await peer(victim);
    writeFileSync(resolve(evidence, "celld-before.json"), JSON.stringify(before));
    assert.ok(before.owned_cells > 0, "the killed pod must own cells for this drill");
    kube("patch", "statefulset", `${release}-celld`, "--type=merge", "-p", JSON.stringify({ spec: { template: { spec: { nodeSelector: { "baskule.test/unavailable": "true" } } } } }));
    kube("delete", "pod", victim, "--grace-period=0", "--force", "--wait=false");
    client.close(); await client.closed;
    const initialForward = forwards[0];
    if (initialForward.exitCode === null) {
      const exited = new Promise(done => initialForward.once("exit", done));
      initialForward.kill("SIGTERM");
      await exited;
    }
    await forward(`pod/${celldPod}`, 47091, localPort);
    client = await rpc(chatting, space);
    const recovered = api.watchThread(client, thread);
    await api.waitFor("chat after owner loss", () => recovered.assistantText().includes("KUBERNETES_STREAM_OK"), 120_000);
    recovered.stop();
    assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
    const after = await peer(celldPod);
    writeFileSync(resolve(evidence, "celld-after.json"), JSON.stringify(after));
    assert.ok(before.residents.some(cell => after.residents.includes(cell)), "a cell resident on the killed peer is now resident on the survivor");
    pass("killed celld owner stays unavailable while another pod serves persisted chat and computer files");
    kube("patch", "statefulset", `${release}-celld`, "--type=json", "-p", '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]');
    kube("delete", "pod", victim, "--wait=true", "--ignore-not-found=true");
    kube("rollout", "status", `statefulset/${release}-celld`, "--timeout=180s");
    const sandboxName = namesFor(space, release).sandbox;
    const workspace = objects("get", "pvc", `${namesFor(space, release).volume}-${sandboxName}`);
    client.close(); await client.closed; client = undefined;
    await person.json("DELETE", `/api/baskule/spaces/${space}`);
    await expect.poll(() => objects("get", "pvc").items.some(pvc => pvc.metadata.uid === workspace.metadata.uid), { timeout: 180_000 }).toBe(false);
    await expect.poll(() => objects("get", "sandboxes").items.some(sandbox => sandbox.metadata.name === sandboxName), { timeout: 180_000 }).toBe(false);
    pass("deleting a space removes its Sandbox and actual workspace PVC");
    writeFileSync(resolve(evidence, "summary.json"), JSON.stringify({ at: new Date().toISOString(), selection, spacePvcDeleted: true, computerPodReplaced: selection === "full", crossNode: selection === "full" && process.env.BASKULE_K8S_CROSS_NODE === "1", celldTakeover: true, computerdPod }));
  }
} finally {
  if (client) { client.close(); await client.closed; }
  for (const child of forwards) child.kill("SIGTERM");
}
