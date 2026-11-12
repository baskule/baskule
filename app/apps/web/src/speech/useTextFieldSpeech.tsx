import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  ComposerSpeechButton,
  ComposerSpeechRecordingPill,
} from "~/components/chat/ComposerSpeechButton";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

/** Binds dictation to a plain textarea draft; the shortcut targets it only while it has focus. */
export function useTextFieldSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly text: string;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onTextChange: (text: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed field callbacks to the asynchronous recording controller
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    ownerKey: input.ownerKey,
    draftText: input.text,
    disabled: input.disabled,
    readDraft: () => {
      const field = latest.current.textareaRef.current;
      const cursor = field?.selectionStart ?? latest.current.text.length;
      return {
        text: field?.value ?? latest.current.text,
        selection: { start: cursor, end: field?.selectionEnd ?? cursor },
      };
    },
    commitDraft: (text, selection) => {
      latest.current.onTextChange(text);
      window.requestAnimationFrame(() => {
        const field = latest.current.textareaRef.current;
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(selection.start, selection.end);
      });
    },
  });
  const shortcutLabel = useDictationShortcut({
    keybindings,
    speech,
    disabled: input.disabled ?? false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: input.textareaRef,
  });
  return { ...speech, shortcutLabel };
}

export type TextFieldSpeech = ReturnType<typeof useTextFieldSpeech>;

export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ComposerSpeechRecordingPill
        state={speech.state}
        progress={null}
        level={speech.level}
        finishShortcutLabel={speech.shortcutLabel}
        cancelShortcutLabel="Esc"
        disabled={disabled}
        onStart={() => void speech.start()}
        onStop={() => void speech.stop()}
        onCancel={speech.cancel}
        onSkipPostProcessing={speech.skipPostProcessing}
      />
      {speech.available ? (
        <ComposerSpeechButton
          state={speech.state}
          progress={null}
          shortcutLabel={speech.shortcutLabel}
          disabled={disabled}
          onStart={() => void speech.start()}
          onCancel={speech.cancel}
        />
      ) : null}
    </div>
  );
}

/** Render-prop form for editors that only sometimes have an environment to dictate on. */
export function SpeechTextField({
  children,
  ...input
}: Parameters<typeof useTextFieldSpeech>[0] & {
  children: (speech: TextFieldSpeech) => ReactNode;
}) {
  return children(useTextFieldSpeech(input));
}
