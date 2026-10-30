import { t } from "../i18n";
import { Schema } from "effect";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "@t3tools/contracts/baskule";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { readBaskuleSession, subscribeBaskuleSession } from "../baskule/session";

const parseTranscript = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }));

export function getBaskuleVoiceTranscriber(): VoiceTranscriber | null {
  const captured = readBaskuleSession();
  if (captured.status !== "signed-in" || !captured.me?.voiceInput) return null;
  const isCurrent = () => {
    const current = readBaskuleSession();
    return (
      current.status === "signed-in" &&
      current.serverUrl === captured.serverUrl &&
      current.token === captured.token &&
      current.me?.user.id === captured.me?.user.id &&
      current.me?.voiceInput === true
    );
  };
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      if (!isCurrent())
        throw new VoiceTranscriptionError("unavailable", t("Voice input is unavailable."));
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, { signal }) => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          signal.addEventListener("abort", cancel, { once: true });
          const unsubscribe = subscribeBaskuleSession(() => {
            if (!isCurrent()) cancel();
          });
          const check = () => {
            if (signal.aborted || !isCurrent()) cancel();
            throwIfVoiceTranscriptionAborted(controller.signal);
          };
          try {
            check();
            const file = new File(uri);
            if (file.size > BASKULE_TRANSCRIPTION_MAX_BYTES) {
              throw new VoiceTranscriptionError(
                "transcription-failed",
                t("The recording is too large. Try a shorter recording."),
              );
            }
            const audio = await file.arrayBuffer();
            check();
            if (audio.byteLength === 0 || audio.byteLength > BASKULE_TRANSCRIPTION_MAX_BYTES) {
              throw new VoiceTranscriptionError(
                "transcription-failed",
                t("The recording is empty or too large. Try recording again."),
              );
            }
            const response = await fetch(`${captured.serverUrl}/api/baskule/transcriptions`, {
              method: "POST",
              headers: {
                "content-type": "audio/mp4",
                ...(captured.token ? { authorization: `Bearer ${captured.token}` } : {}),
              },
              body: audio,
              signal: controller.signal,
              credentials: "omit",
              redirect: "error",
            });
            check();
            if (!response.ok) {
              throw new VoiceTranscriptionError(
                "transcription-failed",
                response.status === 429
                  ? t("Voice input is busy or your usage limit has been reached. Try again later.")
                  : response.status === 404
                    ? t("Voice input has been disabled on this server.")
                    : t("Could not transcribe the recording. Try again."),
              );
            }
            const result = parseTranscript(await response.json());
            check();
            return result.text.trim();
          } catch (error) {
            check();
            if (error instanceof VoiceTranscriptionError) throw error;
            throw new VoiceTranscriptionError(
              "transcription-failed",
              t("Could not transcribe the recording. Check your connection and try again."),
              { cause: error },
            );
          } finally {
            signal.removeEventListener("abort", cancel);
            unsubscribe();
          }
        },
      };
    },
  };
}
