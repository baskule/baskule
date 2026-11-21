import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "@t3tools/contracts/baskule";
import { m as resolveMessage } from "../i18n/messages";
import { msg } from "gt-react";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
} from "@t3tools/client-runtime/voice-input";

import { BaskuleApiError, baskuleApi } from "./api";

/** Upstream browser capture produces mono float PCM at 16 kHz; hosted transcription accepts a recording. */
export function pcmRecording(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string) =>
    new Uint8Array(buffer, offset, 4).set(new TextEncoder().encode(value));
  tag(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function transcribeBaskulePcm(
  uri: string,
  signal: AbortSignal,
  authorized: () => boolean,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!authorized())
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: resolveMessage(msg("Sign in to use voice input.")),
    });
  const response = await fetch(uri, { signal });
  const samples = new Float32Array(await response.arrayBuffer());
  if (44 + samples.length * Int16Array.BYTES_PER_ELEMENT > BASKULE_TRANSCRIPTION_MAX_BYTES)
    throw new VoiceTranscriptionError({
      code: "transcription-failed",
      message: resolveMessage(msg("The recording is too large. Try a shorter recording.")),
    });
  const recording = pcmRecording(samples);
  throwIfVoiceTranscriptionAborted(signal);
  if (!authorized())
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: resolveMessage(msg("Your voice input session changed.")),
    });
  let text: string;
  try {
    text = await baskuleApi.transcribe(recording, signal);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof BaskuleApiError) {
      throw new VoiceTranscriptionError({
        code: "transcription-failed",
        message: error.message,
      });
    }
    throw error;
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (!authorized())
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: resolveMessage(msg("Your voice input session changed.")),
    });
  return text;
}
