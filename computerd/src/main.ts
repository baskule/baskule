// baskule-computerd entry point. See README.md.
import { closeSessions } from "./session.ts";
import { loadConfig } from "./config.ts";
import { KubernetesBackend } from "./kubernetes.ts";
import { DockerBackend } from "./docker.ts";
import { Computers } from "./computers.ts";
import { createServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const backend = cfg.backend === "kubernetes"
  ? new KubernetesBackend(cfg.kubernetes)
  : new DockerBackend(cfg.dockerHost, cfg.network, cfg.guardImage, cfg.dns, cfg.legacyVolume, { instance: cfg.instance });
const computers = new Computers(backend, cfg);
const server = createServer({ cfg, backend, computers });

server.listen(cfg.port, cfg.host, () => {
  log.info("computerd listening", {
    port: cfg.port,
    backend: cfg.backend,
    image: cfg.image,
    idleMinutes: cfg.idleMs / 60_000,
  });
});
computers.adopt().catch((e) => log.warn("initial adopt failed (backend not up yet?)", { err: String(e?.message ?? e) }));
computers.startIdleLoop();

function shutdown(sig: string) {
  log.info("shutting down", { sig });
  computers.stopIdleLoop();
  server.close();
  server.closeAllConnections();
  closeSessions(backend);
  backend.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
