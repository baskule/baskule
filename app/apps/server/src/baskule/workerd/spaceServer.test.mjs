import { expect, test } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";

// Bundle the real hosted composition and expose its attachment registry only inside this fixture.
test("the real Space server unregisters routes and attachments across release boundaries", async () => {
  const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "space-server-release-"));
  const suffix = crypto.randomUUID();
  const entry = NodePath.join(here, `.release-${suffix}.ts`);
  const builder = NodePath.join(here, `.release-${suffix}.mjs`);
  const outfile = NodePath.join(dir, "fixture.mjs");
  const previousRequire = globalThis.require;
  const databases = [];
  const makeStorage = (onQuery = () => {}) => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    databases.push(db);
    return makeDatabaseStorage(db, onQuery);
  };
  const makeDatabaseStorage = (db, onQuery) => ({
    sql: {
      exec(query, ...bindings) {
        onQuery(query);
        const statement = db.prepare(query);
        const columns = statement.columns().map((column) => column.name);
        if (!columns.length) {
          statement.run(...bindings);
          return { columnNames: [], raw: function* () {} };
        }
        statement.setReturnArrays(true);
        return { columnNames: columns, raw: () => statement.all(...bindings)[Symbol.iterator]() };
      },
    },
    transaction: async (closure) => {
      db.exec("BEGIN");
      try {
        const value = await closure();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  const storage = makeStorage();
  let server;
  try {
    await NodeFSP.writeFile(
      entry,
      'export * from "./index.ts"; export { attachmentFs } from "../attachmentFs.ts";',
    );
    const source = await NodeFSP.readFile(NodePath.join(here, "build.mjs"), "utf8");
    await NodeFSP.writeFile(
      builder,
      source.replace('NodePath.join(here, "index.ts")', JSON.stringify(entry)),
    );
    NodeChildProcess.execFileSync(process.execPath, [builder, "--out", outfile], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    globalThis.require = NodeModule.createRequire(import.meta.url);
    const { createSpaceServer, attachmentFs } = await import(NodeURL.pathToFileURL(outfile).href);
    const agentFetch = async () => new Response("agent route");
    const config = {
      storage,
      agentFetch,
      spaceId: "release-after-build",
      llmModel: "fake-model",
      llmProviderId: "mistral",
      waitUntil: () => {},
    };
    let release;
    server = await createSpaceServer({
      ...config,
      onRelease: (callback) => {
        release = callback;
        return () => {};
      },
    });
    const attachments = "/baskule/spaces/release-after-build/userdata/attachments";
    expect(await (await fetch("http://agent/release-after-build/oc/api/model")).text()).toBe(
      "agent route",
    );
    expect(attachmentFs.readdirSync(attachments)).toEqual([]);
    release();
    expect((await fetch("http://agent/release-after-build/oc/api/model")).status).toBe(502);
    expect(() => attachmentFs.readdirSync(attachments)).toThrow(/ENOENT/);
    await server.dispose();
    server = undefined;
    await expect(
      createSpaceServer({
        ...config,
        spaceId: "release-before-router",
        onRelease: (callback) => {
          callback();
          return () => {};
        },
      }),
    ).rejects.toThrow("Space cell is released");
    expect((await fetch("http://agent/release-before-router/oc/api/model")).status).toBe(502);
    expect(() =>
      attachmentFs.readdirSync("/baskule/spaces/release-before-router/userdata/attachments"),
    ).toThrow(/ENOENT/);
    // A release that lands while layers build must close the scope instead of returning a server.
    let releaseDuringBuild;
    let releasedDuringBuild = false;
    await expect(
      createSpaceServer({
        ...config,
        spaceId: "release-during-build",
        storage: makeStorage((query) => {
          if (releasedDuringBuild || !query.includes("effect_sql_migrations")) return;
          releasedDuringBuild = true;
          releaseDuringBuild();
        }),
        onRelease: (callback) => {
          releaseDuringBuild = callback;
          return () => {};
        },
      }),
    ).rejects.toThrow("cell released");
    expect(releasedDuringBuild).toBe(true);
    expect((await fetch("http://agent/release-during-build/oc/api/model")).status).toBe(502);
    expect(() =>
      attachmentFs.readdirSync("/baskule/spaces/release-during-build/userdata/attachments"),
    ).toThrow(/ENOENT/);
  } finally {
    await server?.dispose();
    globalThis.require = previousRequire;
    for (const db of databases) db.close();
    await Promise.all([
      NodeFSP.rm(entry, { force: true }),
      NodeFSP.rm(builder, { force: true }),
      NodeFSP.rm(dir, { recursive: true, force: true }),
    ]);
  }
});
