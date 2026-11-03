#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { createApi } from "./journeys/api.mjs";
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
    child.stderr.on("data", () => {});
  });
}
async function rpc(person, space) {
  let result, error;
  person.rpc(space).then(value => { result = value; }, value => { error = value; });
  await expect.poll(() => { if (error) throw error; return Boolean(result); }, { timeout: 60_000 }).toBe(true);
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
  const diagnose = kube("exec", `${release}-celld-0`, "--", "sh", "-ec", 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"');
  writeFileSync(resolve(evidence, "rustfs-diagnose.jsonl"), diagnose);
  assert.ok(!diagnose.split("\n").filter(line => line.startsWith("{")).some(line => JSON.parse(line).verdict === "fail"));
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
  const toolThread = await api.launch(client, projectId, '[[fake:tool shell {"command":"printf KUBERNETES_DISK_OK > /sandbox/space/kubernetes-proof.txt; cat /sandbox/space/kubernetes-proof.txt"}]]');
  const tool = api.watchThread(client, toolThread);
  await api.waitFor("computer exec", () => tool.settled() && tool.assistantText().includes("KUBERNETES_DISK_OK"), 300_000);
  tool.stop();
  const files = () => client.ok("projects.readFile", { cwd: "/sandbox/space", relativePath: "kubernetes-proof.txt" });
  assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
  pass("platform invokes computerd and writes verified file bytes on a Kubernetes computer");
  const computerdPod = objects("get", "pods", "-l", select("computerd")).items[0].metadata.name;
  // Run through the actual HTTP API from the celld trust domain. No extra public service.
  const celldPod = `${release}-celld-0`;
  function computer(action) {
    return execFileSync("kubectl", ["-n", namespace, "exec", "-i", celldPod, "--", "sh", "-ec", 'read -r token; curl -fsS --max-time 180 -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "{}" "http://$1-computerd:47094/v1/spaces/$2/computer/$3"', "sh", release, space, action], {
      input: Buffer.from(secret.COMPUTERD_TOKEN, "base64").toString() + "\n", encoding: "utf8", timeout: 190_000,
    });
  }
  computer("stop");
  computer("ensure");
  assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
  pass("per-space PVC preserves file bytes after computer stop/start");
  const sandbox = objects("get", "sandboxes", `default--${namesFor(space, release).sandbox}`);
  const workloadSelector = `openshell.ai/boundary-role=workload,openshell.ai/boundary-pair=${sandbox.metadata.labels["openshell.ai/sandbox-id"]}`;
  const pods = objects("get", "pods", "-l", workloadSelector).items;
  assert.equal(pods.length, 1);
  const pod = pods[0];
  const pvcBefore = objects("get", "pvc").items.map(pvc => pvc.metadata.uid).sort();
  if (process.env.BASKULE_K8S_CROSS_NODE === "1") kube("cordon", pod.spec.nodeName);
  try {
    kube("delete", "pod", pod.metadata.name, "--wait=true");
    await expect.poll(() => {
      // The next use wakes a Sandbox suspended after its workload pod vanished.
      try { computer("ensure"); } catch { return false; }
      const replacement = objects("get", "pods", "-l", workloadSelector).items[0];
      return Boolean(replacement && replacement.metadata.uid !== pod.metadata.uid && replacement.status.conditions?.some(c => c.type === "Ready" && c.status === "True"));
    }, { timeout: 240_000 }).toBe(true);
    if (process.env.BASKULE_K8S_CROSS_NODE === "1") {
      assert.notEqual(objects("get", "pods", "-l", workloadSelector).items[0].spec.nodeName, pod.spec.nodeName);
    }
    computer("ensure");
    assert.match(JSON.stringify(await files()), /KUBERNETES_DISK_OK/);
    assert.deepEqual(objects("get", "pvc").items.map(pvc => pvc.metadata.uid).sort(), pvcBefore);
    pass("replacement computer pod mounts the same PVC and preserves file bytes");
  } finally {
    if (process.env.BASKULE_K8S_CROSS_NODE === "1") kube("uncordon", pod.spec.nodeName);
  }
  // A network-policy-enforced workload cannot dial any peer, S3 or private IP.
  const workload = objects("get", "pods", "-l", workloadSelector).items[0];
  const probe = 'const net=require("net");const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));s.setTimeout(3000,()=>{s.destroy();process.exit(0)});';
  for (const [host, port] of [
    [objects("get", "pod", celldPod).status.podIP, "47092"],
    [objects("get", "svc", `${release}-rustfs`).spec.clusterIP, "3900"],
    ["169.254.169.254", "80"],
  ]) kube("exec", workload.metadata.name, "--", "node", "-e", probe, host, port);
  pass("NetworkPolicy blocks direct computer access to peer, S3 and metadata IPs");
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
  if (process.env.BASKULE_K8S_CHECK_INGRESS === "1") {
    await expect.poll(async () => {
      try { return (await fetch(`${publicUrl}/api/baskule/setup`, { signal: AbortSignal.timeout(10_000) })).status; }
      catch { return 0; }
    }, { timeout: 600_000 }).toBe(200);
    const externalApi = createApi({ urls: { loopback: publicUrl, front: publicUrl }, admin });
    await externalApi.adminSession();
    const externalPerson = await externalApi.person("Ingress", randomBytes(4).toString("hex"));
    const externalClient = await rpc(externalPerson, externalApi.personalSpace(externalPerson));
    try {
      const externalProject = (await externalClient.ok("projects.ensureScratch", {})).projectId;
      const externalThread = await externalApi.launch(externalClient, externalProject, "[[fake:text LOAD_BALANCER_STREAM_OK alpha beta gamma delta epsilon]][[fake:delay 200]]");
      const externalState = externalApi.watchThread(externalClient, externalThread);
      try {
        await externalApi.waitFor("load balancer streamed chat", () => externalState.settled() && externalState.assistantText().includes("LOAD_BALANCER_STREAM_OK"), 180_000);
        assert.ok([...externalState.runs.values()].every(run => run.status === "completed"));
        assert.ok(externalState.assistantUpdates >= 2, "incremental updates must traverse the public load balancer");
      } finally { externalState.stop(); }
      pass("real Ingress load balancer serves sign-in and incremental fake chat over WebSocket");
    } finally { externalClient.close(); await externalClient.closed; }
  }
  writeFileSync(resolve(evidence, "summary.json"), JSON.stringify({ at: new Date().toISOString(), computerPodReplaced: true, crossNode: process.env.BASKULE_K8S_CROSS_NODE === "1", celldTakeover: true, computerdPod }));
} finally {
  if (client) { client.close(); await client.closed; }
  for (const child of forwards) child.kill("SIGTERM");
}
