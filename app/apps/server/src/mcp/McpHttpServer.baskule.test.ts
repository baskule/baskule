import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// baskule: a space registers only the MCP tools its policy allows (rpcPolicy.ts `mcpTools`); toolkits are filtered
// before registration, so the refused tools are never decoded or described (boot time in a SpaceCell).
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpDeferredRegistrations from "../baskule/mcpDeferredRegistrations.ts";
import { BASKULE_POLICY, BaskuleRpcPolicy } from "../baskule/rpcPolicy.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const layerFor = (mcpTools: ReadonlySet<string> | undefined) =>
  McpHttpServer.layerPreviewToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-baskule-policy-test-" }),
    ),
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
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
  }).pipe(Effect.provide(layerFor(new Set(["preview_status", "preview_act", "t3_thread_launch"])))),
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

it.effect("advertises the secretRef flow in hosted spaces", () => {
  const toolkit = Toolkit.make(OrchestratorToolkit.tools.request_secret);
  const registration = McpHttpServer.toolkitRegistration(
    toolkit,
    McpToolAccess.toLayer(toolkit, {
      request_secret: McpToolAccess.actsAsCaller(() => Effect.die("registration only")),
    }),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const request = server.tools.find(({ tool }) => tool.name === "request_secret")?.tool;
    expect(request?.description).toContain("secretRef");
    expect(Object.keys(request?.inputSchema.properties ?? {}).sort()).toEqual([
      "clientRequestId",
      "label",
      "placeholder",
      "reason",
      "timeoutMs",
      "url",
    ]);
    expect(request?.outputSchema).toMatchObject({
      anyOf: [
        { properties: { secretRef: { type: "string" } }, required: ["status", "secretRef"] },
        {
          properties: {
            status: { enum: ["declined", "cancelled", "timed_out"] },
            note: expect.any(Object),
          },
          required: ["status"],
        },
      ],
    });
    expect(JSON.stringify(request?.outputSchema)).not.toMatch(/"files?":/);
  }).pipe(
    Effect.provide(
      registration.pipe(
        Layer.provideMerge(layerFor(new Set())),
        Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
        Layer.provide(Layer.succeed(BaskuleRpcPolicy, BASKULE_POLICY)),
      ),
    ),
  );
});

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
