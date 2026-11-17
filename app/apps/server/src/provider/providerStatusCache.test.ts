import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";

import { hydrateCachedProvider, isCachedProviderCorrelated } from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it("hydrates cached provider status while preserving current settings-derived models", () => {
    const cachedOpenCode = makeProvider(OPENCODE_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackOpenCode = makeProvider(OPENCODE_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }),
      {
        ...fallbackOpenCode,
        models: [
          ...fallbackOpenCode.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ],
        installed: cachedOpenCode.installed,
        version: cachedOpenCode.version,
        status: cachedOpenCode.status,
        auth: cachedOpenCode.auth,
        checkedAt: cachedOpenCode.checkedAt,
        slashCommands: cachedOpenCode.slashCommands,
        skills: cachedOpenCode.skills,
        message: cachedOpenCode.message,
      },
    );
  });

  it("does not resurrect cached custom models that settings no longer declare", () => {
    const builtIn = {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    } as const;
    const cachedOpenCode = makeProvider(OPENCODE_DRIVER, {
      models: [
        builtIn,
        {
          slug: "removed-custom",
          name: "removed-custom",
          isCustom: true,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const fallbackOpenCode = makeProvider(OPENCODE_DRIVER, { models: [builtIn] });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }).models,
      [builtIn],
    );
  });

  it("ignores stale cached enabled state when the provider is now disabled", () => {
    const cachedOpenCode = makeProvider(OPENCODE_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider(OPENCODE_DRIVER, {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "OpenCode is disabled in T3 Code settings.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedOpenCode,
        fallbackProvider: disabledFallback,
      }),
      disabledFallback,
    );
  });

  it("rejects cached snapshots that are not correlated to the fallback instance", () => {
    const fallbackOpenCode = makeProvider(OPENCODE_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const legacyCachedOpenCode = {
      provider: ProviderDriverKind.make("opencode"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "cached-legacy-model",
          name: "Cached Legacy Model",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      slashCommands: [],
      skills: [],
    } as unknown as ServerProvider;
    const mismatchedCachedOpenCode = makeProvider(OPENCODE_DRIVER, {
      instanceId: ProviderInstanceId.make("opencode_personal"),
    });

    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: legacyCachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: legacyCachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }),
      fallbackOpenCode,
    );
    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: mismatchedCachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: mismatchedCachedOpenCode,
        fallbackProvider: fallbackOpenCode,
      }),
      fallbackOpenCode,
    );
  });
});
