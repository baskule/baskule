import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "native-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "scripts/ci"), { recursive: true });
  mkdirSync(resolve(root, "app"));
  mkdirSync(resolve(root, "bin"));
  for (const name of ["native-signing-source.sh", "native-desktop.sh", "native-version.sh", "verify-macos.sh"]) {
    cpSync(new URL(name, import.meta.url), resolve(root, "scripts/ci", name));
  }
  writeFileSync(resolve(root, "VERSION"), "1.2.3\n");
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TMPDIR: root };
  for (const key of Object.keys(env)) {
    if (/^(APPLE_|CSC_|MACOS_|T3CODE_CLERK_|T3CODE_MACOS_|NATIVE_|GITHUB_|SIGN_ALL)/.test(key)) delete env[key];
  }
  const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  const stub = (name, content) => writeFileSync(resolve(root, "bin", name), `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`, { mode: 0o755 });
  return { root, run, stub };
}

test("signing accepts main dispatches and matching main tags, rejects other sources", t => {
  const { root, run } = fixture(t);
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const source = (event, ref, extra = {}) => run("bash", ["scripts/ci/native-signing-source.sh"], { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, ...extra });
  assert.equal(source("workflow_dispatch", "refs/heads/main").status, 0);
  assert.equal(source("push", "refs/tags/v1.2.3").status, 0);
  for (const result of [
    source("workflow_dispatch", "refs/heads/feature"),
    source("workflow_dispatch", "refs/tags/v1.2.3"),
    source("pull_request", "refs/pull/1/merge"),
    source("push", "refs/tags/v9.9.9"),
    source("push", "refs/tags/v1.2.3", { NATIVE_VERSION: "9.9.9" }),
    source("push", "refs/tags/v1.2.3", { SIGN_ALL: "true" }),
  ]) assert.notEqual(result.status, 0, result.stdout);
  writeFileSync(resolve(root, "VERSION"), "not-semver\n");
  assert.notEqual(source("push", "refs/tags/vnot-semver").status, 0);
  writeFileSync(resolve(root, "VERSION"), "1.2.3\n");
  git("checkout", "-b", "untrusted");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "untrusted");
  const offMain = source("push", "refs/tags/v1.2.3");
  assert.notEqual(offMain.status, 0);
  assert.match(offMain.stderr, /commit on main/);
});

test("macOS signing supports either notarization method and rejects incomplete credentials", t => {
  const { root, run, stub } = fixture(t);
  stub("pnpm", `printf '%s\\n' "\${APPLE_ID:-}" "\${APPLE_API_KEY:-}" "\${T3CODE_MACOS_PROVISIONING_PROFILE:-}" > "$TMPDIR/build-inputs"
if [[ -n \${APPLE_API_KEY:-} ]]; then test "$(cat "$APPLE_API_KEY")" = test-key; fi
exit 42`);
  const base = { NATIVE_SIGN: "true", CSC_LINK: "test-p12", CSC_KEY_PASSWORD: "test-password", APPLE_TEAM_ID: "ABC1234567" };
  const build = extra => run("bash", ["scripts/ci/native-desktop.sh", "mac", "arm64"], { ...base, ...extra });
  assert.equal(build({ APPLE_ID: "test@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "test-password" }).status, 42);
  assert.equal(readFileSync(resolve(root, "build-inputs"), "utf8"), "test@example.invalid\n\n\n");
  assert.equal(build({ APPLE_API_KEY: "test-key", APPLE_API_KEY_ID: "test-id", APPLE_API_ISSUER: "test-issuer" }).status, 42);
  const keyPath = readFileSync(resolve(root, "build-inputs"), "utf8").split("\n")[1];
  assert.ok(keyPath.endsWith("/AuthKey.p8"));
  assert.equal(existsSync(keyPath), false, "temporary key must be removed even when packaging fails");
  for (const extra of [
    {},
    { APPLE_ID: "test@example.invalid" },
    { APPLE_APP_SPECIFIC_PASSWORD: "test-password" },
    { APPLE_API_KEY: "test-key", APPLE_API_KEY_ID: "test-id" },
    { APPLE_ID: "test@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "test-password", T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.invalid" },
    { APPLE_ID: "test@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "test-password", MACOS_PROVISIONING_PROFILE: "test-profile" },
    { APPLE_ID: "test@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "test-password", APPLE_TEAM_ID: "invalid" },
  ]) {
    rmSync(resolve(root, "build-inputs"), { force: true });
    assert.equal(build(extra).status, 1);
    assert.equal(existsSync(resolve(root, "build-inputs")), false, "invalid signing input must never reach packaging");
  }
});

test("verification checks both containers and rejects bad signatures, teams, tickets and Gatekeeper failures", t => {
  const { root, run, stub } = fixture(t);
  stub("hdiutil", 'if [[ $1 == attach ]]; then mkdir -p "${@: -1}/Baskule.app"; fi');
  stub("ditto", 'if [[ $1 == -x ]]; then mkdir -p "${@: -1}/Baskule.app"; else mkdir -p "$2"; fi');
  stub("codesign", `echo "codesign $*" >> "$TMPDIR/commands"
if [[ $1 == --verify ]]; then
  [[ \${FAIL:-} != signature || $* != *update* ]]
else
  echo "TeamIdentifier=\${TEAM:-ABC1234567}"
  echo "Authority=\${AUTHORITY:-Developer ID Application: Test}"
fi`);
  stub("xcrun", 'echo "stapler $*" >> "$TMPDIR/commands"; [[ ${FAIL:-} != ticket || $* != *update* ]]');
  stub("spctl", 'echo "spctl $*" >> "$TMPDIR/commands"; [[ ${FAIL:-} != gatekeeper || $* != *update* ]]');
  const verify = extra => run("bash", ["scripts/ci/verify-macos.sh", "test.dmg", "test.zip"], { APPLE_TEAM_ID: "ABC1234567", ...extra });
  const success = verify({});
  assert.equal(success.status, 0, success.stderr);
  const commands = readFileSync(resolve(root, "commands"), "utf8");
  for (const container of ["installed", "update"]) {
    for (const command of ["codesign --verify --deep --strict", "stapler stapler validate", "spctl --assess --type execute"]) {
      assert.ok(commands.split("\n").some(line => line.startsWith(command) && line.includes(`/${container}/Baskule.app`)));
    }
  }
  for (const extra of [{ FAIL: "signature" }, { FAIL: "ticket" }, { FAIL: "gatekeeper" }, { TEAM: "OTHERTEAM1" }, { AUTHORITY: "Apple Development: Test" }]) {
    assert.notEqual(verify(extra).status, 0);
  }
});
