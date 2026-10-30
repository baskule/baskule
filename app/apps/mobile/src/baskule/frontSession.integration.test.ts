import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttp from "node:http";
import {
  type ConnectionCredential,
  connectionRegistrationCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import * as RemoteEnvironmentAuthorization from "../../../../packages/client-runtime/src/authorization/service.ts";
import * as ConnectionCredentialStore from "../../../../packages/client-runtime/src/connection/credentialStore.ts";
import * as ConnectionProfileStore from "../../../../packages/client-runtime/src/connection/profileStore.ts";
import * as ConnectionResolver from "../../../../packages/client-runtime/src/connection/resolver.ts";
import * as ClientCapabilities from "../../../../packages/client-runtime/src/platform/capabilities.ts";
import * as RpcSession from "../../../../packages/client-runtime/src/rpc/session.ts";
import { fetchMe, signIn } from "./api";
import { normalizeServerUrl } from "./config";
import { fetchSpaceEnvironmentId, spaceRegistration } from "./registrations";
// baskule: the phone's connection path against a real Baskule 0.2 server (platform/dev.sh), in Node: Better Auth sign-in → /api/baskule/me → one front-
// session registration per space → the shared client-runtime resolver (descriptor with the bearer, no ticket) → its RPC session over a WebSocket whose
// upgrade carries `Authorization` → the space's server config snapshot. Skipped unless BASKULE_TEST_SERVER_URL, BASKULE_TEST_EMAIL and BASKULE_TEST_PASSWORD
// are set.

const serverUrl = normalizeServerUrl(process.env.BASKULE_TEST_SERVER_URL ?? "");
const email = process.env.BASKULE_TEST_EMAIL ?? "";
const password = process.env.BASKULE_TEST_PASSWORD ?? "";

const unused = () => Effect.die("not used by front-session environments");

/**
 * A fetch without `Sec-Fetch-*` headers, like the phone's (OkHttp). Node's fetch adds them, and
 * Better Auth then demands an Origin header, which a native client does not send.
 */
const nativeLikeFetch = ((input: string, init: RequestInit = {}) =>
  new Promise<Response>((resolve, reject) => {
    const request = NodeHttp.request(
      input,
      { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)) },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers.set(key, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), { status: response.statusCode ?? 0, headers }),
          );
        });
      },
    );
    request.on("error", reject);
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  })) as unknown as typeof fetch;

describe.skipIf(serverUrl === null || email === "")("Baskule front-session (real server)", () => {
  it("signs in, registers every space and opens each space's RPC session", async () => {
    const server = serverUrl!;
    const token = await signIn(server, email, password, nativeLikeFetch);
    const me = await fetchMe(server, token, nativeLikeFetch);
    expect(me.spaces.length).toBeGreaterThan(0);

    const credentials = new Map<string, ConnectionCredential>();
    const layerDependencies = Layer.mergeAll(
      layerRemoteHttpClient(fetch),
      NodeSocket.layerWebSocketConstructorWS,
      Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
        get: () => Effect.succeed(Option.none()),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
      Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
        get: (id) => Effect.succeed(Option.fromNullishOr(credentials.get(id))),
        put: (id, credential) => Effect.sync(() => void credentials.set(id, credential)),
        remove: (id) => Effect.sync(() => void credentials.delete(id)),
      }),
      Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
        bearerToken: Effect.succeed(Option.none()),
      }),
      Layer.succeed(ClientCapabilities.ClientPresentation, {
        metadata: { label: "Baskule test", deviceType: "mobile", surface: "mobile" },
      }),
      Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
        authorizeBearer: unused,
        authorizeDpop: unused,
        authorizeDpopHttp: unused,
      }),
      Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
        provision: unused,
        prepare: unused,
        disconnect: () => Effect.void,
      }),
    );
    const layer = Layer.mergeAll(
      ConnectionResolver.layer,
      RpcSession.layer({
        environmentThemes: true,
        usageLimitsCommand: true,
      }),
    ).pipe(Layer.provideMerge(layerDependencies));

    for (const space of me.spaces) {
      const environmentId = await fetchSpaceEnvironmentId(server, token, space);
      expect(environmentId, `descriptor of ${space.name}`).not.toBeNull();
      const registration = spaceRegistration({
        serverUrl: server,
        token,
        space,
        environmentId: environmentId!,
      });
      credentials.set(registration.target.connectionId, registration.credential);

      const config = await Effect.gen(function* () {
        const resolver = yield* ConnectionResolver.ConnectionResolver;
        const prepared = yield* resolver.prepare(connectionRegistrationCatalogEntry(registration));
        expect(new URL(prepared.socketUrl).searchParams.has("wsTicket")).toBe(false);
        const factory = yield* RpcSession.RpcSessionFactory;
        const session = yield* factory.connect(prepared);
        return yield* session.initialConfig;
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise);

      expect(config.environment.environmentId).toBe(environmentId);
      console.log(`space ${space.name}: connected, environment ${environmentId}`);
    }
  });
});
