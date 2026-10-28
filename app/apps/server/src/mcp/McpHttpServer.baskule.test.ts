// baskule: a space registers only the MCP tools its policy allows (rpcPolicy.ts `mcpTools`); toolkits are filtered
// before registration, so the refused tools are never decoded or described (boot time in a SpaceCell).
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpDeferredRegistrations from "../baskule/mcpDeferredRegistrations.ts";
import { BASKULE_POLICY, BaskuleRpcPolicy } from "../baskule/rpcPolicy.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const layerFor = (mcpTools: ReadonlySet<string> | undefined) =>
  McpHttpServer.layerPreviewToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-baskule-policy-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(
        BaskuleRpcPolicy,
        mcpTools === undefined ? undefined : { ...BASKULE_POLICY, mcpTools },
      ),
    ),
  );

const toolNames = Effect.map(Effect.service(McpServer.McpServer), (server) =>
  server.tools.map(({ tool }) => tool.name).sort(),
);

it.effect("registers only the tools the space policy allows", () =>
  Effect.gen(function* () {
    const names = yield* toolNames;
    expect(names).toEqual(["preview_act", "preview_status"]);
  }).pipe(
    Effect.provide(layerFor(new Set(["preview_status", "preview_act", "t3_thread_launch"]))),
  ),
);

it.effect("registers every tool without a policy (upstream behaviour)", () =>
  Effect.gen(function* () {
    const names = yield* toolNames;
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("preview_status");
  }).pipe(Effect.provide(layerFor(undefined))),
);

it.effect("registers nothing from a toolkit the policy refuses entirely", () =>
  Effect.gen(function* () {
    expect(yield* toolNames).toEqual([]);
  }).pipe(Effect.provide(layerFor(new Set(["delegate_task"])))),
);

it.effect("defers registration to the first request when the cell asks for it", () =>
  Effect.gen(function* () {
    expect(yield* toolNames).toEqual([]);
    const deferred = yield* Effect.service(McpDeferredRegistrations.McpDeferredRegistrations);
    yield* Effect.all([deferred.ensure, deferred.ensure], { concurrency: "unbounded" });
    expect(yield* toolNames).toEqual(["preview_act", "preview_status"]);
    yield* deferred.ensure;
    expect(yield* toolNames).toEqual(["preview_act", "preview_status"]);
  }).pipe(
    Effect.provide(
      layerFor(new Set(["preview_status", "preview_act"])).pipe(
        Layer.provideMerge(McpDeferredRegistrations.layer),
      ),
    ),
  ),
);
