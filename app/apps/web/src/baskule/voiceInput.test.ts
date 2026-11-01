// baskule: the composer's voice input state machine.
import { describe, expect, it } from "vite-plus/test";

import {
  formatRecordingTime,
  pickRecordingMimeType,
  recordingLevel,
  voiceInputReducer,
  type VoiceInputEvent,
  type VoiceInputState,
} from "./voiceInput";

const run = (events: ReadonlyArray<VoiceInputEvent>, from: VoiceInputState = { phase: "idle" }) =>
  events.reduce(voiceInputReducer, from);

describe("voice input state machine", () => {
  it("records, then transcribes for the prompt and returns to idle", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "requesting" });
    expect(run([{ type: "start" }, { type: "recording", at: 5 }])).toEqual({
      phase: "recording",
      startedAt: 5,
    });
    const stopped = run([
      { type: "start" },
      { type: "recording", at: 5 },
      { type: "stop", after: "insert" },
    ]);
    expect(stopped).toEqual({ phase: "transcribing", after: "insert", mode: undefined });
    expect(voiceInputReducer(stopped, { type: "transcribed" })).toEqual({ phase: "idle" });
  });

  it("sends once: a send while transcribing upgrades an insert, later sends change nothing", () => {
    const inserting = run([
      { type: "start" },
      { type: "recording", at: 0 },
      { type: "stop", after: "insert" },
    ]);
    const sending = voiceInputReducer(inserting, { type: "stop", after: "send", mode: "queue" });
    expect(sending).toEqual({ phase: "transcribing", after: "send", mode: "queue" });
    expect(voiceInputReducer(sending, { type: "stop", after: "send", mode: "steer" })).toBe(
      sending,
    );
    expect(voiceInputReducer(sending, { type: "stop", after: "insert" })).toBe(sending);
  });

  it("ignores controls that do not apply to the current phase", () => {
    const recording = run([{ type: "start" }, { type: "recording", at: 0 }]);
    expect(voiceInputReducer(recording, { type: "start" })).toBe(recording);
    expect(voiceInputReducer(recording, { type: "transcribed" })).toBe(recording);
    expect(run([{ type: "stop", after: "send" }])).toEqual({ phase: "idle" });
    expect(run([{ type: "recording", at: 0 }])).toEqual({ phase: "idle" });
    expect(run([{ type: "fail", message: "late" }])).toEqual({ phase: "idle" });
  });

  it("cancels from every phase without transcribing", () => {
    for (const events of [
      [{ type: "start" }],
      [{ type: "start" }, { type: "recording", at: 0 }],
      [{ type: "start" }, { type: "recording", at: 0 }, { type: "stop", after: "send" }],
      [{ type: "start" }, { type: "fail", message: "No microphone" }],
    ] satisfies VoiceInputEvent[][]) {
      expect(run([...events, { type: "cancel" }])).toEqual({ phase: "idle" });
    }
  });

  it("keeps a failure's message until the next start", () => {
    const failed = run([{ type: "start" }, { type: "fail", message: "Microphone blocked" }]);
    expect(failed).toEqual({ phase: "error", message: "Microphone blocked" });
    expect(voiceInputReducer(failed, { type: "start" })).toEqual({ phase: "requesting" });
  });
});

describe("voice input helpers", () => {
  it("keeps silence still and makes quiet and loud speech visibly different", () => {
    expect(recordingLevel(new Float32Array())).toBe(0);
    expect(recordingLevel(new Float32Array(1024))).toBe(0);
    expect(recordingLevel(new Float32Array(1024).fill(0.003))).toBe(0);
    const quiet = recordingLevel(new Float32Array(1024).fill(0.02));
    const loud = recordingLevel(new Float32Array(1024).fill(0.1));
    expect(quiet).toBeGreaterThan(0.3);
    expect(loud).toBeGreaterThan(quiet * 2);
    expect(recordingLevel(new Float32Array(1024).fill(1))).toBe(1);
  });

  it("responds to low and high voices equally at the same volume", () => {
    const tone = (cycles: number) =>
      Float32Array.from(
        { length: 1024 },
        (_, index) => 0.05 * Math.sin((2 * Math.PI * cycles * index) / 1024),
      );
    expect(recordingLevel(tone(4))).toBeCloseTo(recordingLevel(tone(32)), 5);
  });

  it("prefers Opus in WebM, then MP4, else the browser default", () => {
    expect(pickRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecordingMimeType(() => false)).toBeUndefined();
  });

  it("shows the elapsed time as minutes and seconds", () => {
    expect(formatRecordingTime(0)).toBe("0:00");
    expect(formatRecordingTime(9_999)).toBe("0:09");
    expect(formatRecordingTime(600_000)).toBe("10:00");
    expect(formatRecordingTime(-5)).toBe("0:00");
  });
});
