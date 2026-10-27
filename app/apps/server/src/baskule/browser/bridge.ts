// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off - Private Node transport around upstream Effect services.
// Runs inside the space computer. The authenticated computerd tunnel is its only ingress.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeFS from "node:fs";
import { WebSocketServer } from "ws";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD,
  previewUploadFileName,
} from "@t3tools/contracts";
import * as Config from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as Manager from "../../preview/Manager.ts";
import * as Browser from "../../preview/ServerBrowser.ts";
import * as Executable from "../../preview/PreviewBrowser.ts";
import * as Desktop from "../../preview/DesktopBrowserChannel.ts";

process.env.BASKULE_BROWSER_BRIDGE = "1";
const root = process.env.BASKULE_BROWSER_HOME ?? `${process.env.HOME}/.baskule-browser`;
const environmentId = EnvironmentId.make("baskule-computer-browser");
const config = Config.layerTest(root, root).pipe(Layer.provide(NodeServices.layer));
const dependencies = Layer.mergeAll(
  Manager.layer,
  Broker.layer,
  Layer.succeed(Environment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("No public descriptor on private browser bridge"),
  }),
  Layer.succeed(Executable.PreviewBrowser, {
    executable: Effect.succeed(process.env.CHROME_PATH ?? "/usr/local/bin/chromium-baskule"),
    installed: Effect.succeed(
      Option.some(process.env.CHROME_PATH ?? "/usr/local/bin/chromium-baskule"),
    ),
  }),
  Desktop.layer.pipe(Layer.provide(config)),
).pipe(Layer.provideMerge(config), Layer.provideMerge(NodeServices.layer));
const runtime = ManagedRuntime.make(Browser.layer.pipe(Layer.provideMerge(dependencies)));
const services = await runtime.runPromise(
  Effect.gen(function* () {
    return {
      manager: yield* Manager.PreviewManager,
      browser: yield* Browser.ServerBrowser,
      broker: yield* Broker.PreviewAutomationBroker,
    };
  }),
);
await runtime.runPromise(
  services.browser.reportProfiles({ profiles: [], defaultProfileId: "default" }),
);
const json = (res: NodeHttp.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const methods = new Set([
  "open",
  "navigate",
  "resize",
  "adjust",
  "refresh",
  "close",
  "list",
  "reportStatus",
  "requestReveal",
]);
const server = NodeHttp.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://browser");
  try {
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (url.pathname === "/list")
      return json(res, 200, {
        result: await runtime.runPromise(
          services.manager.list({
            threadId: ThreadId.make(url.searchParams.get("threadId") ?? ""),
          }),
        ),
      });
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.flushHeaders();
      const fiber = runtime.runFork(
        Stream.runForEach(services.manager.events, (event) =>
          Effect.sync(() => {
            if (!res.write(JSON.stringify(event) + "\n") && res.writableLength > 1024 * 1024)
              res.destroy();
          }),
        ),
      );
      const timer = setInterval(() => res.write("\n"), 10000);
      res.on("close", () => {
        clearInterval(timer);
        Effect.runFork(Fiber.interrupt(fiber));
      });
      return;
    }
    if (url.pathname === "/upload" && req.method === "POST") {
      const request = new Request("http://browser/upload", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body: NodeStream.Readable.toWeb(req) as ReadableStream,
        duplex: "half",
      } as RequestInit);
      const form = await request.formData();
      const files: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];
      for (const value of form.values()) {
        if (typeof value === "string") continue;
        if (files.length >= 20 || value.size > 100 * 1024 * 1024)
          return json(res, 413, { error: "Upload too large" });
        let name: string;
        try {
          name = previewUploadFileName(
            value.name,
            form.get(PREVIEW_UPLOAD_FILENAME_ENCODING_FIELD),
          );
        } catch {
          return json(res, 400, { error: "Invalid upload filename encoding" });
        }
        files.push({
          name,
          mimeType: value.type,
          buffer: Buffer.from(await value.arrayBuffer()),
        });
      }
      const accepted = await runtime.runPromise(
        services.browser.answerFileChooser({
          threadId: url.searchParams.get("threadId") ?? "",
          tabId: url.searchParams.get("tabId") ?? "",
          chooserId: url.searchParams.get("chooser") ?? "",
          files,
        }),
      );
      return json(res, accepted ? 200 : 409, { accepted });
    }
    if (url.pathname === "/download") {
      const found = await runtime.runPromise(
        services.browser.openDownload({
          threadId: url.searchParams.get("threadId") ?? "",
          tabId: url.searchParams.get("tabId") ?? "",
          downloadId: url.searchParams.get("id") ?? "",
        }),
      );
      if (Option.isNone(found)) return json(res, 404, { error: "Download no longer available" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.value.fileName)}`,
      });
      NodeFS.createReadStream(found.value.path).pipe(res);
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/call")
      return json(res, 404, { error: "Not found" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error("Request too large");
      chunks.push(chunk);
    }
    const { method, input } = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (methods.has(method))
      result = await runtime.runPromise(services.manager[method as "list"](input));
    else if (method === "clearProfile")
      result = await runtime.runPromise(services.browser.clearProfile(input.profileId));
    else if (method === "reportProfiles")
      result = await runtime.runPromise(services.browser.reportProfiles(input));
    else if (method === "automation") {
      result = await runtime.runPromise(
        services.broker.invoke({
          operation: input.operation,
          input: input.input,
          tabId: input.tabId,
          timeoutMs: input.timeoutMs,
          scope: {
            environmentId,
            thread: {
              threadId: ThreadId.make(input.threadId),
              providerSessionId: input.agentSessionId ?? "baskule-agent",
              providerInstanceId: ProviderInstanceId.make("opencode"),
            },
            client: undefined,
            requestNamespace: "baskule",
            capabilities: new Set(["preview"]),
            issuedAt: Date.now(),
          },
        }),
      );
    } else return json(res, 404, { error: "Unknown browser method" });
    json(res, 200, { result: result ?? null });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 1024 * 1024,
});
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url!, "http://browser");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const scope = await runtime.runPromise(Scope.make());
    const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
    ws.once("close", () => {
      void close().catch(() => {});
    });
    ws.on("error", () => ws.close());
    try {
      const viewer = await runtime.runPromise(
        services.browser
          .attachViewer({
            threadId: url.searchParams.get("threadId") ?? "",
            tabId: url.searchParams.get("tabId") ?? "",
            maxWidth: Math.min(Number(url.searchParams.get("maxWidth")) || 1280, 7680),
            maxHeight: Math.min(Number(url.searchParams.get("maxHeight")) || 800, 4320),
            quality: 70,
            canOperate: url.searchParams.get("interactive") !== "false",
          })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      );
      let ack: Effect.Effect<void> | null = null;
      let pending: Extract<Browser.ServerBrowserViewerOutput, { _tag: "frame" }> | null = null;
      const frame = (out: Extract<Browser.ServerBrowserViewerOutput, { _tag: "frame" }>) => {
        ack = out.ack;
        ws.send(out.data);
      };
      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "ack") {
            if (ack) Effect.runFork(ack);
            ack = null;
            if (pending) {
              const next = pending;
              pending = null;
              frame(next);
            }
          } else Effect.runFork(viewer.input(message));
        } catch {
          ws.close(1003, "Invalid input");
        }
      });
      await runtime.runPromise(
        Effect.forever(
          Queue.take(viewer.output).pipe(
            Effect.flatMap((output) =>
              Effect.sync(() => {
                if (ws.readyState !== ws.OPEN) return;
                if (ws.bufferedAmount > 8 * 1024 * 1024) {
                  ws.close(1013, "Viewer too slow");
                  return;
                }
                if (output._tag === "frame") {
                  if (ack) {
                    if (pending) Effect.runFork(pending.ack);
                    pending = output;
                  } else frame(output);
                } else if (output._tag === "gone") ws.close(4404, "Tab closed");
                else if (output._tag === "reconnect") ws.close(1012, "Reconnect");
                else {
                  const { _tag: type, ...data } = output;
                  ws.send(JSON.stringify({ type, ...data }));
                }
              }),
            ),
          ),
        ).pipe(Effect.forkIn(scope)),
      );
    } catch (error) {
      ws.close(1011, "Browser could not start");
      console.error(String(error));
      await close();
    }
  });
});
server.listen(Number(process.env.BASKULE_BROWSER_PORT ?? 9223), "127.0.0.1");
const shutdown = async () => {
  wss.close();
  server.close();
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
