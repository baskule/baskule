import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeSpaceFileSystem } from "./fileSystem.ts";
import { makeHostFileSystem } from "./hostFileSystem.ts";
import { makeFakeDoStorage } from "./testing/fakeDoStorage.ts";

it.live("serves saved browser images across restarts without exposing private userdata", () =>
  Effect.gen(function* () {
    const storage = makeFakeDoStorage();
    const baseDir = "/baskule/spaces/one";
    const make = () =>
      makeSpaceFileSystem({
        storage,
        baseDir,
        sandboxRoot: "/sandbox",
        chatsRoot: "/sandbox/space/chats",
        computer: undefined,
      });
    const space = make();
    const screenshotPath = `${baseDir}/userdata/browser-artifacts/screenshot.png`;
    const png = new Uint8Array([137, 80, 78, 71]);
    yield* space.fileSystem.makeDirectory(`${baseDir}/userdata/browser-artifacts`, {
      recursive: true,
    });
    yield* space.fileSystem.writeFile(screenshotPath, png);
    yield* space.fileSystem.writeFileString(`${baseDir}/userdata/settings.json`, "private");

    const host = makeHostFileSystem(make(), baseDir);
    yield* Effect.promise(async () => {
      expect(await host.realpath(screenshotPath)).toBe(screenshotPath);
      const file = await host.open(screenshotPath, "r");
      try {
        expect((await file.stat()).size).toBe(png.length);
        expect(new Uint8Array(await file.readFile())).toEqual(png);
      } finally {
        await file.close();
      }
      for (const path of [
        `${baseDir}/userdata/settings.json`,
        `${baseDir}/userdata/secrets/key`,
        `${baseDir}/userdata/browser-artifacts/../settings.json`,
        "/baskule/spaces/two/userdata/browser-artifacts/screenshot.png",
      ]) {
        await expect(host.realpath(path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(host.open(path, "r")).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  }),
);
