// baskule-computerd entry point. See README.md.
import { loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { Computers } from "./computers.ts";
import { createServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const gw = new Gateway(cfg.gateway);
const computers = new Computers(gw, cfg);
const server = createServer({ cfg, gw, computers });

server.listen(cfg.port, cfg.host, () => {
  log.info("computerd listening", {
    port: cfg.port,
    gateway: cfg.gateway,
    image: cfg.image,
    idleMinutes: cfg.idleMs / 60_000,
  });
});
computers.adopt().catch((e) => log.warn("initial adopt failed (gateway not up yet?)", { err: String(e?.message ?? e) }));
computers.startIdleLoop();

function shutdown(sig: string) {
  log.info("shutting down", { sig });
  computers.stopIdleLoop();
  server.close();
  server.closeAllConnections();
  gw.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
