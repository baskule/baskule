#!/usr/bin/env bash
# Validate release and source definitions without requiring an operator's private .env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/.run"
work=$(mktemp -d "$ROOT/.run/compose-config.XXXXXX")
trap 'rm -rf "$work"' EXIT
file="$ROOT/deploy/docker-compose.yml"
example="$ROOT/deploy/.env.example"
cp "$file" "$work/docker-compose.yml"
(cd "$work" && docker compose --profile '*' config -q)
echo 'PASS compose config: empty installation with only docker-compose.yml'
node --input-type=module - "$file" "$work" <<'JS'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [file, directory] = process.argv.slice(2);
const config = (env = {}, profiles = []) => JSON.parse(execFileSync("docker", ["compose", "--project-directory", directory, "-f", file, ...profiles, "config", "--format", "json"], {
  env: { ...process.env, ...env }, encoding: "utf8",
}));
writeFileSync(join(directory, ".env"), "E2E_LOGIN_PASSWORD=must-not-reach-setup\n");
const http = config();
assert.equal(http.networks["baskule-net"].ipam?.config, undefined, "let Docker choose a non-overlapping network");
assert.equal(http.services["baskule-edge"].environment.BASKULE_TRUSTED_PROXIES, "");
assert.deepEqual(http.services["baskule-edge"].ports.map(p => [p.host_ip, p.published, p.target]), [["127.0.0.1", "47090", 47090]]);
assert.equal(http.services.setup.env_file, undefined);
assert.equal(http.services.setup.environment.E2E_LOGIN_PASSWORD, undefined);
assert.equal(http.services.setup.environment.PUBLIC_URL, "http://127.0.0.1:47090");
assert.equal(http.services["baskule-deploy"].environment.SETUP_STATUS_URL, "");
assert.equal(http.services["edge-http"], undefined);
assert.equal(http.services["edge-https"], undefined);
const https = config({ BASKULE_EDGE: "https", BASKULE_DOMAIN: "baskule.example.com", BASKULE_BIND: "127.0.0.1" });
assert.deepEqual(https.services["baskule-edge"].ports.map(p => [p.host_ip, p.target, p.protocol]), [[undefined, 80, "tcp"], [undefined, 443, "tcp"], [undefined, 443, "udp"]]);
assert.equal(https.services.setup.environment.BASKULE_EDGE, "https");
assert.equal(https.services.setup.environment.BASKULE_DOMAIN, "baskule.example.com");
const traces = config({ BASKULE_EDGE: "https", BASKULE_DOMAIN: "baskule.example.com", BASKULE_BIND: "0.0.0.0" }, ["--profile", "traces"]);
assert.equal(traces.services["baskule-traces"].ports[0].host_ip, "127.0.0.1");
const tracesOverride = config({ BASKULE_TRACES_BIND: "192.0.2.10" }, ["--profile", "traces"]);
assert.equal(tracesOverride.services["baskule-traces"].ports[0].host_ip, "192.0.2.10");
assert.equal(https.services.setup.environment.PUBLIC_URL, "https://baskule.example.com");
assert.equal(https.services["baskule-edge"].environment.BASKULE_SITE, "baskule.example.com :47090");
const proxy = config({ BASKULE_PORT: "48090", BASKULE_TRUSTED_PROXIES: "192.0.2.5/32" });
assert.equal(proxy.services.setup.environment.PUBLIC_URL, "http://127.0.0.1:48090");
assert.equal(proxy.services["baskule-edge"].environment.BASKULE_TRUSTED_PROXIES, "192.0.2.5/32");
console.log("PASS compose listeners: loopback HTTP, automatic HTTPS, explicit proxy trust and setup isolation");
JS
cp "$example" "$work/.env"
docker compose --project-directory "$work" --env-file "$work/.env" -f "$file" --profile '*' config -q
printf 'PASS compose config: %s\n' "${file#"$ROOT/"}"
docker compose --project-directory "$work" --env-file "$work/.env" -f "$file" \
  -f "$ROOT/deploy/docker-compose.build.yml" --profile '*' config -q
echo 'PASS compose config: deploy/docker-compose.build.yml with release base'
