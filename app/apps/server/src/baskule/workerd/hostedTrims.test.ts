import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as Keybindings from "../../keybindings.ts";
import * as SpeechModelStore from "../../speech/SpeechModelStore.ts";
import * as HostedTrims from "./hostedTrims.ts";

it.effect(
  "keeps the default shortcuts of the managed empty config without file watchers or backfills",
  () =>
    Effect.gen(function* () {
      const expected = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(config.keybindingsConfigPath, "[]");
        const service = yield* Keybindings.Keybindings;
        yield* service.start;
        return yield* service.getSnapshot;
      }).pipe(
        Effect.provide(
          Keybindings.layer.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "hosted-keybindings-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const actual = yield* Effect.gen(function* () {
        const service = yield* Keybindings.Keybindings;
        yield* service.start;
        yield* service.ready;
        return yield* service.getSnapshot;
      }).pipe(Effect.provide(HostedTrims.layerKeybindings));
      assert.deepEqual(actual, expected);
    }),
);

it.effect("keeps hosted native speech models absent and refuses local file mutations", () =>
  Effect.gen(function* () {
    const store = yield* SpeechModelStore.SpeechModelStore;
    const model = {
      id: "fixture",
      filename: "fixture.gguf",
      revision: "fixture",
      size: 1,
      sha256: "0".repeat(64),
    };
    assert.isFalse(yield* store.isReady(model));
    assert.isUndefined(yield* store.installedPath(model));
    assert.isUndefined(yield* store.linkedFrom(model));
    const downloaded = yield* Effect.flip(store.download(model));
    assert.equal(downloaded._tag, "PlatformError");
    const linked = yield* Effect.flip(store.link([model], "/outside/model.gguf"));
    assert.equal(linked.reason._tag, "NotFound");
    const removed = yield* Effect.flip(store.remove(model));
    assert.equal(removed.reason._tag, "NotFound");
  }).pipe(Effect.provide(HostedTrims.layerSpeechModelStore)),
);
