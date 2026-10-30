// baskule: isolate-wide constants only; per-space values use ConfigProvider in spaceServer.ts.
// Import the node:process shim here to fill global process APIs even when no retained T3 module
// imports it. The build trims some importers, including EventLoopMonitor dependencies.
import * as NodeProcess from "node:process";

const env = NodeProcess.env;
env.BASKULE = "1";
env.T3CODE_TELEMETRY_ENABLED = "false";
