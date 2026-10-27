// baskule: OpenCode 2.1 removed the required `recent` field from compaction
// events/messages. These fixtures are 2.1.2-shaped wire payloads; they must
// decode with the bundled @opencode/* schemas (2.0.28 rejected them).
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const SESSION = "ses_0123456789abcdefghijklmnop";
const CREATED = 1_792_000_000_000;

const durable = (seq: number) => ({ aggregateID: SESSION, seq, version: 1 });

const COMPACTION_EVENTS = [
  {
    id: "evt_01",
    created: CREATED,
    type: "session.compaction.started",
    durable: durable(1),
    location: { directory: "/baskule/scratch/chat" },
    data: { sessionID: SESSION, reason: "auto" },
  },
  {
    id: "evt_02",
    created: CREATED,
    type: "session.compaction.delta",
    data: { sessionID: SESSION, text: "Summary so far" },
  },
  {
    id: "evt_03",
    created: CREATED,
    type: "session.compaction.ended",
    durable: durable(2),
    data: {
      sessionID: SESSION,
      reason: "auto",
      text: "Summary so far, complete.",
      native: { messages: [] },
    },
  },
];

const COMPACTION_MESSAGES = [
  {
    id: "msg_01",
    type: "compaction",
    status: "running",
    reason: "manual",
    summary: "",
    time: { created: CREATED },
  },
  {
    id: "msg_02",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "Summary so far, complete.",
    native: { messages: [] },
    time: { created: CREATED },
  },
];

const fakeServer = HttpClient.make((request) =>
  Effect.sync(() => {
    const url = new URL(request.url);
    if (url.pathname === "/api/event") {
      const body = COMPACTION_EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    }
    if (url.pathname === `/api/session/${SESSION}/message`) {
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ data: COMPACTION_MESSAGES, cursor: {} }),
      );
    }
    return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }));
  }),
);

const withApi = <A, E>(use: (api: OpenCode2Client.OpenCode2Api) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    return yield* use(yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password: "x" }));
  }).pipe(
    Effect.provide(
      OpenCode2Client.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeServer))),
    ),
  );

describe("OpenCode 2.1 compaction wire format", () => {
  it.effect("decodes compaction events from the event stream", () =>
    withApi((api) =>
      Effect.gen(function* () {
        const stream = yield* api.events;
        const events = yield* Stream.runCollect(stream);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["session.compaction.started", "session.compaction.delta", "session.compaction.ended"],
        );
        const ended = events[2];
        assert(ended?.type === "session.compaction.ended");
        assert.strictEqual(ended.data.text, "Summary so far, complete.");
      }),
    ),
  );

  it.effect("decodes a message page containing compaction messages", () =>
    withApi((api) =>
      Effect.gen(function* () {
        const page = yield* api.client.message.list({ sessionID: SESSION as never });
        assert.deepStrictEqual(
          page.data.map((message) =>
            message.type === "compaction" ? `compaction:${message.status}` : message.type,
          ),
          ["compaction:running", "compaction:completed"],
        );
      }),
    ),
  );
});
