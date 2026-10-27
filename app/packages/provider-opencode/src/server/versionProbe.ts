import { parseSemver } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

export interface ProbedOpenCode {
  readonly version: string;
}

// Meant to stop a hung `--version`; wrapped installs can take several seconds to start cold.
const OPENCODE_VERSION_PROBE_TIMEOUT = "10 seconds";
const OPENCODE_SERVER_PROBE_TIMEOUT = "5 seconds";
// 2.x's own CLI decodes `{version, pid}` from `/api/info`; requiring both keeps unrelated JSON out.
const decodeApiInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Int })),
);

const unsupportedVersionDetail = (version: string) =>
  `OpenCode v${version} is not supported. T3 Code requires OpenCode 2.x (v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer within 2.x).`;

function versionOf(output: string | undefined): string | undefined {
  return output !== undefined && parseSemver(output) !== null ? output : undefined;
}

const requireOpenCode2 = Effect.fn("requireOpenCode2")(function* (
  operation: string,
  version: string,
) {
  if ((parseSemver(version)?.major ?? 0) === 2) return { version } satisfies ProbedOpenCode;
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation,
    detail: unsupportedVersionDetail(version),
  });
});

const probeOpenCodeBinary = Effect.fn("probeOpenCodeBinary")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv | undefined,
) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const { stdout } = yield* runtime
    .runOpenCodeCommand({
      binaryPath,
      args: ["--version"],
      ...(environment === undefined ? {} : { environment }),
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: OPENCODE_VERSION_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "probeOpenCodeBinary",
              detail: `OpenCode CLI version probe timed out after ${OPENCODE_VERSION_PROBE_TIMEOUT}.`,
            }),
          ),
      }),
    );
  const version = versionOf(parseGenericCliVersion(stdout) ?? undefined);
  if (version !== undefined) return yield* requireOpenCode2("probeOpenCodeBinary", version);
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation: "probeOpenCodeBinary",
    detail: `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode 2.x (v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer within 2.x).`,
  });
});

/**
 * Only a JSON `/api/info` body identifies an OpenCode 2 server: other servers (and 1.x) answer that
 * path with their web UI's HTML.
 *
 * Server failures reach clients through the provider status, so their details are fixed text: the
 * underlying error can carry the configured URL, its credentials, or the password header.
 */
const probeOpenCodeServer = Effect.fn("probeOpenCodeServer")(function* (
  serverUrl: string,
  serverPassword: string,
) {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = URL.parse(serverUrl.trim());
  if (baseUrl?.protocol !== "http:" && baseUrl?.protocol !== "https:") {
    return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "probeOpenCodeServer",
      detail: "The OpenCode server URL is not a valid http:// or https:// URL.",
    });
  }
  // UTF-8, as OpenCode's own clients send it; `HttpClientRequest.basicAuth` uses Latin-1 `btoa`.
  const authorization = serverPassword
    ? `Basic ${Buffer.from(`opencode:${serverPassword}`, "utf8").toString("base64")}`
    : undefined;
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/info`;
  const request = HttpClientRequest.get(url.href);
  const response = yield* client
    .execute(
      authorization
        ? HttpClientRequest.setHeader(request, "authorization", authorization)
        : request,
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (body) => ({
          status: response.status,
          contentType: response.headers["content-type"],
          body,
        })),
      ),
      Effect.mapError(
        (cause) =>
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "probeOpenCodeServer",
            detail: "Couldn't reach the OpenCode server.",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: OPENCODE_SERVER_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "probeOpenCodeServer",
              detail: "Timed out while checking the OpenCode server version.",
            }),
          ),
      }),
    );
  if (response.status === 401) {
    return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "probeOpenCodeServer",
      detail: "401 Unauthorized: the OpenCode server rejected the password.",
    });
  }
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  const version =
    response.status === 200 && mediaType === "application/json"
      ? versionOf(
          Option.getOrUndefined(Option.map(decodeApiInfo(response.body), (info) => info.version)),
        )
      : undefined;
  if (version !== undefined) return yield* requireOpenCode2("probeOpenCodeServer", version);
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation: "probeOpenCodeServer",
    detail: `The server did not identify itself as OpenCode 2. T3 Code requires OpenCode 2.x (v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer within 2.x).`,
  });
});

export const probeOpenCodeRuntime = (
  settings: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly serverPassword: string;
    readonly managedRuntime?: { readonly version: string } | null;
  },
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  ProbedOpenCode,
  OpenCodeRuntime.OpenCodeRuntimeError,
  HttpClient.HttpClient | OpenCodeRuntime.OpenCodeRuntime
> =>
  settings.managedRuntime
    ? Effect.succeed({ version: settings.managedRuntime.version })
    : settings.serverUrl.trim().length > 0
      ? probeOpenCodeServer(settings.serverUrl, settings.serverPassword)
      : probeOpenCodeBinary(settings.binaryPath, environment);

export const makeOpenCodeRuntimeProbe = <E>(probe: Effect.Effect<ProbedOpenCode, E>) =>
  Effect.map(
    Cache.makeWith(() => probe, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
    (cache) => ({
      get: Cache.get(cache, undefined),
      refresh: Cache.refresh(cache, undefined),
    }),
  );
