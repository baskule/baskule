import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

const harness = vi.hoisted(() => ({
  voice: undefined as unknown as ReturnType<typeof useEnvironmentSpeechInput>,
  prepared: { environmentId: "space" },
  me: { voiceInput: true, user: { id: "alice" } } as {
    voiceInput: boolean;
    user: { id: string };
  } | null,
  draft: "Draft",
  committed: vi.fn(),
  submitted: vi.fn(),
  stopped: vi.fn(),
  transcript: undefined as Promise<string> | undefined,
}));
vi.mock("../baskule/session", () => ({
  useBaskuleMe: () => harness.me,
  readBaskuleMe: () => harness.me,
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  usePreparedConnection: () => Option.some(harness.prepared),
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: () => ({
    recorder: {
      uri: "blob:recording",
      prepareToRecordAsync: async () => {},
      record() {},
      stop: async () => {
        harness.stopped();
      },
    },
    transcriber: {
      prepare: async () => ({
        locale: "en",
        transcribe: async () => harness.transcript ?? "dictated",
      }),
    },
    cancelRecording() {},
    deleteRecording() {},
  }),
}));

function Composer({ chat }: { chat: string }) {
  const voice = useEnvironmentSpeechInput({
    environmentId: EnvironmentId.make("space"),
    ownerKey: chat,
    draftText: harness.draft,
    readDraft: () => ({
      text: harness.draft,
      selection: { start: harness.draft.length, end: harness.draft.length },
    }),
    commitDraft: (text, selection) => {
      harness.draft = text;
      harness.committed(text, selection);
    },
  });
  useLayoutEffect(() => {
    harness.voice = voice;
  });
  return null;
}

function setup() {
  harness.draft = "Draft";
  harness.me = { voiceInput: true, user: { id: "alice" } };
  harness.committed.mockClear();
  harness.submitted.mockClear();
  harness.stopped.mockClear();
  let resolve!: (text: string) => void;
  harness.transcript = new Promise<string>((complete) => {
    resolve = complete;
  });
  return { resolve };
}

it("finishes hosted dictation before sending and sends once after the transcript commits", async () => {
  const pending = setup();
  await using _screen = await render(<Composer chat="one" />);
  await act(() => harness.voice.start());
  expect(harness.voice.state.phase).toBe("recording");
  await act(() => {
    harness.voice.submitAfterDictation(harness.submitted);
  });
  expect(harness.stopped).toHaveBeenCalledOnce();
  expect(harness.submitted).not.toHaveBeenCalled();
  await act(() => {
    pending.resolve("dictated");
  });
  await vi.waitFor(() => expect(harness.submitted).toHaveBeenCalledOnce());
  expect(harness.submitted).toHaveBeenCalledWith(harness.draft);
  expect(harness.draft).toContain("dictated");
  expect(harness.committed).toHaveBeenCalledOnce();
});

it.each(["cancel", "chat switch"])(
  "discards a late hosted transcript and queued send after %s",
  async (action) => {
    const pending = setup();
    await using screen = await render(<Composer chat="one" />);
    await act(() => harness.voice.start());
    await act(() => {
      harness.voice.submitAfterDictation(harness.submitted);
    });
    if (action === "cancel") await act(() => harness.voice.cancel());
    else await screen.rerender(<Composer chat="two" />);
    await act(() => {
      pending.resolve("late transcript");
    });
    expect(harness.committed).not.toHaveBeenCalled();
    expect(harness.submitted).not.toHaveBeenCalled();
    expect(harness.draft).toBe("Draft");
  },
);

it.each([
  ["voice input off", { voiceInput: false, user: { id: "alice" } }],
  ["signed out", null],
])("offers no dictation when %s", async (_case, me) => {
  setup();
  harness.me = me;
  await using _screen = await render(<Composer chat="one" />);
  expect(harness.voice.available).toBe(false);
  await act(() => harness.voice.start());
  expect(harness.voice.state.phase).toBe("idle");
  expect(harness.stopped).not.toHaveBeenCalled();
});
