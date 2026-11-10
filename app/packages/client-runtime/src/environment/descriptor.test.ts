import { BASKULE_RELEASE, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchRemoteEnvironmentDescriptor } from "./descriptor.ts";

it.effect(
  "reads current compatibility instead of a cached descriptor while preserving fetch options",
  () =>
    Effect.gen(function* () {
      const requests: RequestInit[] = [];
      const fetchFn: typeof fetch = async (_input, init = {}) => {
        requests.push(init);
        return Response.json({
          environmentId: "environment-personal",
          label: "Personal",
          platform: { os: "linux", arch: "x64" },
          serverVersion: init.cache === "no-store" ? BASKULE_RELEASE.version : "99.0.0",
          minClient: init.cache === "no-store" ? BASKULE_RELEASE.minClient : "99.0.0",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        });
      };
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://baskule.example/s/personal/",
      }).pipe(
        Effect.provide(layerRemoteHttpClient(fetchFn)),
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: "include",
          redirect: "manual",
          cache: "force-cache",
        }),
      );
      expect(descriptor.serverVersion).toBe(BASKULE_RELEASE.version);
      expect(descriptor.minClient).toBe(BASKULE_RELEASE.minClient);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        credentials: "include",
        redirect: "manual",
        cache: "no-store",
      });
    }),
);
