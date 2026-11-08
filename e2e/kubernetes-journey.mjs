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
const select = component => `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`;
// Keep retry credentials outside uploaded evidence; never print them.
const privateDirectory = resolve(".run/kubernetes-journey");
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const accountFile = resolve(privateDirectory, `${objects("get", "namespace", namespace).metadata.uid}.private.json`);
const admin = existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, "utf8")) : { email: "admin@kubernetes.test", password: randomBytes(24).toString("hex") };
writeFileSync(accountFile, JSON.stringify(admin), { mode: 0o600 });
let client;
try {
  const diagnoseStarted = Date.now();
  const diagnose = kube("exec", `${release}-celld-0`, "--", "sh", "-ec", 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"');
  writeFileSync(resolve(evidence, "s3-diagnose.jsonl"), diagnose);
  const diagnoseMs = Date.now() - diagnoseStarted;
  const diagnosis = diagnose.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.ok(diagnosis.length > 0, "diagnose must return checks");
  assert.ok(diagnosis.every(check => check.verdict !== "fail"));
  assert.equal(diagnosis.find(check => check.check === "bucket conditional write")?.verdict, "ok");
  const fleet = diagnosis.find(check => check.check === "fleet");
  const replicas = objects("get", "statefulset", `${release}-celld`).spec.replicas;
  assert.equal(fleet?.verdict, "ok");
  assert.equal(fleet.detail, `${replicas} node lease(s) enumerated`);
  pass("celld diagnose verifies S3 conditional writes and the two-node fleet");
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
  assert.ok(["full", "failover"].includes(selection), "journey selection: full or failover");
  {
    const chatting = await api.person("Kubernetes", randomBytes(4).toString("hex"));
    const space = api.personalSpace(chatting);
    client = await rpc(chatting, space);
    const projectId = (await client.ok("projects.ensureScratch", {})).projectId;
    const chatStarted = Date.now();
    const thread = await api.launch(client, projectId, "[[fake:text KUBERNETES_STREAM_OK alpha beta gamma delta epsilon]][[fake:delay 200]]");
    const state = api.watchThread(client, thread);
    await api.waitFor("streamed fake chat", () => state.settled() && state.assistantText().includes("KUBERNETES_STREAM_OK"), 180_000);
    assert.ok([...state.runs.values()].every(run => run.status === "completed"));
    assert.ok(state.assistantUpdates >= 2, "multiple assistant updates prove incremental streaming");
    state.stop();
    const chatMs = Date.now() - chatStarted;
    pass("fake chat streams through the platform WebSocket");
    const coldNodeImages = objects("get", "nodes").items.flatMap(node => node.status.images ?? []).flatMap(image => image.names);
    const cold = !coldNodeImages.some(name => name.includes("/baskule-computer:"));
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
      if (process.env.BASKULE_K8S_CROSS_NODE === "1") {
        kube("cordon", pod.spec.nodeName);
      }
      const moveStarted = performance.now();
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
        writeFileSync(resolve(evidence, "node-move.json"), JSON.stringify({ elapsedMs: performance.now() - moveStarted, from: pod.spec.nodeName, to: computerPods()[0].spec.nodeName }));
        pass("replacement computer pod mounts the same PVC and preserves file bytes");
      } finally {
        if (process.env.BASKULE_K8S_CROSS_NODE === "1") kube("uncordon", pod.spec.nodeName);
      }
      // A network-policy-enforced workload cannot dial any peer, S3 or private IP.
      const workload = computerPods()[0];
      const probe = 'const net=require("net");const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));s.setTimeout(3000,()=>{s.destroy();process.exit(0)});';
      for (const [host, port] of [
        [objects("get", "pod", celldPod).status.podIP, "47092"],
        ...(process.env.BASKULE_K8S_S3_FIXTURE ? [[objects("get", "svc", process.env.BASKULE_K8S_S3_FIXTURE).spec.clusterIP, "3900"]] : []),
        ["169.254.169.254", "80"],
        [objects("get", "svc", release).spec.clusterIP, "80"],
        [objects("get", "svc", `${release}-computerd`).spec.clusterIP, "47094"],
        [workload.status.hostIP, "10250"],
      ]) kube("exec", workload.metadata.name, "--", "node", "-e", probe, host, port);
      pass(`NetworkPolicy blocks direct computer access to peer${process.env.BASKULE_K8S_S3_FIXTURE ? ", S3" : ""} and metadata IPs`);
      // Exercise the same network isolation through the product exec API.
      const computerApi = new Client(await forward(`service/${release}-computerd`, 47094), Buffer.from(secret.COMPUTERD_TOKEN, "base64").toString());
      const publicControl = await computerApi.exec(space, { argv: ["curl", "-fsS", "--max-time", "20", "https://example.com/"] });
      assert.equal(publicControl.code, 0, publicControl.stderr);
      const sshControl = await computerApi.exec(space, { argv: ["node", "-e", "const s=require('net').connect(22,'github.com');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(20000,()=>process.exit(2))"] });
      assert.equal(sshControl.code, 0, sshControl.stderr);
      pass("computer DNS, public HTTPS and public TCP 22 work");

      const apiService = JSON.parse(execFileSync("kubectl", ["-n", "default", "get", "service", "kubernetes", "-o", "json"], { encoding: "utf8" })).spec.clusterIP;
      for (const target of [
        `https://${apiService}:443/`,
        `http://${objects("get", "svc", release).spec.clusterIP}:80/api/baskule/setup`,
        `http://${release}:80/api/baskule/setup`,
        ...(process.env.BASKULE_K8S_S3_FIXTURE ? [`http://${objects("get", "svc", process.env.BASKULE_K8S_S3_FIXTURE).spec.clusterIP}:3900/`] : []),
        "http://169.254.169.254/",
      ]) {
        const denied = await computerApi.exec(space, { argv: ["curl", "--silent", "--show-error", "--max-time", "10", "--insecure", "-H", "X-Forwarded-For: 198.51.100.1", target] });
        assert.notEqual(denied.code, 0, `NetworkPolicy must deny ${target}`);
        assert.equal(denied.stdout, "", "no protected response body may escape");
      }
      pass(`computer curl permits public HTTPS and denies Kubernetes API, platform Service${process.env.BASKULE_K8S_S3_FIXTURE ? ", S3 fixture" : ""} and metadata`);
      const cdp = await wsExchange(computerApi.ws(`/v1/spaces/${space}/cdp`), [JSON.stringify({ id: 1, method: "Target.getTargets" })], messages => messages.some(message => message.includes('"id":1')), 60_000);
      const targets = JSON.parse(cdp.msgs.find(message => message.includes('"id":1'))).result.targetInfos;
      assert.ok(targets.some(target => target.type === "page"));
      pass("computer Chromium responds through the real CDP WebSocket tunnel");
    }
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
    const failoverStarted = Date.now();
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
    writeFileSync(resolve(evidence, "storage-timings.json"), JSON.stringify({ diagnoseMs, chatMs, failoverMs: Date.now() - failoverStarted }));
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
