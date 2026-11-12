import { useBaskuleMe, readBaskuleMe } from "../baskule/session";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  /** The draft's own environment: its space transcribes the recording. */
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

/**
 * Hosted builds transcribe through the draft's space while the signed-in person has voice input.
 * The recording is abandoned the moment that account changes or the space connection drops.
 */
function useVoiceTranscriptionDestination(environmentId: EnvironmentId) {
  const me = useBaskuleMe();
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return {
    grantId: me?.voiceInput ? me.user.id : null,
    prepared: me?.voiceInput && canDictate ? connection : null,
  };
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const destination = useVoiceTranscriptionDestination(input.environmentId);
  const prepared: PreparedConnection | null = destination.prepared;
  const grantId = destination.grantId;
  const [controllerState, setControllerState] = useState({
    prepared,
    grantId,
    value: INITIAL_STATE,
  });
  const [level, setLevel] = useState(0);
  if (controllerState.prepared !== prepared || controllerState.grantId !== grantId) {
    setControllerState({ prepared, grantId, value: INITIAL_STATE });
    setLevel(0);
  }
  const state: VoiceInputState =
    controllerState.prepared === prepared ? controllerState.value : INITIAL_STATE;

  const controllerRef = useRef<VoiceInputController | null>(null);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestRef = useRef({ input });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props to the asynchronous recording controller
  useEffect(() => {
    latestRef.current = { input };
  });
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks committed draft revisions so a late transcript cannot overwrite an edited draft
  useEffect(() => {
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input.ownerKey, input.draftText]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the recording controller bound to the signed-in account and space connection; it is disposed with either
  useEffect(() => {
    if (!prepared || !grantId || typeof navigator === "undefined") return;
    const hasAudioConsent = () => {
      const me = readBaskuleMe();
      return me?.voiceInput === true && me.user.id === grantId;
    };
    let disposed = false;
    let controller: VoiceInputController;

    const readDraft = (): VoiceDraftSnapshot => {
      const current = latestRef.current.input;
      const draft = current.readDraft();
      const revision = draftRevisionRef.current;
      if (revision.ownerKey !== current.ownerKey || revision.text !== draft.text) {
        draftRevisionRef.current = {
          ownerKey: current.ownerKey,
          text: draft.text,
          revision: revision.revision + 1,
        };
      }
      return {
        ownerKey: current.ownerKey,
        text: draft.text,
        selection: draft.selection,
        revision: draftRevisionRef.current.revision,
      };
    };
    const platform = createBrowserVoiceInputPlatform({
      hasAudioConsent,
      onLevel: setLevel,
      onDurationLimit: () => void controller.stop(),
      onError: (message) => {
        if (!disposed) void controller.interruptRecording(message);
      },
    });
    controller = new VoiceInputController({
      retryFailedRecording: true,
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      readDraft,
      commitDraft: (text, selection) => {
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
        if (pendingSubmissionRef.current) pendingSubmissionRef.current.text = text;
      },
      onStateChange: (value) => {
        if (disposed) return;
        if (value.phase === "error") pendingSubmissionRef.current = null;
        setControllerState({ prepared, grantId, value });
      },
    });
    controllerRef.current = controller;
    return () => {
      disposed = true;
      pendingSubmissionRef.current = null;
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [prepared, grantId]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the recording and any queued submission when the draft's owner changes
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey, input.disabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a queued submission only after the transcript has committed to the draft
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing") return;
    const controller = controllerRef.current;
    if (!controller || !voiceInputBlocksSubmission(state)) {
      submit(latestRef.current.input.readDraft().text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
    if (controller.currentState.phase === "recording") void controller.stop();
  });

  const start = useStableCallback(async () => {
    if (latestRef.current.input.disabled || !grantId) return;
    const controller = controllerRef.current;
    if (!controller || !prepared) return;
    setLevel(0);
    await controller.start();
  });

  return {
    available:
      grantId !== null &&
      prepared !== null &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    state,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputBlocksSubmission(state),
    start,
    submitAfterDictation,
    stop: useStableCallback(() => controllerRef.current?.stop() ?? Promise.resolve()),
    cancel: useStableCallback(() => {
      pendingSubmissionRef.current = null;
      controllerRef.current?.cancel();
    }),
    skipPostProcessing: useStableCallback(() => controllerRef.current?.skipPostProcessing()),
  };
}
