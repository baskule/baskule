import { t } from "../i18n";
// baskule: voice input in the composer. The front's `/api/baskule/transcriptions` turns a
// recording into text, which the composer appends to the prompt or appends and sends.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "@t3tools/contracts/baskule";

import { toastManager } from "../components/ui/toast";

import { baskuleApi } from "./api";
import { BASKULE_UI } from "./flags";
import { useBaskuleMe } from "./session";
import { errorText } from "./ui";

/** Opus at this rate keeps the longest recording near 5 MB, well under the upload limit. */
const AUDIO_BITS_PER_SECOND = 64_000;
export const MAX_RECORDING_MINUTES = 10;
const MAX_RECORDING_MS = MAX_RECORDING_MINUTES * 60_000;
const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"];

export type VoiceInputAfter = "insert" | "send";

export type VoiceInputState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting" }
  | { readonly phase: "recording"; readonly startedAt: number }
  | {
      readonly phase: "transcribing";
      readonly after: VoiceInputAfter;
      /** How the composer sends once the text is in, for `after: "send"`. */
      readonly mode: ComposerDispatchMode | undefined;
    }
  | { readonly phase: "error"; readonly message: string };

export type VoiceInputEvent =
  | { readonly type: "start" }
  | { readonly type: "recording"; readonly at: number }
  | {
      readonly type: "stop";
      readonly after: VoiceInputAfter;
      readonly mode?: ComposerDispatchMode | undefined;
    }
  | { readonly type: "transcribed" }
  | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly message: string };

const IDLE: VoiceInputState = { phase: "idle" };

export function voiceInputReducer(state: VoiceInputState, event: VoiceInputEvent): VoiceInputState {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "error" ? { phase: "requesting" } : state;
    case "recording":
      return state.phase === "requesting" ? { phase: "recording", startedAt: event.at } : state;
    case "stop":
      if (state.phase === "recording") {
        return { phase: "transcribing", after: event.after, mode: event.mode };
      }
      // Send while the text is on its way: it is sent once it arrives. Further sends change nothing.
      if (state.phase === "transcribing" && state.after === "insert" && event.after === "send") {
        return { phase: "transcribing", after: "send", mode: event.mode };
      }
      return state;
    case "transcribed":
      return state.phase === "transcribing" ? IDLE : state;
    case "cancel":
      return IDLE;
    case "fail":
      return state.phase === "idle" ? state : { phase: "error", message: event.message };
  }
}

/** `m:ss` */
export function formatRecordingTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function pickRecordingMimeType(isSupported: (type: string) => boolean): string | undefined {
  return RECORDING_MIME_TYPES.find((type) => isSupported(type));
}

/** Volume, independent of pitch; amplify quiet speech without animating the noise floor. */
export function recordingLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.005) * 8));
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t(
      "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("No microphone was found. Connect one, then try again.");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return t("The microphone is in use by another app or could not start.");
  }
  return t("The microphone could not start.");
}

interface Recording {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly audio: AudioContext | null;
  readonly analyser: AnalyserNode | null;
  readonly limit: number;
  discarded: boolean;
}

function release(recording: Recording) {
  window.clearTimeout(recording.limit);
  for (const track of recording.stream.getTracks()) track.stop();
  void recording.audio?.close().catch(() => undefined);
}

/** A live level meter is optional: without Web Audio the recording still works. */
function analyserFor(stream: MediaStream) {
  try {
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    return { audio, analyser };
  } catch {
    return { audio: null, analyser: null };
  }
}

export interface BaskuleVoiceInput {
  /** Baskule UI, the organization has voice input on with a key saved, and the composer takes text. */
  readonly available: boolean;
  readonly state: VoiceInputState;
  /** Asking for the microphone, recording or transcribing. */
  readonly active: boolean;
  /** A recording or a transcript on its way counts as message content: send stays usable. */
  readonly holdsInput: boolean;
  /** The transcript will be sent when it arrives. */
  readonly sending: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
  /** Takes over a composer send while recording or transcribing; false when idle. */
  readonly takeSubmit: (mode: ComposerDispatchMode | undefined) => boolean;
  readonly analyser: () => AnalyserNode | null;
}

/**
 * A recording belongs to one composer: target changes, unmount or disabled input discard it.
 * `insert` appends the transcript and reports acceptance. Escape cancels inside `root` or
 * without focus, after other handlers decline; the editor handles its own Escape.
 */
