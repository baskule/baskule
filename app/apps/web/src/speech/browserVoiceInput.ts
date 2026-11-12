import { transcribeBaskulePcm } from "../baskule/transcription";
import { createBrowserPcmCapture } from "./browserPcmCapture";

/** Records with the browser's default microphone and transcribes through the hosted Baskule route. */
export function createBrowserVoiceInputPlatform(input: {
  readonly hasAudioConsent: () => boolean;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onError: (message: string) => void;
}) {
  return createBrowserPcmCapture({ ...input, getMicrophoneId: () => "" }, async () => ({
    locale: "auto",
    transcribe: (uri, { signal }) => transcribeBaskulePcm(uri, signal, input.hasAudioConsent),
  }));
}
