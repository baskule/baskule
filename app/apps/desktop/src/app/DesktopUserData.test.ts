import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["linux", "darwin", "win32"] as const)(
  "isolates Baskule from T3 and the retired shell on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      for (const name of ["t3code-v2", "t3code", "Baskule"]) {
        yield* fs.makeDirectory(path.join(directory, name));
        yield* fs.writeFileString(
          path.join(directory, name, "Local State"),
          "existing private data",
        );
      }
      const destination = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform,
      });
      assert.equal(destination, path.join(directory, "baskule-desktop"));
      assert.deepEqual(yield* fs.readDirectory(destination), []);
      assert.equal(
        yield* fs.readFileString(path.join(directory, "t3code-v2", "Local State")),
        "existing private data",
      );
      assert.equal(
        yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment: true, platform }),
        path.join(directory, "baskule-dev"),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
