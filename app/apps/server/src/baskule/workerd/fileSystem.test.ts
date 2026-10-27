// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeComputerFs } from "./computerFs.ts";
import { makeSpaceFileSystem } from "./fileSystem.ts";
import { makeFakeComputerd } from "./testing/fakeComputerd.ts";
import { makeFakeDoStorage } from "./testing/fakeDoStorage.ts";

const setup = () => {
  const host = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baskule-wpb-fs-"));
  const computerd = makeFakeComputerd(host);
  const storage = makeFakeDoStorage();
  const make = () =>
    makeSpaceFileSystem({
      storage,
      baseDir: "/baskule",
      sandboxRoot: "/sandbox",
      chatsRoot: "/sandbox/space/chats",
      computer: makeComputerFs({
        baseUrl: "http://computerd",
        token: "t",
        spaceId: "s1",
        fetch: computerd.fetch,
      }),
    });
  return { host, computerd, storage, make };
};

describe("space file system", () => {
  it.live("keeps userdata in DO SQLite across instances", () =>
    Effect.gen(function* () {
      const { make, computerd } = setup();
      const fs = make().fileSystem;
      yield* fs.makeDirectory("/baskule/userdata/secrets", { recursive: true });
      yield* fs.writeFileString("/baskule/userdata/settings.json", "{}");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open("/baskule/userdata/secrets/key.bin", { flag: "w" });
          yield* file.writeAll(new Uint8Array([1, 2, 3]));
          yield* file.sync;
        }),
      );
      const big = new Uint8Array(2_500_000).map((_, i) => i % 251);
      yield* fs.writeFile("/baskule/userdata/attachments/a.bin", big).pipe(Effect.flip);
      yield* fs.makeDirectory("/baskule/userdata/attachments");
      yield* fs.writeFile("/baskule/userdata/attachments/a.bin", big);

      // A fresh instance over the same storage, as after a cell restart.
      const again = make().fileSystem;
      expect(yield* again.readFileString("/baskule/userdata/settings.json")).toBe("{}");
      expect([...(yield* again.readFile("/baskule/userdata/secrets/key.bin"))]).toEqual([1, 2, 3]);
      expect((yield* again.readFile("/baskule/userdata/attachments/a.bin")).length).toBe(
        big.length,
      );
      expect((yield* again.readDirectory("/baskule/userdata")).sort()).toEqual([
        "attachments",
        "secrets",
        "settings.json",
      ]);
      const streamed = yield* Stream.runCollect(
        again.stream("/baskule/userdata/attachments/a.bin"),
      );
      expect(streamed.reduce((n, c) => n + c.length, 0)).toBe(big.length);
      expect(computerd.calls).toEqual([]);
    }),
  );

  it.live("records chat folders without waking the computer, then materializes on write", () =>
    Effect.gen(function* () {
      const { make, computerd, host } = setup();
      const fs = make().fileSystem;
      const folder = "/sandbox/space/chats/2026-10-23-hello-abc";
      yield* fs.makeDirectory("/sandbox/space/chats", { recursive: true });
      yield* fs.makeDirectory(folder);
      const claimed = yield* fs.makeDirectory(folder).pipe(Effect.flip);
      expect(claimed.reason._tag).toBe("AlreadyExists");
      expect((yield* fs.stat(folder)).type).toBe("Directory");
      expect(yield* fs.readDirectory(folder)).toEqual([]);
      expect(yield* make().fileSystem.readDirectory("/sandbox/space/chats")).toEqual([
        "2026-10-23-hello-abc",
      ]);
      // Only status calls (which never start a computer): no file call while the space has no computer.
      expect(computerd.calls.filter((c) => !c.endsWith("/computer"))).toEqual([]);

      yield* fs.writeFileString(`${folder}/notes.txt`, "hi");
      expect(
        NodeFS.readFileSync(
          NodePath.join(host, "space/chats/2026-10-23-hello-abc/notes.txt"),
          "utf8",
        ),
      ).toBe("hi");
      expect(yield* fs.readDirectory(folder)).toEqual(["notes.txt"]);
      const info = yield* fs.stat(`${folder}/notes.txt`);
      expect(info.type).toBe("File");
      expect(Number(info.size)).toBe(2);
      expect(yield* fs.readFileString(`${folder}/notes.txt`)).toBe("hi");
      const missing = yield* fs.stat(`${folder}/nope`).pipe(Effect.flip);
      expect(missing.reason._tag).toBe("NotFound");
    }),
  );

  it.live(
    "adopts a chat folder the agent created on the computer, without waking a stopped one",
    () =>
      Effect.gen(function* () {
        const { make, computerd, host } = setup();
        const fs = make().fileSystem;
        const folder = "/sandbox/space/chats/2026-10-23-tool-abc";
        yield* fs.makeDirectory(folder, { recursive: true });
        // The agent's spawner runs `mkdir -p` in the chat cwd and writes there: the record never sees it.
        NodeFS.mkdirSync(NodePath.join(host, "space/chats/2026-10-23-tool-abc"), {
          recursive: true,
        });
        NodeFS.writeFileSync(
          NodePath.join(host, "space/chats/2026-10-23-tool-abc/result.txt"),
          "ok",
        );

        // Stopped computer: T3's own stats inside the chat do not wake it.
        computerd.phase = "stopped";
        const quiet = yield* fs.stat(`${folder}/.git`).pipe(Effect.flip);
        expect(quiet.reason._tag).toBe("NotFound");
        expect(computerd.calls.filter((c) => !c.endsWith("/computer"))).toEqual([]);
        // An explicit listing (file panel) looks on the computer and adopts the folder.
        expect(yield* fs.readDirectory(folder)).toEqual(["result.txt"]);
        expect(yield* fs.readFileString(`${folder}/result.txt`)).toBe("ok");

        // Running computer: a plain stat adopts too.
        const other = "/sandbox/space/chats/2026-10-23-tool-def";
        yield* fs.makeDirectory(other);
        NodeFS.mkdirSync(NodePath.join(host, "space/chats/2026-10-23-tool-def"));
        NodeFS.writeFileSync(NodePath.join(host, "space/chats/2026-10-23-tool-def/out.md"), "#");
        computerd.phase = "ready";
        expect((yield* fs.stat(`${other}/out.md`)).type).toBe("File");
      }),
  );

  it.live("reads other computer paths through computerd and refuses paths outside the mounts", () =>
    Effect.gen(function* () {
      const { make, host } = setup();
      NodeFS.mkdirSync(NodePath.join(host, "space/home"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(host, "space/home/report.csv"), "a,b\n1,2\n");
      const fs = make().fileSystem;
      expect(yield* fs.readDirectory("/sandbox/space/home")).toEqual(["report.csv"]);
      const chunk = yield* Effect.scoped(
        Effect.flatMap(fs.open("/sandbox/space/home/report.csv"), (file) =>
          file.readAlloc(3, { position: 4n }),
        ),
      );
      expect(new TextDecoder().decode(chunk._tag === "Some" ? chunk.value : new Uint8Array())).toBe(
        "1,2",
      );
      const denied = yield* fs.readFile("/etc/passwd").pipe(Effect.flip);
      expect(denied.reason._tag).toBe("PermissionDenied");
      expect((yield* fs.stat("/")).type).toBe("Directory");
    }),
  );
});
