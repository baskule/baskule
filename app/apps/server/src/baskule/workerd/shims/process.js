// celld's `node:process` module is a stub proxy (env.X is a function); the global `process` is
// usable. This module also fills the process APIs T3's diagnostics read at startup.
const p = globalThis.process;
p.env ??= {};
p.resourceUsage ??= () => ({
  userCPUTime: 0,
  systemCPUTime: 0,
  maxRSS: 0,
  voluntaryContextSwitches: 0,
  involuntaryContextSwitches: 0,
});
p.cpuUsage ??= () => ({ user: 0, system: 0 });
p.memoryUsage ??= Object.assign(
  () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  { rss: () => 0 },
);
p.uptime ??= () => performance.now() / 1000;
for (const k of [
  "on",
  "off",
  "once",
  "removeListener",
  "addListener",
  "removeAllListeners",
  "prependListener",
])
  p[k] ??= () => p;
p.listeners ??= () => [];
p.emitWarning ??= () => {};
p.pid ??= 1;
p.ppid ??= 0;
p.argv ??= [];
p.execArgv ??= [];
p.cwd ??= () => "/baskule";
p.umask ??= () => 0o22;
export default p;
export const env = p.env;
export const argv = p.argv;
export const platform = "linux";
export const versions = p.versions ?? {};
export const version = p.version ?? "v24.0.0";
export const nextTick = p.nextTick ?? ((fn, ...a) => queueMicrotask(() => fn(...a)));
export const cwd = p.cwd;
export const exit = () => {};
export const pid = p.pid;
export const ppid = p.ppid;
export const hrtime = p.hrtime;
export const memoryUsage = p.memoryUsage;
export const resourceUsage = p.resourceUsage;
export const cpuUsage = p.cpuUsage;
export const uptime = p.uptime;
export const on = p.on;
export const off = p.off;
export const once = p.once;
export const emitWarning = p.emitWarning;
export const stdout = p.stdout;
export const stderr = p.stderr;
export const stdin = p.stdin;
export const execPath = "/usr/bin/node";
export const execArgv = p.execArgv;
export const arch = "x64";
export const release = { name: "node" };
export const umask = p.umask;
export const kill = () => true;
export const exitCode = undefined;
