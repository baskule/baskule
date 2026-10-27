// Renders the Baskule-managed keys of T3's <baseDir>/userdata/settings.json from the environment.
// Runs at EVERY server start (so a .env change + restart is a model swap), and only touches:
//   providerInstances.{codex,claudeAgent,acpRegistry,antigravity,cursor,pi,grok,muse}.enabled = false
//   providerInstances.opencode = { driver, enabled: true, config: { ...kept, serverUrl, serverPassword } }
//   defaultModelSelection, textGenerationModelSelection = { instanceId: "opencode", model: "<provider>/<model>" }
//   enableProviderUpdateChecks = false (OpenCode is pinned in the computer image; users can't act on update toasts)
// Every other key (user preferences, other instance config) is preserved.
// The plaintext serverPassword is moved by T3 into userdata/secrets/ on load (settings.json then holds a
// redacted marker); writing it again on each start keeps the secret in sync with the .env.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const env = process.env;
const file = process.argv[2] ?? `${env.BASKULE_BASE_DIR ?? "/baskule"}/userdata/settings.json`;
const need = (k) => {
  const v = (env[k] ?? "").trim();
  if (!v) {
    console.error(`baskule-server: ${k} is required`);
    process.exit(1);
  }
  return v;
};

const serverUrl = (env.BASKULE_OPENCODE_URL ?? "http://baskule-computerd:4096").trim();
const serverPassword = need("BASKULE_OPENCODE_PASSWORD");
// OpenCode model ref = <provider id in opencode.jsonc>/<model id>. The computer's config names its provider "llm".
const provider = (env.BASKULE_LLM_PROVIDER_ID ?? "llm").trim();
const model = `${provider}/${need("BASKULE_LLM_MODEL")}`;
const disabledDrivers = ["codex", "claudeAgent", "acpRegistry", "antigravity", "cursor", "pi", "grok", "muse"];

let settings = {};
try {
  settings = JSON.parse(readFileSync(file, "utf8"));
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {};
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error(`baskule-server: ${file} is not valid JSON, rewriting it (${err.message})`);
  }
}

const instances = { ...(settings.providerInstances ?? {}) };
for (const driver of disabledDrivers) {
  instances[driver] = { ...(instances[driver] ?? {}), driver, enabled: false };
}
const prev = instances.opencode ?? {};
instances.opencode = {
  ...prev,
  driver: "opencode",
  enabled: true,
  config: { ...(prev.config ?? {}), serverUrl, serverPassword },
};
settings.providerInstances = instances;
settings.defaultModelSelection = { instanceId: "opencode", model };
settings.textGenerationModelSelection = { instanceId: "opencode", model };
settings.enableProviderUpdateChecks = false;

mkdirSync(dirname(file), { recursive: true });
writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
renameSync(`${file}.tmp`, file);
console.error(`baskule-server: settings rendered (opencode -> ${serverUrl}, model ${model})`);
