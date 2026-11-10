import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { Atom, AtomRegistry } from "effect/reactivity";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";

const audio = vi.hoisted(() => ({
  setMode: vi.fn(async (_mode: unknown) => {}),
  setActive: vi.fn(async (_active: boolean) => {}),
}));
vi.mock("expo-audio", () => ({
  AudioModule: {},
  setAudioModeAsync: audio.setMode,
  setIsAudioActiveAsync: audio.setActive,
}));

import {
  createVoiceInputTarget,
  VoiceInputSession,
  type VoiceInputSessionDependencies,
  type VoiceInputTarget,
  type VoiceRecordingSample,
} from "./voiceInputSession";

function createTarget(
  ownerKey: string,
  readText: () => string | null,
  commit: VoiceInputTarget["commitDraft"],
  selection: { start: number; end: number },
) {
  return createVoiceInputTarget(ownerKey, readText, commit, selection, () => () => {});
}

function createSession(
  overrides?: Partial<
    Pick<
      VoiceInputSessionDependencies,
      "configureRecording" | "releaseRecording" | "sampleRecording" | "requestPermission"
    >
  >,
) {
  const releaseKeepAwake = vi.fn();
  const keepAwake = vi.fn(() => releaseKeepAwake);
  const publishAudioLevels = vi.fn();
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken text",
  }));
  const session = new VoiceInputSession({
    initiallyActive: true,
    recorder,
    getTranscriber: () => ({ prepare }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: vi.fn(async () => {}),
    deleteRecording: vi.fn(),
    sampleRecording: () => null,
    publishAudioLevels,
    keepAwake,
    ...overrides,
  });
  return { session, recorder, prepare, keepAwake, releaseKeepAwake, publishAudioLevels };
}

