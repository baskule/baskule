import { afterEach, expect, it, vi } from "vite-plus/test";
import { pcmRecording, transcribeBaskulePcm } from "./transcription";

const transcribe = vi.hoisted(() =>
  vi.fn<(recording: Blob, signal?: AbortSignal) => Promise<string>>(),
);
vi.mock("./api", () => ({ baskuleApi: { transcribe } }));
afterEach(() => {
  vi.unstubAllGlobals();
  transcribe.mockReset();
});

it("encodes upstream float PCM as mono 16 kHz WAV for the hosted endpoint", async () => {
  const recording = pcmRecording(new Float32Array([-2, -1, 0, 1, 2]));
  const bytes = await recording.arrayBuffer();
  const view = new DataView(bytes);
  expect(recording.type).toBe("audio/wav");
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(10);
  expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
    -32768, -32768, 0, 32767, 32767,
  ]);
});

it("passes cancellation through and discards a transcript arriving after cancel", async () => {
  const abort = new AbortController();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Float32Array([0]).buffer)));
  transcribe.mockImplementation(async (_recording, signal) => {
    expect(signal).toBe(abort.signal);
    abort.abort();
    return "late transcript";
  });
  await expect(
    transcribeBaskulePcm("blob:recording", abort.signal, () => true),
  ).rejects.toMatchObject({ code: "cancelled" });
});

it("does not upload when the account or voice authorization changes during capture read", async () => {
  let authorized = true;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      authorized = false;
      return new Response(new Float32Array([0]).buffer);
    }),
  );
  await expect(
    transcribeBaskulePcm("blob:recording", new AbortController().signal, () => authorized),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(transcribe).not.toHaveBeenCalled();
});

it("discards a transcript returned after sign-out", async () => {
  let authorized = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Float32Array([0]).buffer)));
  transcribe.mockImplementation(async () => {
    authorized = false;
    return "late transcript";
  });
  await expect(
    transcribeBaskulePcm("blob:recording", new AbortController().signal, () => authorized),
  ).rejects.toMatchObject({ code: "unavailable" });
});