export function useBaskuleVoiceInput(options: {
  readonly targetKey: string;
  readonly enabled: boolean;
  readonly root: RefObject<HTMLElement | null>;
  readonly insert: (text: string) => boolean;
  readonly submit: (mode: ComposerDispatchMode | undefined) => void;
}): BaskuleVoiceInput {
  const me = useBaskuleMe();
  const [state, setState] = useState<VoiceInputState>(IDLE);
  // Read synchronously: a send dispatched from the transcript callback must see `idle`.
  const stateRef = useRef<VoiceInputState>(IDLE);
  const recordingRef = useRef<Recording | null>(null);
  const generationRef = useRef(0);
  /** The composer target the current recording started in. */
  const ownerRef = useRef<string | null>(null);
  const optionsRef = useRef(options);

  const [controls] = useState(() => {
    const transition = (event: VoiceInputEvent) => {
      const previous = stateRef.current;
      const next = voiceInputReducer(previous, event);
      stateRef.current = next;
      setState(next);
      return next !== previous;
    };
    const fail = (generation: number, message: string) => {
      if (generation !== generationRef.current) return;
      if (transition({ type: "fail", message }))
        toastManager.add({ type: "error", title: message });
    };
    const discard = () => {
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (!recording) return;
      recording.discarded = true;
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      release(recording);
    };

    const transcribe = async (generation: number, recording: Blob) => {
      if (recording.size === 0) {
        fail(generation, t("Nothing was recorded. Check your microphone, then try again."));
        return;
      }
      if (recording.size > BASKULE_TRANSCRIPTION_MAX_BYTES) {
        fail(generation, t("The recording is too long to transcribe."));
        return;
      }
      let text: string;
      try {
        text = (await baskuleApi.transcribe(recording)).trim();
      } catch (error) {
        fail(generation, errorText(error, t("The recording could not be transcribed. Try again.")));
        return;
      }
      const current = stateRef.current;
      if (generation !== generationRef.current || current.phase !== "transcribing") return;
      transition({ type: "transcribed" });
      if (!text) {
        toastManager.add({ type: "info", title: t("No speech was recognized.") });
        return;
      }
      if (!optionsRef.current.insert(text)) {
        toastManager.add({
          type: "error",
          title: t("The transcript could not be added to the message. Copy it from here."),
          description: text,
        });
        return;
      }
      if (current.after === "send") optionsRef.current.submit(current.mode);
    };

    const startRecording = async (generation: number) => {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        fail(
          generation,
          window.isSecureContext
            ? t("This browser can't record audio.")
            : t("Voice input needs a secure (HTTPS) connection or the desktop app."),
        );
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        fail(generation, microphoneErrorMessage(error));
        return;
      }
      if (generation !== generationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mimeType = pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          ...(mimeType ? { mimeType } : {}),
        });
      } catch {
        for (const track of stream.getTracks()) track.stop();
        fail(generation, t("This browser can't record audio."));
        return;
      }
      const chunks: Blob[] = [];
      const recording: Recording = {
        stream,
        recorder,
        ...analyserFor(stream),
        limit: window.setTimeout(() => {
          toastManager.add({
            type: "info",
            title: t("Recording stopped after {{minutes}} minutes.", {
              minutes: MAX_RECORDING_MINUTES,
            }),
          });
          finish("insert", undefined);
        }, MAX_RECORDING_MS),
        discarded: false,
      };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        if (recording.discarded) return;
        discard();
        fail(generation, t("Recording failed. Try again."));
      });
      // Also fires when the microphone goes away: whatever was recorded is still transcribed.
      recorder.addEventListener("stop", () => {
        release(recording);
        if (recordingRef.current === recording) recordingRef.current = null;
        if (recording.discarded) return;
        if (stateRef.current.phase === "recording") transition({ type: "stop", after: "insert" });
        const type = recorder.mimeType || mimeType || "audio/webm";
        void transcribe(generation, new Blob(chunks, { type }));
      });
      recordingRef.current = recording;
      try {
        recorder.start();
      } catch {
        discard();
        fail(generation, t("Recording failed. Try again."));
        return;
      }
      transition({ type: "recording", at: Date.now() });
    };

    const finish = (after: VoiceInputAfter, mode: ComposerDispatchMode | undefined) => {
      if (!transition({ type: "stop", after, mode })) return;
      const recording = recordingRef.current;
      if (recording && recording.recorder.state !== "inactive") recording.recorder.stop();
    };

    return {
      start: () => {
        if (!transition({ type: "start" })) return;
        ownerRef.current = optionsRef.current.targetKey;
        void startRecording(++generationRef.current);
      },
      stop: () => finish("insert", undefined),
      cancel: () => {
        if (stateRef.current.phase === "idle") return;
        generationRef.current += 1;
        discard();
        transition({ type: "cancel" });
      },
      takeSubmit: (mode: ComposerDispatchMode | undefined) => {
        const phase = stateRef.current.phase;
        if (phase !== "recording" && phase !== "transcribing") return false;
        finish("send", mode);
        return true;
      },
      analyser: () => recordingRef.current?.analyser ?? null,
    };
  });

  // The new target's callbacks and the discard land in one commit: a transcript resolving before
  // passive effects run would otherwise be inserted into, and maybe sent to, the next chat.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the recorder owner and callbacks before a transcript can reach the next chat.
  useLayoutEffect(() => {
    optionsRef.current = options;
    if (!options.enabled || ownerRef.current !== options.targetKey) controls.cancel();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the microphone recorder when its owner unmounts.
  useLayoutEffect(() => controls.cancel, [controls]);

  const active =
    state.phase === "requesting" || state.phase === "recording" || state.phase === "transcribing";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register Escape handling only while the microphone session is active.
  useEffect(() => {
    if (!active) return;
    // On window, bubbling, added after the app's own Escape handlers: a search, menu or dialog
    // that closes on Escape claims it first, and losing the recording is the costlier mistake.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      const inComposer =
        target instanceof Node && optionsRef.current.root.current?.contains(target);
      if (!inComposer && target !== document.body) return;
      event.preventDefault();
      controls.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, controls]);

  return {
    available: BASKULE_UI && me?.voiceInput === true && options.enabled,
    state,
    active,
    holdsInput:
      state.phase === "recording" || (state.phase === "transcribing" && state.after === "insert"),
    sending: state.phase === "transcribing" && state.after === "send",
    ...controls,
  };
}