describe("global voice input", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it.each([
    { state: "background", resumeFirst: true },
    { state: "background", resumeFirst: false },
    { state: "inactive", resumeFirst: true },
    { state: "inactive", resumeFirst: false },
  ] as const)(
    "starts after microphone permission and foreground return ($state, resume first: $resumeFirst)",
    async ({ state, resumeFirst }) => {
      const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
      const { session, recorder, prepare } = createSession({
        requestPermission: () => permission.promise,
      });
      const starting = session.start(
        createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }),
      );
      session.appStateChanged(state);
      if (resumeFirst) session.appStateChanged("active");
      permission.resolve({ granted: true, canAskAgain: true });
      await permission.promise;
      if (!resumeFirst) {
        expect(session.controller.currentState.phase).toBe("preparing");
        expect(prepare).not.toHaveBeenCalled();
        expect(recorder.record).not.toHaveBeenCalled();
        session.appStateChanged("active");
      }
      await starting;
      expect(session.controller.currentState.phase).toBe("recording");
      expect(recorder.record).toHaveBeenCalledOnce();
      await session.controller.stop();
    },
  );

  it.each([true, false])("reports denied permission with canAskAgain=%s", async (canAskAgain) => {
    const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
    const { session, recorder } = createSession({ requestPermission: () => permission.promise });
    const starting = session.start(createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }));
    session.appStateChanged("background");
    permission.resolve({ granted: false, canAskAgain });
    await starting;
    expect(session.controller.currentState).toEqual({
      phase: "error",
      error: "Microphone access is required for voice input.",
      errorAction: canAskAgain ? "retry" : "settings",
    });
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it.each(["permission", "foreground"] as const)(
    "can cancel and retry while waiting for %s without reviving the old recording",
    async (waitingFor) => {
      const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
      const requestPermission = vi
        .fn(async () => ({ granted: true, canAskAgain: true }))
        .mockImplementationOnce(() => permission.promise);
      const { session, recorder } = createSession({ requestPermission });
      const firstCommit = vi.fn();
      const nextCommit = vi.fn();
      const starting = session.start(
        createTarget("first", () => "", firstCommit, { start: 0, end: 0 }),
      );
      session.appStateChanged("background");
      if (waitingFor === "foreground") {
        permission.resolve({ granted: true, canAskAgain: true });
        await permission.promise;
      }
      session.cancel("first");
      session.appStateChanged("active");
      const retrying = session.start(
        createTarget("next", () => "", nextCommit, { start: 0, end: 0 }),
      );
      permission.resolve({ granted: true, canAskAgain: true });
      await starting;
      await retrying;
      expect(recorder.record).toHaveBeenCalledOnce();
      await session.controller.stop();
      expect(firstCommit).not.toHaveBeenCalled();
      expect(nextCommit).toHaveBeenCalledWith("spoken text", { start: 11, end: 11 });
    },
  );

  it("never captures if the app stays backgrounded or loses foreground again before resuming", async () => {
    const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
    const { session, recorder, prepare } = createSession({
      requestPermission: () => permission.promise,
    });
    const starting = session.start(createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }));
    session.appStateChanged("background");
    permission.resolve({ granted: true, canAskAgain: true });
    await permission.promise;
    session.appStateChanged("active");
    await session.appStateChanged("background");
    expect(prepare).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
    session.dispose();
    await starting;
    session.appStateChanged("active");
    expect(session.controller.currentState.phase).toBe("idle");
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it.each(["transcriber", "audio session", "recorder"] as const)(
    "cancels actual backgrounding during %s preparation",
    async (stage) => {
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const pause = () => {
        entered.resolve();
        return pending.promise;
      };
      const releaseRecording = vi.fn(async () => {});
      const { session, recorder, prepare } = createSession({
        ...(stage === "audio session" ? { configureRecording: pause } : {}),
        releaseRecording,
      });
      if (stage === "transcriber") {
        prepare.mockImplementationOnce(async () => {
          await pause();
          return { locale: "en-US", transcribe: async () => "spoken text" };
        });
      }
      if (stage === "recorder") recorder.prepareToRecordAsync.mockImplementationOnce(pause);
      const starting = session.start(
        createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }),
      );
      await entered.promise;
      session.appStateChanged("background");
      pending.resolve();
      await starting;
      session.appStateChanged("active");
      expect(session.controller.currentState.error).toContain("moved to the background");
      expect(recorder.record).not.toHaveBeenCalled();
      expect(releaseRecording).toHaveBeenCalledTimes(stage === "transcriber" ? 0 : 1);
    },
  );

  it("discards capture on actual backgrounding after permission has completed", async () => {
    const { session, recorder, releaseKeepAwake } = createSession();
    const commit = vi.fn();
    await session.start(createTarget("first", () => "", commit, { start: 0, end: 0 }));
    await session.appStateChanged("background");
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(releaseKeepAwake).toHaveBeenCalledOnce();
    expect(session.controller.currentState.phase).toBe("error");
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["retry", "takeover"])(
    "handles failed deactivation with %s without notifying a released owner",
    async (action) => {
      const pause = vi.fn();
      const playback = acquireAudioSession("recording", pause);
      await activateAudioSession(playback);
      audio.setActive.mockRejectedValueOnce(new Error("Deactivation failed"));
      await expect(releaseAudioSession(playback)).rejects.toThrow("Deactivation failed");
      if (action === "retry") {
        await releaseAudioSession(playback);
        expect(audio.setActive).toHaveBeenLastCalledWith(false);
      }
      const recording = acquireAudioSession("recording");
      expect(pause).not.toHaveBeenCalled();
      await releaseAudioSession(recording);
      vi.clearAllMocks();
    },
  );

  it.each(["complete", "activation failure"])(
    "protects recording from inline playback and releases its session after %s",
    async (outcome) => {
      const pause = vi.fn();
      const playback = acquireAudioSession("playback", pause);
      await activateAudioSession(playback);
      let recording!: ReturnType<typeof acquireAudioSession>;
      const { session, recorder } = createSession({
        configureRecording: async () => {
          recording = acquireAudioSession("recording");
          try {
            await activateAudioSession(recording);
          } catch (error) {
            await releaseAudioSession(recording);
            throw error;
          }
        },
        releaseRecording: () => releaseAudioSession(recording),
      });
      if (outcome === "activation failure") {
        audio.setActive.mockRejectedValueOnce(new Error("Audio activation failed"));
      }
      await session.start(createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }));
      expect(pause).toHaveBeenCalledOnce();
      expect(isAudioSessionOwner(playback)).toBe(false);
      if (outcome === "complete") {
        expect(recorder.record).toHaveBeenCalledOnce();
        expect(session.controller.currentState.phase).toBe("recording");
        audio.setMode.mockClear();
        audio.setActive.mockClear();
        await releaseAudioSession(playback);
        const blockedPlayback = acquireAudioSession("playback");
        expect(await activateAudioSession(blockedPlayback)).toBe(false);
        await releaseAudioSession(blockedPlayback);
        expect(audio.setMode).not.toHaveBeenCalled();
        expect(audio.setActive).not.toHaveBeenCalled();
        expect(isAudioSessionOwner(recording)).toBe(true);
        await session.controller.stop();
      } else {
        expect(recorder.record).not.toHaveBeenCalled();
        expect(session.controller.currentState.phase).toBe("error");
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(false);
      expect(isAudioSessionOwner(recording)).toBe(false);
      const replay = acquireAudioSession("playback");
      expect(await activateAudioSession(replay)).toBe(true);
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      await releaseAudioSession(replay);
      vi.clearAllMocks();
    },
  );

  it.each([
    { selection: { start: 6, end: 11 }, expected: "hello spoken text", cursor: 17 },
    { selection: { start: 6, end: 6 }, expected: "hello spoken text world", cursor: 18 },
  ])(
    "keeps the starting selection $selection after navigation",
    async ({ selection, expected, cursor }) => {
      const { session } = createSession();
      const commit = vi.fn();
      await session.start(createTarget("first", () => "hello world", commit, selection));
      await session.start(
        createTarget("second", () => "other prompt", vi.fn(), { start: 12, end: 12 }),
      );
      await session.controller.stop();
      expect(commit).toHaveBeenCalledWith(expected, {
        start: cursor,
        end: cursor,
      });
    },
  );

  it("appends to the starting draft after its screen leaves and another draft opens", async () => {
    const { session, recorder } = createSession();
    const drafts = new Map([
      ["first", "original prompt"],
      ["second", "other prompt"],
    ]);
    let visibleDraft = "first";
    const targetKey = visibleDraft;
    await session.start(
      createTarget(
        targetKey,
        () => drafts.get(targetKey) ?? null,
        (text) => drafts.set(targetKey, text),
        { start: 15, end: 15 },
      ),
    );
    visibleDraft = "second";
    expect(session.controller.currentState.phase).toBe("recording");
    expect(recorder.stop).not.toHaveBeenCalled();
    await session.controller.stop();

    expect(drafts.get("first")).toBe("original prompt spoken text");
    expect(drafts.get(visibleDraft)).toBe("other prompt");
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it.each(["preparing", "recording", "transcribing"] as const)(
    "keeps one recorder and its original target during %s",
    async (phase) => {
      const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
      const preparationEntered = Promise.withResolvers<void>();
      const transcription = Promise.withResolvers<string>();
      const transcriptionEntered = Promise.withResolvers<void>();
      const { session, recorder, prepare } = createSession();
      prepare.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
      const firstCommit = vi.fn();
      const secondCommit = vi.fn();
      const starting = session.start(
        createTarget("first", () => "first", firstCommit, { start: 5, end: 5 }),
      );
      await preparationEntered.promise;
      let stopping: Promise<void> | null = null;
      if (phase !== "preparing") {
        preparation.resolve({
          locale: "en-US",
          transcribe: () => {
            transcriptionEntered.resolve();
            return transcription.promise;
          },
        });
        await starting;
      }
      if (phase === "transcribing") {
        stopping = session.controller.stop();
        await transcriptionEntered.promise;
      }
      await session.start(
        createTarget("second", () => "second", secondCommit, { start: 6, end: 6 }),
      );
      expect(session.ownerKey).toBe("first");
      expect(session.controller.currentState.phase).toBe(phase);
      expect(prepare).toHaveBeenCalledTimes(1);
      preparation.resolve({ locale: "en-US", transcribe: async () => "spoken text" });
      await starting;
      transcription.resolve("spoken text");
      await (stopping ?? session.controller.stop());
      expect(recorder.record).toHaveBeenCalledTimes(1);
      expect(firstCommit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
      expect(secondCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["changed", "removed"] as const)(
    "does not overwrite a %s starting draft",
    async (change) => {
      const { session } = createSession();
      let text: string | null = "first";
      const commit = vi.fn();
      await session.start(createTarget("first", () => text, commit, { start: 5, end: 5 }));
      text = change === "removed" ? null : "edited prompt";
      await session.controller.stop();
      expect(commit).not.toHaveBeenCalled();
      expect(session.controller.currentState.error).toContain("draft changed");
    },
  );

  it("finishes the original draft at the recording limit while it is off screen", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(createTarget("first", () => "first", commit, { start: 5, end: 5 }));
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: recorder.uri,
    });
    expect(commit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it("rejects a transcript when its off-screen draft changes and returns to the original text", async () => {
    const registry = AtomRegistry.make();
    const draft = Atom.make("hello world");
    const unsubscribe = vi.fn();
    const { session } = createSession();
    const commit = vi.fn();
    const target = createVoiceInputTarget(
      "first",
      () => registry.get(draft),
      commit,
      { start: 6, end: 6 },
      (onChange) => {
        const stop = registry.subscribe(draft, onChange);
        return () => {
          stop();
          unsubscribe();
        };
      },
    );
    await session.start(target);
    registry.set(draft, "changed");
    registry.set(draft, "hello world");
    await session.controller.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(session.controller.currentState.error).toContain("draft changed");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("stops recording when its queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    let draft: string | null = "queued prompt";
    const ownerKey = "thread~queued-edit~run";
    await session.start(createTarget(ownerKey, () => draft, commit, { start: 13, end: 13 }));
    session.cancel(ownerKey);
    draft = null;
    await session.controller.stop();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(session.controller.currentState).toEqual({
      phase: "idle",
      error: null,
      errorAction: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps another prompt's recording when a queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(createTarget("other prompt", () => "hello", commit, { start: 5, end: 5 }));
    session.cancel("thread~queued-edit~run");
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("recording");
    await session.controller.stop();
    expect(commit).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
  });

  it("waits for canceled native work before starting a recording for another draft", async () => {
    const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
    const preparationEntered = Promise.withResolvers<void>();
    const { session, recorder, prepare } = createSession();
    prepare.mockImplementationOnce(() => {
      preparationEntered.resolve();
      return preparation.promise;
    });
    const oldCommit = vi.fn();
    const nextCommit = vi.fn();
    const firstStart = session.start(
      createTarget("first", () => "first", oldCommit, { start: 5, end: 5 }),
    );
    await preparationEntered.promise;
    session.cancel("first");
    const nextStart = session.start(
      createTarget("second", () => "second", nextCommit, { start: 6, end: 6 }),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recorder.record).not.toHaveBeenCalled();
    preparation.resolve({ locale: "en-US", transcribe: async () => "old transcript" });
    await firstStart;
    await nextStart;
    await session.controller.stop();
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(oldCommit).not.toHaveBeenCalled();
    expect(nextCommit).toHaveBeenCalledWith("second spoken text", { start: 18, end: 18 });
  });

  it("holds the screen awake and meters only while recording", async () => {
    vi.useFakeTimers();
    try {
      let sample: VoiceRecordingSample = { durationMillis: 0, metering: -100 };
      const { session, keepAwake, releaseKeepAwake, publishAudioLevels } = createSession({
        sampleRecording: () => sample,
      });
      const snapshots: number[] = [];
      session.subscribe(() => snapshots.push(session.getSnapshot().elapsedSeconds));

      await session.start(createTarget("first", () => "first", vi.fn(), { start: 5, end: 5 }));
      expect(session.getSnapshot().state.phase).toBe("recording");
      expect(keepAwake).toHaveBeenCalledTimes(1);
      // Silence on a silent history publishes nothing.
      expect(publishAudioLevels).not.toHaveBeenCalled();

      sample = { durationMillis: 2_400, metering: 0 };
      vi.advanceTimersByTime(80);
      expect(session.getSnapshot().elapsedSeconds).toBe(2);
      expect(publishAudioLevels).toHaveBeenLastCalledWith(expect.arrayContaining([1]));

      await session.controller.stop();
      expect(releaseKeepAwake).toHaveBeenCalledTimes(1);
      const publishedLevels = publishAudioLevels.mock.calls.length;
      const publishedSnapshots = snapshots.length;
      vi.advanceTimersByTime(800);
      expect(publishAudioLevels).toHaveBeenCalledTimes(publishedLevels);
      expect(snapshots).toHaveLength(publishedSnapshots);
      // The finished recording's time stays readable until the next one starts.
      expect(session.getSnapshot().elapsedSeconds).toBe(2);

      sample = { durationMillis: 0, metering: -100 };
      await session.start(createTarget("first", () => "first", vi.fn(), { start: 5, end: 5 }));
      expect(session.getSnapshot().elapsedSeconds).toBe(0);
      expect(publishAudioLevels).toHaveBeenLastCalledWith(expect.not.arrayContaining([1]));
      expect(keepAwake).toHaveBeenCalledTimes(2);
      session.dispose();
      expect(releaseKeepAwake).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes which owners are focused", () => {
    const { session } = createSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.setOwnerFocused("first", true);
    session.setOwnerFocused("first", true);
    expect(session.getSnapshot().focusedOwners).toEqual(new Set(["first"]));
    expect(listener).toHaveBeenCalledTimes(1);
    session.setOwnerFocused("first", false);
    expect(session.getSnapshot().focusedOwners.size).toBe(0);
  });
});
