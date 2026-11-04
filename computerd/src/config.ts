import { isIP } from "node:net";
import type { KubernetesOptions } from "./kubernetes.ts";
// computerd configuration, from the environment. Secrets (LLM key, tokens) are read here and never logged.

export interface Config {
  instance: string;
  port: number;
  host: string;
  token: string;
  backend: "docker" | "kubernetes";
  kubernetes?: KubernetesOptions;
  legacyVolume?: string;
  dockerHost: string;
  network: string;
  guardImage: string;
  dns: string[];
  image: string;
  cpuLimit: string;
  memoryLimit: string;
  idleMs: number;
  idleCheckMs: number;
  maxConcurrent: number; // per computer: exec + cdp + files streams
  readyTimeoutMs: number;
  maxPutBytes: number;
  sandboxRoot: string; // "/sandbox" in production; a temp dir in unit tests (commands run locally)
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
  const backend = env.COMPUTER_BACKEND ?? "docker";
  if (backend !== "docker" && backend !== "kubernetes") {
    throw new Error("COMPUTER_BACKEND must be docker or kubernetes");
  }
  const dns = (env.COMPUTER_DNS ?? "1.1.1.1,8.8.8.8").split(",").map(value => value.trim());
  if (!dns.length || dns.some(value => !isIP(value))) throw new Error("COMPUTER_DNS must contain comma-separated IP addresses");
  return {
    instance,
    port: num(env, "COMPUTERD_PORT", 47094),
    host: env.COMPUTERD_HOST ?? "0.0.0.0",
    token,
    backend,
    kubernetes: {
      storageClass: env.COMPUTER_STORAGE_CLASS || undefined,
      storageSize: env.COMPUTER_DISK_SIZE || "10Gi",
      runtimeClassName: env.COMPUTER_RUNTIME_CLASS_NAME || undefined,
      nodeSelector: stringMap(env.COMPUTER_NODE_SELECTOR ?? "{}"),
      tolerations: objects(env.COMPUTER_TOLERATIONS ?? "[]"),
      imagePullSecrets: objects(env.COMPUTER_IMAGE_PULL_SECRETS ?? "[]").map(value => {
        if (typeof value.name !== "string" || !value.name) throw new Error("Invalid COMPUTER_IMAGE_PULL_SECRETS name");
        return { name: value.name };
      }),
    },
    legacyVolume: env.COMPUTER_LEGACY_VOLUME ?? "",
    dockerHost: env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
    network: env.COMPUTER_NETWORK ?? "baskule-computers",
    guardImage: env.COMPUTER_GUARD_IMAGE ?? "baskule-computerd:local",
    dns,
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

function objects(raw: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(v => v !== null && typeof v === "object" && !Array.isArray(v))) throw new Error("Expected JSON array of objects");
  return value;
}
function stringMap(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON string map");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error("Expected JSON string map");
    result[key] = item;
  }
  return result;
}
