// computerd configuration, from the environment. Secrets (LLM key, tokens) are read here and never logged.

export interface Config {
  instance: string;
  port: number;
  host: string;
  token: string;
  gateway: string; // host:port of the OpenShell gateway (plaintext gRPC, internal network only)
  volumesUrl: string; // baskule-openshell volume helper, e.g. http://baskule-openshell:47096
  volumesToken: string;
  image: string;
  cpuLimit: string;
  memoryLimit: string;
  idleMs: number;
  idleCheckMs: number;
  maxConcurrent: number; // per computer: exec + cdp + files streams
  readyTimeoutMs: number;
  maxPutBytes: number;
  sandboxRoot: string; // "/sandbox" in production; a temp dir in unit tests (fake gateway runs commands locally)
  cdpPort: number;
  browserPort: number;
  productSettingsUrl: string;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.COMPUTERD_TOKEN ?? "";
  if (token.length < 16) throw new Error("COMPUTERD_TOKEN must be set (16+ characters)");
  const instance = env.COMPUTERD_INSTANCE ?? "";
  if (instance && (instance.length > 63 || !/^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(instance))) {
    throw new Error("COMPUTERD_INSTANCE must be a label value (1–63 alphanumeric, dot, underscore or hyphen characters; alphanumeric ends)");
  }
  const idleMinutes = num(env, "IDLE_MINUTES", 10);
  const idleMs = Math.round(idleMinutes * 60_000);
  return {
    instance,
    port: num(env, "COMPUTERD_PORT", 47094),
    host: env.COMPUTERD_HOST ?? "0.0.0.0",
    token,
    gateway: env.OPENSHELL_GATEWAY ?? "baskule-openshell:47095",
    volumesUrl: (env.OPENSHELL_VOLUMES_URL ?? "http://baskule-openshell:47096").replace(/\/$/, ""),
    volumesToken: env.OPENSHELL_VOLUMES_TOKEN ?? "",
    image: env.COMPUTER_IMAGE ?? "baskule-computer:local",
    cpuLimit: env.COMPUTER_CPUS ?? "2",
    memoryLimit: env.COMPUTER_MEMORY ?? "3Gi",
    idleMs,
    idleCheckMs: num(env, "IDLE_CHECK_MS", Math.max(1000, Math.min(15_000, Math.floor(idleMs / 4)))),
    maxConcurrent: num(env, "MAX_STREAMS_PER_COMPUTER", 30),
    readyTimeoutMs: num(env, "READY_TIMEOUT_MS", 180_000),
    maxPutBytes: num(env, "MAX_PUT_BYTES", 1024 * 1024 * 1024),
    sandboxRoot: (env.SANDBOX_ROOT ?? "/sandbox").replace(/\/$/, ""),
    cdpPort: num(env, "BASKULE_CDP_PORT", 9222),
    browserPort: num(env, "BASKULE_BROWSER_PORT", 9223),
    productSettingsUrl: env.PRODUCT_SETTINGS_URL ?? "",
  };
}
