import { expect, it, vi } from "vite-plus/test";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "@t3tools/contracts/baskule";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  read: vi.fn<() => Promise<ArrayBuffer>>(),
  size: 4,
  current: {
    status: "signed-in",
    serverUrl: "https://baskule.example.com",
    token: "session-one",
    me: { voiceInput: true, user: { id: "one" } },
  },
  listeners: new Set<() => void>(),
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-file-system", () => ({
  File: class {
    get size() {
      return mocks.size;
    }
    arrayBuffer = mocks.read;
  },
}));
vi.mock("../baskule/session", () => ({
  readBaskuleSession: () => mocks.current,
  subscribeBaskuleSession: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

import { getBaskuleVoiceTranscriber } from "./voiceTranscription";

function setup(token = "session-one") {
  mocks.fetch.mockReset().mockResolvedValue(Response.json({ text: " Hello phone. " }));
  mocks.read.mockReset().mockResolvedValue(new Uint8Array([0, 1, 254, 255]).buffer);
  mocks.size = 4;
  mocks.current = {
    status: "signed-in",
    serverUrl: "https://baskule.example.com",
    token,
    me: { voiceInput: true, user: { id: "one" } },
  };
  mocks.listeners.clear();
  return { signal: new AbortController().signal };
}

it.each(["session-one", ""])(
  "uploads original recording bytes with explicit native credential policy (%s)",
  async (token) => {
    const options = setup(token);
    const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
    await expect(prepared.transcribe("file:///recording.m4a", options)).resolves.toBe(
      "Hello phone.",
    );
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("https://baskule.example.com/api/baskule/transcriptions");
    expect(init?.body).toEqual(new Uint8Array([0, 1, 254, 255]).buffer);
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(new Headers(init?.headers).get("authorization")).toBe(token ? `Bearer ${token}` : null);
    expect(new Headers(init?.headers).get("content-type")).toBe("audio/mp4");
    expect(mocks.listeners.size).toBe(0);
  },
);

it("follows server capability instead of platform availability", () => {
  setup();
  mocks.current.me.voiceInput = false;
  expect(getBaskuleVoiceTranscriber()).toBeNull();
  mocks.current.me.voiceInput = true;
  mocks.current.status = "signed-out";
  expect(getBaskuleVoiceTranscriber()).toBeNull();
});

it("does not upload after cancellation during the file read", async () => {
  setup();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
  mocks.read.mockImplementation(async () => {
    controller.abort();
    return new ArrayBuffer(4);
  });
  await expect(prepared.transcribe("file:///recording.m4a", options)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
});

it("aborts an in-flight upload when the account changes", async () => {
  const options = setup();
  const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
  mocks.fetch.mockImplementation(async (_url, init) => {
    mocks.current = { ...mocks.current, token: "session-two" };
    for (const listener of mocks.listeners) listener();
    expect(init?.signal?.aborted).toBe(true);
    return Response.json({ text: "Late transcript" });
  });
  await expect(prepared.transcribe("file:///recording.m4a", options)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(mocks.listeners.size).toBe(0);
});

it("rejects oversized recordings before reading or sending", async () => {
  const options = setup();
  mocks.size = BASKULE_TRANSCRIPTION_MAX_BYTES + 1;
  const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
  await expect(prepared.transcribe("file:///recording.m4a", options)).rejects.toThrow(/too large/);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([429, 404, 502])("reports server rejection (%s)", async (status) => {
  const options = setup();
  mocks.fetch.mockResolvedValue(new Response("{}", { status }));
  const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
  await expect(prepared.transcribe("file:///recording.m4a", options)).rejects.toMatchObject({
    code: "transcription-failed",
  });
});

it("rejects malformed provider results", async () => {
  const options = setup();
  mocks.fetch.mockResolvedValue(Response.json({ text: 42 }));
  const prepared = await getBaskuleVoiceTranscriber()!.prepare(options);
  await expect(prepared.transcribe("file:///recording.m4a", options)).rejects.toMatchObject({
    code: "transcription-failed",
  });
});
