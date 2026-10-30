// baskule: process-wide constants for every space in the isolate. Per-space configuration goes through the space's ConfigProvider instead (spaceServer.ts); a few T3 modules
// read these two straight from `process.env`. The workerd build aliases `node:process` to shims/process.js, which also fills the `process` APIs T3 reads through the global
// (EventLoopMonitor's `process.resourceUsage`). Import it here so it does not depend on which T3 module happens to import `node:process` (build.mjs trims several of them).
import * as NodeProcess from "node:process";

const env = NodeProcess.env;
env.BASKULE = "1";
env.T3CODE_TELEMETRY_ENABLED = "false";
