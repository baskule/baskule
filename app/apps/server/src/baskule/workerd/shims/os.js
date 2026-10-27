// celld's os.tmpdir() is not a string; the cell has no host to describe.
export const platform = () => "linux";
// Not the computer's HOME: provider probes read ~/.codex, ~/.claude.json…; they must not wake it.
export const homedir = () => "/baskule/home";
export const tmpdir = () => "/tmp";
export const hostname = () => "space-cell";
export const EOL = "\n";
export const cpus = () => [];
export const totalmem = () => 1024 * 2 ** 20;
export const freemem = () => 512 * 2 ** 20;
export const release = () => "workerd";
export const type = () => "Linux";
export const arch = () => "x64";
export const userInfo = () => ({
  username: "space",
  uid: 1000,
  gid: 1000,
  shell: null,
  homedir: homedir(),
});
export const networkInterfaces = () => ({});
export const constants = { signals: {}, errno: {}, priority: {} };
export const availableParallelism = () => 1;
export const loadavg = () => [0, 0, 0];
export const uptime = () => 0;
export const endianness = () => "LE";
export const machine = () => "x86_64";
export const version = () => "workerd";
export const devNull = "/dev/null";
export default {
  platform,
  homedir,
  tmpdir,
  hostname,
  EOL,
  cpus,
  totalmem,
  freemem,
  release,
  type,
  arch,
  userInfo,
  networkInterfaces,
  constants,
  availableParallelism,
  loadavg,
  uptime,
  endianness,
  machine,
  version,
  devNull,
};
