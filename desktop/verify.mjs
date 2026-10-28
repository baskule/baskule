// Nonvisual acceptance of the actual packaged app. All server data and profiles are disposable.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { globSync } from "node:fs";
const requireWeb = createRequire(new URL("../app/apps/web/package.json", import.meta.url));
const requireServer = createRequire(new URL("../app/apps/server/package.json", import.meta.url));
const { _electron: electron } = requireWeb("playwright");
const { WebSocketServer } = requireServer("ws");
const directory = await mkdtemp(join(tmpdir(), "baskule-package-"));
const home = join(directory, "home");
const evidence = resolve(".run/desktop-verification");
await mkdir(evidence, { recursive: true });
await mkdir(home);
let app;
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  const authenticated = request.headers.cookie?.includes("baskule.session_token=desktop-test");
  if (request.url === "/.well-known/baskule") return response.end(JSON.stringify({ product: "baskule", authentication: { mode: "authenticated", password: true, providers: [] } }));
  if (request.url === "/auth/sign-in/email") {
    assert.equal(request.headers.origin, origin);
    response.setHeader("set-cookie", "baskule.session_token=desktop-test; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600");
    return response.end("{}");
  }
  if (request.url === "/api/baskule/me" && authenticated) return response.end(JSON.stringify({ authentication: { mode: "authenticated", password: true, providers: [] }, user: { id: "desktop-user", name: "Desktop User", email: "desktop@example.test", role: "member" }, spaces: [] }));
  response.statusCode = 401;
  response.end('{"error":"unauthenticated"}');
});
const sockets = new WebSocketServer({ noServer: true });
sockets.on("connection", (socket) => { socket.send("native-cookie-ok"); socket.close(); });
server.on("upgrade", (request, socket, head) => {
  if (request.headers.origin !== origin || !request.headers.cookie?.includes("baskule.session_token=desktop-test")) return socket.destroy();
  sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sourceMode = process.argv.includes("--source");
let executablePath;
let launchArgs;
if (sourceMode) {
  const requireDesktop = createRequire(new URL("../app/apps/desktop/package.json", import.meta.url));
  executablePath = requireDesktop("electron");
  launchArgs = ["--no-sandbox", resolve("app/apps/desktop/dist-electron/boot.cjs")];
} else {
  const artifact = globSync("desktop/release/*.AppImage").at(0);
  assert.ok(artifact, "Build desktop/build.sh first");
  execFileSync(resolve(artifact), ["--appimage-extract"], { cwd: directory, stdio: "ignore" });
  executablePath = join(directory, "squashfs-root/baskule");
  launchArgs = ["--no-sandbox"];
}
const launch = async () => {
  const env = { ...process.env, HOME: home, BASKULE_HOME: join(directory, "state"), XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), T3CODE_TELEMETRY_ENABLED: "false", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", LANGUAGE: "en_US:en" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({ executablePath, args: launchArgs, env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  return page;
};
try {
  let page = await launch();
  await page.getByRole("textbox", { name: "Server address or connection link" }).fill(origin);
  await page.screenshot({ path: join(evidence, "connect.png") });
  await page.getByRole("button", { name: "Review connection", exact: true }).click();
  await page.getByText(origin, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.desktopBridge.getBaskuleServer()), null);
  await page.screenshot({ path: join(evidence, "connection-review.png") });
  await page.getByRole("button", { name: "Confirm connection", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("desktop@example.test");
  await page.screenshot({ path: join(evidence, "login.png") });
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  assert.equal(await page.evaluate(() => window.desktopBridge.getLocalEnvironmentEnabled()), false);
  assert.equal(await page.evaluate(() => window.location.protocol), "baskule:");
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/baskule/me")).json()).user.id), "desktop-user");
  const socketMessage = await page.evaluate((origin) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/s/test/ws`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Socket timed out")); }, 10_000);
    socket.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("Socket upgrade failed")); };
  }), origin);
  assert.equal(socketMessage, "native-cookie-ok");
  await app.close(); app = null;
  page = await launch();
  await page.waitForURL((url) => url.pathname === "/");
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/baskule/me")).json()).user.id), "desktop-user");
  assert.equal(await page.evaluate(() => window.desktopBridge.getBaskuleServer()), origin);
  await app.evaluate(({ app }, link) => {
    app.emit("second-instance", {}, ["baskule", link]);
  }, `baskule://connect?server=${encodeURIComponent(origin)}`);
  const connectionDialog = page.getByRole("dialog");
  await connectionDialog.getByRole("button", { name: "Review connection", exact: true }).click();
  await connectionDialog.getByText(origin, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.desktopBridge.getBaskuleServer()), origin);
  await page.screenshot({ path: join(evidence, "connection-link.png") });
  await connectionDialog.getByRole("button", { name: "Confirm connection", exact: true }).click();
  await connectionDialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.desktopBridge.getBaskuleServer()), origin);
  console.log(`${sourceMode ? "Source" : "Packaged"} desktop: bundled renderer, native IPC, server discovery, sign-in, space WebSocket cookies, and restart persistence passed.`);
} finally {
  await app?.close();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
