import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { msg, useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  [msg(
    "Microphone access is required for voice input. Allow access in your browser or system settings and try again.",
  )]: msg("Microphone blocked"),
  [msg("Microphone access is required for voice input.")]: msg("Microphone blocked"),
  [msg("This draft is no longer available.")]: msg("Draft unavailable"),
  [msg("Another voice recording is already active.")]: msg("Another recording active"),
  [msg("Voice transcription is not available.")]: msg("Voice input unavailable"),
  [msg("Voice transcription is still finishing. Try again shortly.")]: msg(
    "Transcription still busy",
  ),
  [msg("Voice transcription is not available for this language.")]: msg("Language unsupported"),
  [msg("Could not prepare voice transcription.")]: msg("Couldn’t prepare dictation"),
  [msg("Could not start voice recording.")]: msg("Couldn’t start recording"),
  [msg("Voice recording was interrupted.")]: msg("Recording interrupted"),
  [msg("Could not finish voice recording.")]: msg("Couldn’t finish recording"),
  [msg("Could not transcribe this recording.")]: msg("Transcription failed"),
  [msg("Voice transcription on this environment failed.")]: msg("Transcription failed"),
  [msg("The draft changed while voice input was running. The transcript was not added.")]:
    msg("Draft changed"),
  [msg("No speech was detected.")]: msg("No speech detected"),
  [msg("Microphone processing failed.")]: msg("Microphone error"),
  [msg("The microphone disconnected.")]: msg("Microphone disconnected"),
};

function voiceErrorLabel(error: string | null): string {
  return (error && VOICE_ERROR_LABELS[error]) || msg("Voice input failed");
}

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  const error = props.error === null ? t("Voice input failed") : t(props.error);
  const openSettings = props.errorAction === "settings";
  const actionLabel = openSettings
    ? t("Open voice settings")
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? t("Retry transcription")
      : t("Record again");
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={t("Dismiss voice input error")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {t("Dismiss voice input error")}
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={error}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {t(voiceErrorLabel(props.error))}
        </TooltipTrigger>
        <TooltipPopup side="top">{error}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm-pill"
                variant="ghost"
                aria-label={actionLabel}
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (openSettings) {
                    props.onDismiss();
                    void navigate({ to: "/settings/voice" });
                  } else {
                    props.onRetry();
                  }
                }}
              >
                {openSettings ? <SettingsIcon /> : <RotateCcwIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </VoiceInputPill>
  );
}
