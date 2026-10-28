import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASKULE_TRANSCRIPTION, BASKULE_AI_PROVIDERS, BASKULE_TRANSCRIPTION_MAX_BYTES } from "../../../app/packages/contracts/src/baskule";
import { defaultSettings, parseSettings } from "../../src/control/settings";
import { asAdmin, call, createUser, makeService, ORIGIN, signIn, type Creds, type H } from "../support/harness";

const settingsPath = "/api/baskule/admin/settings";
const route = "/api/baskule/transcriptions";
const key = "private-transcription-key";
const settings = { ...defaultSettings, transcription: { ...DEFAULT_BASKULE_TRANSCRIPTION, baseUrl: "https://transcribe.example.test/v1/" } };

async function configured() {
  const h = await makeService();
  const admin = await asAdmin(h);
  const saved = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...settings, transcriptionApiKey: key } });
  expect(saved.status).toBe(200);
  return { h, admin };
}

function transcribe(h: H, creds: Creds = {}, body: BodyInit | null = "audio bytes", headers: Record<string, string> = {}) {
  return h.svc.handle(new Request(ORIGIN + route, {
    method: "POST", body, ...{ duplex: "half" },
    headers: { origin: ORIGIN, ...(creds.cookie ? { cookie: creds.cookie } : {}), "content-type": "audio/webm;codecs=opus", ...headers },
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("transcription settings", () => {
  it("keeps OpenAI voice configured while chat uses keyless OpenCode", async () => {
    const { h, admin } = await configured();
    // OpenCode's free model answers the connection check.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [] }));
    const provider = BASKULE_AI_PROVIDERS.opencode;
    const body = { ...settings, ai: { providerId: "opencode", baseUrl: provider.baseUrl, model: provider.models[0] } };
    const saved = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...body, apiKey: "ignored-key" } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ apiKeyConfigured: true, transcriptionApiKeyConfigured: true });
    expect((await call(h, "GET", "/api/baskule/me", { creds: admin.creds })).body.voiceInput).toBe(true);
    expect(h.storage.sql.exec("select value from kv where key=?", `llm_api_key:${JSON.stringify(["opencode", provider.baseUrl])}`).toArray()).toEqual([]);
    h.calls.length = 0;
    const cleared = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...body, transcriptionApiKey: "" } });
    expect(cleared.body).toMatchObject({ apiKeyConfigured: true, transcriptionApiKeyConfigured: false });
    expect((await call(h, "GET", "/api/baskule/me", { creds: admin.creds })).body.voiceInput).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("PATCHes a GET response after removing the view-only fields used by stack and e2e scripts", async () => {
    const { h, admin } = await configured();
    const view = await call(h, "GET", settingsPath, { creds: admin.creds });
    const { apiKeyConfigured: _chat, transcriptionApiKeyConfigured: _voice, authentication: _auth, ...writable } = view.body;
    expect((await call(h, "PATCH", settingsPath, { creds: admin.creds, body: writable })).status).toBe(200);
    expect((await call(h, "GET", settingsPath, { creds: admin.creds })).body).toEqual(view.body);
  });

  it("requires explicit transcription settings and validates their fields", () => {
    const { transcription, ...stored } = defaultSettings;
    expect(() => parseSettings(stored)).toThrow(/transcription/);
    expect(parseSettings({ ...stored, transcription: { ...transcription, model: "  custom-model  " } }).transcription.model).toBe("custom-model");
    for (const invalid of [
      { enabled: "true" }, { providerId: "anthropic" }, { baseUrl: "https://user:secret@example.test/v1" },
      { baseUrl: "https://example.test/v1?key=secret" }, { baseUrl: "ftp://example.test" },
      { model: " " }, { model: "m".repeat(201) }, { extra: true },
    ]) expect(() => parseSettings({ ...stored, transcription: { ...transcription, ...invalid } })).toThrow();
  });

  it("shares an OpenAI chat key, rejects conflicting writes and reloads only when that key changes", async () => {
    // OpenAI accepts every key here; the chat connection is checked whenever its shared key changes.
    using openai = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => Response.json({ id: String(input).split("/").at(-1) }));
    const h = await makeService();
    const admin = await asAdmin(h);
    const shared = { ...defaultSettings, ai: { providerId: "openai", baseUrl: DEFAULT_BASKULE_TRANSCRIPTION.baseUrl, model: BASKULE_AI_PROVIDERS.openai.models[0] } };
    const save = (keys: Record<string, unknown>) => call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...shared, ...keys } });
    const saved = await save({ apiKey: key });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ apiKeyConfigured: true, transcriptionApiKeyConfigured: true });
    expect(JSON.stringify(saved.body)).not.toContain(key);
    const me = await call(h, "GET", "/api/baskule/me", { creds: admin.creds });
    expect(me.body.voiceInput).toBe(true);
    expect(JSON.stringify(me.body)).not.toContain(key);
    h.calls.length = 0;
    const conflict = await save({ apiKey: "other-key", transcriptionApiKey: key });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toBe("conflicting_api_keys");
    expect(h.calls).toEqual([]);
    expect((await save({ apiKey: key, transcriptionApiKey: key })).status).toBe(200);
    expect(h.calls).toEqual([]);
    expect((await save({ transcriptionApiKey: "replacement-key" })).status).toBe(200);
    expect(h.calls.map(c => c.path)).toEqual(["/_baskule/reconfigure"]);
    h.calls.length = 0;
    const rejected = await call(h, "PATCH", settingsPath, { creds: admin.creds, body: {
      ...shared, organizationName: "Must not persist", apiKey: "must-not-persist", transcriptionApiKey: "",
    } });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: "shared_api_key", message: "This key is shared with chat; change it on AI → Models" });
    expect(h.calls).toEqual([]);
    const unchanged = await call(h, "GET", settingsPath, { creds: admin.creds });
    expect(unchanged.body.organizationName).toBe(shared.organizationName);
    expect(h.storage.sql.exec("select value from kv where key=?", `llm_api_key:${JSON.stringify([shared.ai.providerId, shared.ai.baseUrl])}`).toArray()[0].value).toBe("replacement-key");
    expect(openai.mock.calls.map(([url]) => String(url))).toEqual(Array(2).fill(`${shared.ai.baseUrl}/models/${shared.ai.model.id}`));
    // OpenAI chat cannot run without its key, so the shared key stays.
    expect((await save({ apiKey: "" })).body.error).toBe("ai_key_missing");
    expect(h.calls).toEqual([]);
    expect((await call(h, "GET", "/api/baskule/me", { creds: admin.creds })).body.voiceInput).toBe(true);
  });

  it("saves and clears a separate transcription key without reloading spaces", async () => {
    const { h, admin } = await configured();
    expect(h.calls).toEqual([]);
    const save = (body: Record<string, unknown>) => call(h, "PATCH", settingsPath, { creds: admin.creds, body: { ...settings, ...body } });
    expect((await save({ transcription: { ...settings.transcription, enabled: false, model: "other-model" } })).body.transcriptionApiKeyConfigured).toBe(true);
    expect((await call(h, "GET", "/api/baskule/me", { creds: admin.creds })).body.voiceInput).toBe(false);
    for (const invalid of [null, 5, "x".repeat(8193)]) {
      const response = await save({ transcriptionApiKey: invalid });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("invalid_api_key");
    }
    expect((await save({ transcriptionApiKey: "" })).body.transcriptionApiKeyConfigured).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe("transcriptions", () => {
  it("requires a session and returns 404 without a key or when disabled", async () => {
    const h = await makeService();
    const admin = await asAdmin(h);
    expect((await transcribe(h)).status).toBe(401);
    const missing = await transcribe(h, admin.creds);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "voice_input_disabled" });
    await call(h, "PATCH", settingsPath, { creds: admin.creds, body: {
      ...settings, transcription: { ...settings.transcription, enabled: false }, transcriptionApiKey: key,
    } });
    const disabled = await transcribe(h, admin.creds);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ error: "voice_input_disabled" });
  });

  it("rejects non-audio and empty recordings before contacting the provider", async () => {
    const { h, admin } = await configured();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const [body, type] of [["bytes", "audio/unknown"], ["bytes", "audio/toString"], ["bytes", "application/json"], ["bytes", ""], ["", "audio/webm"], [null, "audio/mp4"]] as const) {
      const response = await transcribe(h, admin.creds, body, { "content-type": type });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_audio" });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects content-length over the cap before reading the body", async () => {
    const { h, admin } = await configured();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await transcribe(h, admin.creds, body, { "content-length": String(BASKULE_TRANSCRIPTION_MAX_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "audio_too_large" });
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("caps a streaming body with content-length %s", async contentLength => {
    const { h, admin } = await configured();
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); }, cancel });
    const response = await transcribe(h, admin.creds, body, contentLength === undefined ? {} : { "content-length": contentLength });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "audio_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("lets a member transcribe raw audio through multipart and trims the returned text", async () => {
    const { h, admin } = await configured();
    await createUser(h, admin.creds, "member@os.test", "Member");
    const member = await signIn(h, "member@os.test", "user-password-1");
    expect(member.status).toBe(200);
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://transcribe.example.test/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = await new Request(url, init).formData();
      expect([...form.keys()].sort()).toEqual(["file", "model", "response_format"]);
      expect(form.get("model")).toBe(settings.transcription.model);
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("missing file");
      expect(await file.text()).toBe("audio bytes");
      return Response.json({ text: "  Transcribed words.\n" });
    });
    vi.stubGlobal("fetch", upstream);
    for (const [type, extension] of [
      ["audio/webm;codecs=opus", "webm"], ["audio/mp4", "mp4"], ["audio/mpeg", "mp3"], ["audio/ogg", "ogg"],
      ["audio/wav", "wav"], ["audio/x-m4a", "m4a"], ["audio/m4a", "m4a"],
      ["audio/flac", "flac"], ["audio/x-wav", "wav"], ["audio/wave", "wav"], ["audio/aac", "aac"],
    ]) {
      const response = await transcribe(h, member.creds, "audio bytes", { "content-type": type });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "Transcribed words." });
      const form = upstream.mock.calls.at(-1)?.[1]?.body;
      if (!(form instanceof FormData)) throw new Error("missing form");
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("missing file");
      expect(file.name).toBe(`audio.${extension}`);
      expect(file.type).toBe(type);
    }
    expect(upstream).toHaveBeenCalledTimes(11);
  });

  it("blocks exhausted users before reading audio or calling the provider", async () => {
    const { h, admin } = await configured();
    await call(h, "PUT", "/api/baskule/admin/usage/limits", {
      creds: admin.creds, body: { enabled: true, rules: [{ window: "daily", tokens: 0 }] },
    });
    const pull = vi.fn();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await transcribe(h, admin.creds, new ReadableStream({ pull }, { highWaterMark: 0 }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "usage_limit_reached" });
    expect(pull).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("caps each user at one in-flight request and releases it after provider failure", async () => {
    const { h, admin } = await configured();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (response: Response) => void;
    const upstream = vi.fn<typeof fetch>().mockImplementationOnce(() => {
      entered();
      return new Promise<Response>(resolve => { release = resolve; });
    }).mockResolvedValue(Response.json({ text: "retry" }));
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = transcribe(h, admin.creds);
    await started;
    try {
      const pull = vi.fn();
      const response = await transcribe(h, admin.creds, new ReadableStream({ pull }, { highWaterMark: 0 }));
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "too_many_requests" });
      expect(pull).not.toHaveBeenCalled();
      expect(upstream).toHaveBeenCalledOnce();
    } finally { release(new Response("provider failed", { status: 500 })); }
    expect((await first).status).toBe(502);
    expect((await transcribe(h, admin.creds)).status).toBe(200);
  });

  it("caps all users at eight in-flight requests and releases successful requests", async () => {
    const { h, admin } = await configured();
    const users = [admin];
    for (let i = 0; i < 8; i++) {
      const email = `voice-${i}@os.test`;
      await createUser(h, admin.creds, email, `Voice ${i}`);
      users.push(await signIn(h, email, "user-password-1"));
    }
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    const upstream = vi.fn<typeof fetch>(async () => {
      if (++active === 8) entered();
      await gate;
      return Response.json({ text: "done" });
    });
    vi.stubGlobal("fetch", upstream);
    const pending = users.slice(0, 8).map(user => transcribe(h, user.creds));
    await started;
    try {
      const pull = vi.fn();
      const response = await transcribe(h, users[8].creds, new ReadableStream({ pull }, { highWaterMark: 0 }));
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "too_many_requests" });
      expect(pull).not.toHaveBeenCalled();
      expect(upstream).toHaveBeenCalledTimes(8);
    } finally { release(); }
    expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array(8).fill(200));
    expect((await transcribe(h, users[8].creds)).status).toBe(200);
    expect((await transcribe(h, admin.creds)).status).toBe(200);
  });

  it("holds the per-user slot while reading and maps a client abort to invalid_audio", async () => {
    const { h, admin } = await configured();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "retry" }));
    vi.stubGlobal("fetch", upstream);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { entered(); } }, { highWaterMark: 0 });
    const pending = transcribe(h, admin.creds, body);
    await started;
    try { expect((await transcribe(h, admin.creds)).status).toBe(429); }
    finally { controller.error(new DOMException("client disconnected", "AbortError")); }
    const aborted = await pending;
    expect(aborted.status).toBe(400);
    expect(await aborted.json()).toMatchObject({ error: "invalid_audio" });
    expect(upstream).not.toHaveBeenCalled();
    expect((await transcribe(h, admin.creds)).status).toBe(200);
  });

  it("releases the per-user slot when an upload stalls past the deadline", async () => {
    const { h, admin } = await configured();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "after" }));
    vi.stubGlobal("fetch", upstream);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { entered(); } }, { highWaterMark: 0 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const pending = transcribe(h, admin.creds, body);
      await started;
      await vi.advanceTimersByTimeAsync(120_000);
      const stalled = await pending;
      expect(stalled.status).toBe(400);
      expect(await stalled.json()).toMatchObject({ error: "invalid_audio" });
    } finally { vi.useRealTimers(); }
    expect(upstream).not.toHaveBeenCalled();
    expect((await transcribe(h, admin.creds)).status).toBe(200);
  });

  it.each([
    [400, 400, "invalid_audio", "The provider could not read the recording"],
    [413, 400, "invalid_audio", "The provider could not read the recording"],
    [415, 400, "invalid_audio", "The provider could not read the recording"],
    [429, 429, "too_many_requests", "too_many_requests"],
    [401, 502, "transcription_key_rejected", "The transcription provider rejected the API key"],
    [403, 502, "transcription_key_rejected", "The transcription provider rejected the API key"],
  ])("maps provider HTTP %s to HTTP %s and %s", async (status, expectedStatus, error, message) => {
    const { h, admin } = await configured();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(`private body ${key}`, { status })));
    const response = await transcribe(h, admin.creds);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ error, message });
  });

  it("returns 502 for upstream errors without leaking provider bodies or credentials", async () => {
    const { h, admin } = await configured();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`upstream body containing ${key}`, { status: 500 }))
      .mockRejectedValueOnce(new Error(`network error containing ${key}`))
      .mockRejectedValueOnce(new DOMException(key, "TimeoutError"))
      .mockResolvedValueOnce(Response.json({ other: key }))
      .mockResolvedValueOnce(Response.json({ text: 42 }))
      .mockResolvedValueOnce(new Response("not json"));
    vi.stubGlobal("fetch", upstream);
    for (let i = 0; i < 6; i++) {
      const response = await transcribe(h, admin.creds);
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({ error: "transcription_failed" });
      expect(JSON.stringify(body)).not.toContain(key);
      expect(JSON.stringify(body)).not.toContain("upstream body");
    }
    expect(warn).toHaveBeenCalledWith("Transcription upstream answered 500");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
  });
});
