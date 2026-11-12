import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2)
    throw new Error(`Hosted composition anchor changed: ${before}`);
  return source.replace(before, after);
};

// Keep hosted acquisition policy out of the upstream Node composition.
export const hostedComposition = {
  name: "baskule-hosted-composition",
  setup(build) {
    const rewritten = new Set();
    const expected = [
      "server.ts",
      "ServerEnvironment.ts",
      "ServerEnvironmentLabel.ts",
      "McpOAuth.ts",
    ];
    build.onStart(() => {
      rewritten.clear();
    });
    build.onEnd((result) => {
      if (result.errors.length) return;
      const missing = expected.filter((target) => !rewritten.has(target));
      if (missing.length)
        throw new Error(`Hosted composition did not rewrite: ${missing.join(", ")}`);
    });
    build.onLoad({ filter: /\/apps\/server\/src\/server\.ts$/ }, ({ path }) => {
      let contents = NodeFS.readFileSync(path, "utf8");
      contents =
        `import * as HostedTrims from "./baskule/workerd/hostedTrims.ts";\nimport * as HostedLayers from "./baskule/workerd/hostedLayers.ts";\n` +
        contents;
      contents = replaceOnce(
        contents,
        "Layer.provideMerge(ProviderRegistry.layer)",
        "Layer.provideMerge(HostedLayers.layerProviderRegistry)",
      );
      contents = replaceOnce(
        contents,
        "Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer)",
        "Layer.mergeAll(HostedTrims.layerKeybindings, HostedLayers.layerEnvironmentTheme)",
      );
      contents = replaceOnce(
        contents,
        "Layer.provide(layerCommandReadiness)",
        "Layer.provide(HostedLayers.layerCommandReadiness)",
      );
      contents = replaceOnce(
        contents,
        "Layer.provide(SpeechModelStore.layer)",
        "Layer.provide(HostedTrims.layerSpeechModelStore)",
      );
      contents = replaceOnce(
        contents,
        "const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(\n  Layer.provide(ResourceMonitorBinary.layer),\n);",
        "const layerNativeTelemetry = HostedTrims.layerNativeTelemetry;",
      );
      contents = replaceOnce(
        contents,
        "const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(\n  Layer.provide(layerDesktopTelemetryReceiver),\n);",
        "const layerHostPowerMonitor = HostedTrims.layerHostPower;",
      );
      contents = replaceOnce(
        contents,
        "CloudManagedEndpointRuntime.layer.pipe(\n    Layer.provide(ServerSecretStore.layer),\n    Layer.provide(layerRelayClient),\n  )",
        "HostedTrims.layerManagedEndpoint",
      );
      contents = replaceOnce(
        contents,
        "AnalyticsService.layer.pipe(Layer.provide(ManagedPolicy.layer))",
        "HostedTrims.layerAnalytics",
      );
      rewritten.add("server.ts");
      return { contents, loader: "ts", resolveDir: NodePath.dirname(path) };
    });
    build.onLoad({ filter: /\/src\/environment\/ServerEnvironment\.ts$/ }, ({ path }) => {
      let contents = NodeFS.readFileSync(path, "utf8");
      contents = replaceOnce(
        contents,
        "const machine = yield* detectServerEnvironmentMachineKind();",
        "const machine = null;",
      );
      rewritten.add("ServerEnvironment.ts");
      return { contents, loader: "ts", resolveDir: NodePath.dirname(path) };
    });
    build.onLoad({ filter: /\/src\/environment\/ServerEnvironmentLabel\.ts$/ }, ({ path }) => {
      // Retain upstream normalization and fallback; a cell cannot probe host files or processes.
      const contents = replaceOnce(
        NodeFS.readFileSync(path, "utf8"),
        "const friendlyHostLabel = yield* resolveFriendlyHostLabel();",
        "const friendlyHostLabel = null;",
      );
      rewritten.add("ServerEnvironmentLabel.ts");
      return { contents, loader: "ts", resolveDir: NodePath.dirname(path) };
    });
    build.onLoad({ filter: /\/src\/auth\/McpOAuth\.ts$/ }, ({ path }) => {
      let contents =
        `import { deferredService } from "../baskule/workerd/deferredService.ts";\n` +
        NodeFS.readFileSync(path, "utf8");
      contents = replaceOnce(
        contents,
        `const signer = yield* PayloadSigner.fromSecret(
    yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );`,
        `const getSigner = yield* deferredService(Effect.gen(function* () {
    return yield* PayloadSigner.fromSecret(
      yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
    );
  }));`,
      );
      contents = replaceOnce(
        contents,
        "signer.sign(`${domain}.${payload}`)",
        "Effect.flatMap(getSigner, (loadedSigner) => loadedSigner.sign(`${domain}.${payload}`))",
      );
      contents = replaceOnce(
        contents,
        "signer.verify(`mcp-client-id.${body}`, signature)",
        "Effect.flatMap(getSigner, (loadedSigner) => loadedSigner.verify(`mcp-client-id.${body}`, signature))",
      );
      if (/\bsigner\b/.test(contents)) throw new Error("Review hosted OAuth signer uses");
      rewritten.add("McpOAuth.ts");
      return { contents, loader: "ts", resolveDir: NodePath.dirname(path) };
    });
  },
};
