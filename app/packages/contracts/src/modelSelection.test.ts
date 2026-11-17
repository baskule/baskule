import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";

import { ModelSelection } from "./modelSelection.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);
const decodeProviderOptions = Schema.decodeEffect(ProviderOptionSelections);

it.effect("reads historical JSON-string options and writes canonical arrays", () =>
  Effect.gen(function* () {
    for (const options of [
      [],
      [
        { id: "variant", value: "high" },
        { id: "thinking", value: true },
        { id: "fast", value: false },
      ],
    ]) {
      const decoded = yield* decodeModelSelection({
        provider: "opencode",
        model: "opencode/big-pickle",
        options: JSON.stringify(options),
      });
      assert.deepStrictEqual(decoded, {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode/big-pickle",
        options,
      });
      assert.deepStrictEqual(yield* encodeModelSelection(decoded), decoded);
    }
  }),
);

it.effect("rejects invalid historical option strings without losing their values", () =>
  Effect.gen(function* () {
    for (const input of [
      "not JSON",
      "null",
      "true",
      "1",
      '"scalar"',
      '{"variant":"high"}',
      JSON.stringify("[]"),
      '[{"id":"variant","value":1}]',
    ]) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeProviderOptions(input))));
    }
  }),
);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection treats null options as omitted", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex",
      model: "gpt-5",
      options: null,
    });
    assert.deepStrictEqual(parsed, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    });
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as a canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeModelSelection({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,

          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      });
      assert.deepStrictEqual(decoded.options, [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ]);
      const encoded = yield* encodeModelSelection(decoded);
      assert.deepStrictEqual(encoded.options, decoded.options);
    }),
);
