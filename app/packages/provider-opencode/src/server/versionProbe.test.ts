import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { makeOpenCodeRuntimeProbe, probeOpenCodeRuntime } from "./versionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";

const noBinary = {
  runOpenCodeCommand: () => Effect.die("A configured server must not run the local binary"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const binaryPrinting = (stdout: string) =>
  ({
    runOpenCodeCommand: () => Effect.succeed({ stdout, stderr: "", code: 0 }),
  }) as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

const probeServer = (serverUrl: string, serverPassword: string, http: HttpClient.HttpClient) =>
  probeOpenCodeRuntime({ binaryPath: "opencode", serverUrl, serverPassword }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, noBinary),
  );
const probeBinary = (stdout: string) =>
  probeOpenCodeRuntime({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }).pipe(
    Effect.provideService(HttpClient.HttpClient, noHttp),
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, binaryPrinting(stdout)),
  );
const SERVER_URL = "http://127.0.0.1:4096/";

describe("OpenCode version probe", () => {
  it.effect("uses the host-owned runtime even when HTTP discovery would fail", () =>
    Effect.gen(function* () {
      const broken = HttpClient.make(() => Effect.die("Managed runtime must not probe HTTP"));
      const result = yield* probeOpenCodeRuntime({
        binaryPath: "opencode",
        serverUrl: "http://agent/oc",
        serverPassword: "",
        managedRuntime: { version: "2.1.3" },
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, broken),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, noBinary),
      );
      assert.deepStrictEqual(result, { version: "2.1.3" });
    }),
  );

  it.effect("reads the recorded `opencode --version` output of OpenCode 2", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* probeBinary("opencode v2.0.18\n"), { version: "2.0.18" });
    }),
  );

  it.effect("rejects an OpenCode 1.x binary and unparseable version output", () =>
    Effect.gen(function* () {
      const old = yield* Effect.flip(probeBinary("1.18.32\n"));
      assert.match(old.detail, /OpenCode v1\.18\.32 is not supported/);
      const future = yield* Effect.flip(probeBinary("3.0.0\n"));
      assert.match(future.detail, /OpenCode v3\.0\.0 is not supported/);
      const unknown = yield* Effect.flip(probeBinary("opencode dev build\n"));
      assert.match(unknown.detail, /Unable to determine OpenCode version/);
    }),
  );

  it.effect("finds 2.x at /api/info", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const probed = yield* probeServer(
        SERVER_URL,
        "pw",
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "pw", paths),
      );
      assert.deepStrictEqual(probed, { version: "2.0.18" });
      assert.deepStrictEqual(paths, ["/api/info"]);
    }),
  );

  it.effect("rejects a 1.x server, which serves HTML at /api/info", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        probeServer(SERVER_URL, "pw", replayOpenCodeServer(OPENCODE_1_RESPONSES, "pw")),
      );
      assert.match(error.detail, /did not identify itself as OpenCode 2/);
    }),
  );

  it.effect("keeps a server URL's path prefix and query when probing", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const replay = replayOpenCodeServer(OPENCODE_2_RESPONSES, "pw");
      const proxied = HttpClient.make((request, url) => {
        urls.push(url.href);
        return replay.execute(
          HttpClientRequest.setUrl(
            request,
            `http://127.0.0.1:4096${url.pathname.replace(/^\/opencode/, "")}`,
          ),
        );
      });
      const probed = yield* probeServer("http://proxy:8080/opencode/?route=oc", "pw", proxied);
      assert.strictEqual(probed.version, "2.0.18");
      assert.deepStrictEqual(urls, ["http://proxy:8080/opencode/api/info?route=oc"]);
    }),
  );

  it.effect("reports a rejected password instead of guessing a version", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const error = yield* Effect.flip(
        probeServer(SERVER_URL, "wrong", replayOpenCodeServer(OPENCODE_2_RESPONSES, "pw", paths)),
      );
      assert.match(error.detail, /401 Unauthorized/);
      assert.deepStrictEqual(paths, ["/api/info"]);
    }),
  );

  it.effect("sends a non-ASCII password as UTF-8", () =>
    Effect.gen(function* () {
      const probed = yield* probeServer(
        SERVER_URL,
        "pass€word",
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "pass€word"),
      );
      assert.strictEqual(probed.version, "2.0.18");
    }),
  );

  it.effect("does not take other JSON at /api/info for OpenCode 2", () =>
    Effect.gen(function* () {
      const impostor = {
        ...OPENCODE_2_RESPONSES,
        "/api/info": { status: 200, contentType: "application/json", body: '{"version":"3.4.1"}' },
      };
      const error = yield* Effect.flip(
        probeServer(SERVER_URL, "pw", replayOpenCodeServer(impostor, "pw")),
      );
      assert.match(error.detail, /did not identify itself as OpenCode/);
    }),
  );

  it.effect("never puts the configured URL or its credentials in an error detail", () =>
    Effect.gen(function* () {
      const secret = "userinfo-secret";
      const unreachable = HttpClient.make((request) =>
        Effect.die(`should not be reached for ${request.url}`),
      );
      // A fetch failure that echoes the full request URL, as Node's does.
      const refused = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: `connect ECONNREFUSED ${request.url}`,
            }),
          }),
        ),
      );
      for (const [serverUrl, http] of [
        [`127.0.0.1:4096?token=${secret}`, unreachable],
        [`localhost:4096/${secret}`, unreachable],
        [`http://user:${secret}@10.0.0.1:4096/?token=${secret}`, refused],
      ] as const) {
        const error = yield* Effect.flip(probeServer(serverUrl, secret, http));
        assert.notInclude(error.detail, secret, serverUrl);
        assert.notInclude(error.detail, "10.0.0.1", serverUrl);
      }
    }),
  );

  it.effect("remembers a probed runtime but never a failure", () =>
    Effect.gen(function* () {
      const outputs = ["", "opencode v2.0.18\n", "opencode v2.1.2\n"];
      let calls = 0;
      const runtime = {
        runOpenCodeCommand: () => {
          const stdout = outputs[calls++];
          return stdout
            ? Effect.succeed({ stdout, stderr: "", code: 0 })
            : Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({ operation: "spawn", detail: "ENOENT" }),
              );
        },
      } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
      const probe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
          Effect.provideService(HttpClient.HttpClient, noHttp),
        ),
      );

      yield* Effect.flip(probe.get);
      assert.strictEqual((yield* probe.get).version, "2.0.18");
      assert.strictEqual((yield* probe.get).version, "2.0.18");
      assert.strictEqual(calls, 2);
      assert.strictEqual((yield* probe.refresh).version, "2.1.2");
      assert.strictEqual((yield* probe.get).version, "2.1.2");
      assert.strictEqual(calls, 3);
    }),
  );
});
