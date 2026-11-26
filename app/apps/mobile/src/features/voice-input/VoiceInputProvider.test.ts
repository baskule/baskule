import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const recorderConstructor = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("react-native-reanimated", () => ({ makeMutable: () => ({ set() {} }) }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: async () => {},
}));
vi.mock("expo-audio", () => ({
  AudioModule: {
    AudioRecorder: function AudioRecorder() {
      return recorderConstructor();
    },
  },
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("../../baskule/transcription", () => ({
  getBaskuleVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "en", transcribe: async () => "" }),
  }),
}));
vi.mock("../../baskule/session", () => ({
  readBaskuleSession: () => ({ status: "signed-out" }),
  subscribeBaskuleSession: () => () => {},
}));
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { Effect } = await import("effect");
  return {
    mobilePreferencesAtom: Atom.make(AsyncResult.initial()),
    saveMobilePreferences: { label: "save preferences", run: () => Effect.void },
  };
});
vi.mock("./voiceDestination", async () => {
  const { Atom } = await import("effect/reactivity");
  return { voiceRouteAtom: Atom.make(null) };
});

import { setAudioModeAsync } from "expo-audio";
import type { MicrophoneEntry } from "../../lib/microphonePriority";
import { mobilePreferencesAtom } from "../../state/preferences";
import { voiceInputAtom } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

it("uses the loaded microphone order when recording starts before preferences hydrate", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  // Startup either subscribes to pending preferences or activates audio before they load.
  const startup = Promise.withResolvers<void>();
  vi.mocked(setAudioModeAsync).mockImplementation(async () => startup.resolve());
  const setInput = vi.fn();
  recorderConstructor.mockReturnValue({
    uri: "file:///voice.m4a",
    prepareToRecordAsync: async () => {},
    record() {},
    stop: async () => {},
    getStatus: () => ({
      canRecord: true,
      isRecording: false,
      durationMillis: 0,
      fileSize: 0,
      mediaServicesDidReset: false,
      url: null,
    }),
    addListener: () => ({ remove() {} }),
    getAvailableInputs: () => [{ uid: "iphone", name: "iPhone", type: "MicrophoneBuiltIn" }],
    setInput,
    release() {},
  });
  const { session } = registry.get(voiceInputAtom);
  const subscribe = registry.subscribe.bind(registry);
  using _subscribe = vi
    .spyOn(registry, "subscribe")
    .mockImplementation((atom, listener, options) => {
      if (atom === preferences) startup.resolve();
      return subscribe(atom, listener, options);
    });
  try {
    const start = session.start(
      createVoiceInputTarget("draft", () => "", vi.fn(), { start: 0, end: 0 }),
    );
    await startup.promise;
    registry.set(
      preferences,
      AsyncResult.success({
        microphones: [
          { kind: "builtIn" },
          { kind: "wired" },
          { kind: "bluetooth" },
          { kind: "carPlay" },
        ],
      }),
    );
    await start;
    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: true, allowBluetoothRecording: false }),
    );
    expect(session.getSnapshot().state.error).toBeNull();
    expect(session.getSnapshot().state).toMatchObject({ phase: "recording" });
    expect(recorderConstructor).toHaveBeenCalledOnce();
    expect(setInput).toHaveBeenCalledWith("iphone");
  } finally {
    await session.controller.cancel();
    registry.dispose();
  }
});
