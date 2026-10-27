// baskule: the composer's microphone, left of the send button. While recording it becomes
// cancel, a live level and the elapsed time, and a stop control that inserts the transcript.
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useTranslation } from "../i18n";
import {
  formatRecordingTime,
  MAX_RECORDING_MINUTES,
  recordingLevel,
  type BaskuleVoiceInput,
} from "./voiceInput";

/** The editor keeps focus, so the caret is where the transcript lands. */
const keepEditorFocus = (event: PointerEvent) => event.preventDefault();
const LEVEL_BARS = 4;
const LEVEL_INTERVAL_MS = 100;

export function BaskuleVoiceInputControl({
  voice,
  disabled,
}: {
  readonly voice: BaskuleVoiceInput;
  readonly disabled: boolean;
}) {
  const t = useTranslation();
  const { state } = voice;
  if (state.phase === "recording") {
    return (
      <div className="flex items-center gap-1" role="group" aria-label={t("Voice recording")}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={keepEditorFocus}
                onClick={voice.cancel}
                aria-label={t("Cancel recording")}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>{t("Cancel recording (Esc)")}</TooltipPopup>
        </Tooltip>
        <span className="flex items-center gap-1.5 px-0.5 text-xs text-muted-foreground tabular-nums">
          <LevelMeter analyser={voice.analyser} />
          <RecordingTime startedAt={state.startedAt} />
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={keepEditorFocus}
                onClick={voice.stop}
                aria-label={t("Stop and insert")}
              />
            }
          >
            <SquareIcon className="size-3 fill-current text-destructive" />
          </TooltipTrigger>
          <TooltipPopup>{t("Stop and insert")}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  if (state.phase === "requesting" || state.phase === "transcribing") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled
        aria-label={
          state.phase === "requesting" ? t("Waiting for the microphone…") : t("Transcribing…")
        }
      >
        <Spinner />
      </Button>
    );
  }
  if (!voice.available) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onPointerDown={keepEditorFocus}
            onClick={voice.start}
            aria-label={t("Start voice input")}
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>
        {state.phase === "error"
          ? state.message
          : t("Voice input, up to {{minutes}} minutes", { minutes: MAX_RECORDING_MINUTES })}
      </TooltipPopup>
    </Tooltip>
  );
}

function RecordingTime({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span role="timer">{formatRecordingTime(now - startedAt)}</span>;
}

/** All bars follow speech volume, with a balanced silhouette and no idle animation. */
function LevelMeter({ analyser }: { readonly analyser: () => AnalyserNode | null }) {
  const barsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = analyser();
    const bars = barsRef.current?.children;
    if (!node || !bars || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const samples = new Float32Array(node.fftSize);
    const timer = window.setInterval(() => {
      node.getFloatTimeDomainData(samples);
      const level = recordingLevel(samples);
      for (let bar = 0; bar < bars.length; bar += 1) {
        const element = bars[bar];
        const weight = bar === 0 || bar === bars.length - 1 ? 0.75 : 1;
        if (element instanceof HTMLElement) {
          element.style.transform = `scaleY(${0.2 + 0.8 * level * weight})`;
        }
      }
    }, LEVEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [analyser]);
  return (
    <span ref={barsRef} aria-hidden="true" className="flex h-3.5 items-center gap-0.5">
      {Array.from({ length: LEVEL_BARS }, (_, bar) => (
        <span
          key={bar}
          className="h-full w-0.5 rounded-full bg-destructive transition-transform duration-100"
          style={{ transform: "scaleY(0.2)" }}
        />
      ))}
    </span>
  );
}
