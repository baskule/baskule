// baskule: the composer's voice input with the microphone, MediaRecorder and the transcription
// endpoint stubbed. The composer's own append-and-send wiring is checked by the web loop.
import "~/index.css";

import { startTransition, useLayoutEffect, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../test/render";

const voice = vi.hoisted(() => ({
  available: true,
  uploads: [] as Blob[],
  transcripts: [] as Array<(text: string) => void>,
}));

vi.mock("./flags", async (original) => ({
  ...(await original<typeof import("./flags")>()),
  BASKULE_UI: true,
}));
vi.mock("./session", () => ({ useBaskuleMe: () => ({ voiceInput: voice.available }) }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  baskuleApi: {
    transcribe: (recording: Blob) => {
      voice.uploads.push(recording);
      return new Promise<string>((resolve) => voice.transcripts.push(resolve));
    },
  },
}));

const { BaskuleVoiceInputControl } = await import("./BaskuleVoiceInputControl");
const { useBaskuleVoiceInput } = await import("./voiceInput");
const { toastManager } = await import("../components/ui/toast");

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string) {
    return type === "audio/webm;codecs=opus";
  }
  state: RecordingState = "inactive";
  readonly mimeType: string;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      const data = new Blob(["voice"], { type: this.mimeType });
      this.dispatchEvent(new BlobEvent("dataavailable", { data }));
      this.dispatchEvent(new Event("stop"));
    });
  }
}

function setup(options: { readonly available?: boolean } = {}) {
  voice.available = options.available ?? true;
  voice.uploads = [];
  voice.transcripts = [];
}

/** Stubs the browser's recording APIs; acquire it after the first render. */
function microphone() {
  const stack = new DisposableStack();
  const audio = new AudioContext();
  stack.defer(() => void audio.close());
  const tone = audio.createOscillator();
  const volume = audio.createGain();
  volume.gain.value = 0;
  tone.connect(volume);
  tone.start();
  stack.defer(() => tone.stop());
  const tracks: MediaStreamTrack[] = [];
  stack.use(stubGlobal("MediaRecorder", FakeMediaRecorder));
  const getUserMedia = stack.use(
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async () => {
      await audio.resume();
      const destination = audio.createMediaStreamDestination();
      volume.connect(destination);
      const stream = destination.stream;
      tracks.push(...stream.getTracks());
      return stream;
    }),
  );
  const closeAudio = stack.use(vi.spyOn(AudioContext.prototype, "close"));
  const toast = stack.use(vi.spyOn(toastManager, "add"));
  return {
    getUserMedia,
    closeAudio,
    volume: volume.gain,
    toast,
    released: () => tracks.length > 0 && tracks.every((track) => track.readyState === "ended"),
    [Symbol.dispose]: () => stack.dispose(),
  };
}

it("moves every meter bar for speech and returns to rest in silence", async () => {
  setup();
  await using screen = await render(<Composer onInsert={vi.fn()} onSubmit={vi.fn()} />);
  using media = microphone();
  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect.element(screen.getByRole("timer")).toBeVisible();
  const bars = () =>
    Array.from(screen.container.querySelectorAll<HTMLElement>("[aria-hidden='true'] > span"));
  const heights = () => bars().map((bar) => bar.getBoundingClientRect().height);
  const resting = heights();
  expect(resting).toHaveLength(4);

  media.volume.value = 0.08;
  await expect.poll(() => heights().every((height, index) => height > resting[index]! * 2)).toBe(true);
  const speaking = heights();
  expect(speaking[0]).toBeCloseTo(speaking[3]!, 0);
  expect(speaking[1]).toBeCloseTo(speaking[2]!, 0);

  media.volume.value = 0;
  await expect.poll(() => heights().every((height) => height < 3)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
});

function Composer({
  onInsert,
  onSubmit,
  onSwitched,
}: {
  readonly onInsert: (text: string, targetKey: string) => void;
  readonly onSubmit: (mode: string | undefined, targetKey: string) => void;
  /** Runs in the next chat's layout effects, before its passive effects. */
  readonly onSwitched?: () => void;
}) {
  const [targetKey, setTargetKey] = useState("chat-a");
  const root = useRef<HTMLDivElement>(null);
  const input = useBaskuleVoiceInput({
    targetKey,
    enabled: true,
    root,
    insert: (text) => {
      onInsert(text, targetKey);
      return true;
    },
    submit: (mode) => onSubmit(mode, targetKey),
  });
  useLayoutEffect(() => {
    if (targetKey !== "chat-a") onSwitched?.();
  }, [targetKey, onSwitched]);
  return (
    <div className="flex flex-col gap-2">
      <input type="search" aria-label="Search" />
      <div ref={root} className="flex items-center gap-2">
        <textarea aria-label="Message" />
        <BaskuleVoiceInputControl voice={input} disabled={false} />
        <button
          type="button"
          onClick={() => {
            if (!input.takeSubmit("queue")) onSubmit("auto", targetKey);
          }}
        >
          Send
        </button>
      </div>
      {/* Unlike a click's own update, a transition leaves passive effects for later, as navigations do. */}
      <button type="button" onClick={() => startTransition(() => setTargetKey("chat-b"))}>
        Switch chat
      </button>
    </div>
  );
}

it("stops, transcribes and inserts the text, then releases the microphone", async () => {
  setup();
  const onInsert = vi.fn();
  const onSubmit = vi.fn();
  await using screen = await render(<Composer onInsert={onInsert} onSubmit={onSubmit} />);
  using media = microphone();

  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect.element(screen.getByRole("timer")).toHaveTextContent("0:00");
  await userEvent.click(screen.getByRole("button", { name: "Stop and insert" }));
  await expect.element(screen.getByRole("button", { name: "Transcribing…" })).toBeDisabled();
  expect(media.released()).toBe(true);
  expect(media.closeAudio).toHaveBeenCalled();
  expect(voice.uploads.map((upload) => upload.type)).toEqual(["audio/webm;codecs=opus"]);

  voice.transcripts[0]!("  hello world ");
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toBeVisible();
  expect(onInsert).toHaveBeenCalledExactlyOnceWith("hello world", "chat-a");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("sends once the transcript is in when Send is pressed while recording", async () => {
  setup();
  const onInsert = vi.fn();
  const onSubmit = vi.fn();
  await using screen = await render(<Composer onInsert={onInsert} onSubmit={onSubmit} />);
  using _media = microphone();

  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect.element(screen.getByRole("button", { name: "Stop and insert" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByRole("button", { name: "Transcribing…" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSubmit).not.toHaveBeenCalled();

  voice.transcripts[0]!("ship it");
  await expect.poll(() => onSubmit.mock.calls).toEqual([["queue", "chat-a"]]);
  expect(onInsert).toHaveBeenCalledExactlyOnceWith("ship it", "chat-a");
  expect(onInsert.mock.invocationCallOrder[0]).toBeLessThan(onSubmit.mock.invocationCallOrder[0]!);
  expect(voice.uploads).toHaveLength(1);
});

it("discards the recording on cancel, Escape with nothing focused, or a chat switch", async () => {
  setup();
  const onInsert = vi.fn();
  const onSubmit = vi.fn();
  await using screen = await render(<Composer onInsert={onInsert} onSubmit={onSubmit} />);
  using media = microphone();
  const start = screen.getByRole("button", { name: "Start voice input" });

  await userEvent.click(start);
  await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
  await expect.element(start).toBeVisible();

  await userEvent.click(start);
  await expect.element(screen.getByRole("button", { name: "Stop and insert" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(start).toBeVisible();

  await userEvent.click(start);
  await expect.element(screen.getByRole("button", { name: "Stop and insert" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Switch chat" }));
  await expect.element(start).toBeVisible();

  expect(media.getUserMedia).toHaveBeenCalledTimes(3);
  expect(media.released()).toBe(true);
  expect(voice.uploads).toEqual([]);
  expect(onInsert).not.toHaveBeenCalled();
});

it("leaves Escape in another field to that field and cancels on Escape in the composer", async () => {
  setup();
  const onInsert = vi.fn();
  await using screen = await render(<Composer onInsert={onInsert} onSubmit={vi.fn()} />);
  using _media = microphone();
  const stop = screen.getByRole("button", { name: "Stop and insert" });

  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect.element(stop).toBeVisible();
  await userEvent.click(screen.getByRole("searchbox", { name: "Search" }));
  await userEvent.keyboard("{Escape}");
  await expect.element(stop).toBeVisible();

  await userEvent.click(screen.getByRole("textbox", { name: "Message" }));
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toBeVisible();
  expect(voice.uploads).toEqual([]);
  expect(onInsert).not.toHaveBeenCalled();
});

it("drops a transcript that arrives after a chat switch instead of sending it there", async () => {
  setup();
  const onInsert = vi.fn();
  const onSubmit = vi.fn();
  const arriveLate = () => voice.transcripts[0]!("meant for chat a");
  await using screen = await render(
    <Composer onInsert={onInsert} onSubmit={onSubmit} onSwitched={arriveLate} />,
  );
  using _media = microphone();

  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect.element(screen.getByRole("button", { name: "Stop and insert" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.poll(() => voice.uploads).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Switch chat" }));

  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toBeVisible();
  expect(onInsert).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("explains a blocked microphone and keeps the button", async () => {
  setup();
  await using screen = await render(<Composer onInsert={vi.fn()} onSubmit={vi.fn()} />);
  using media = microphone();
  media.getUserMedia.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

  await userEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  await expect
    .poll(() => media.toast.mock.calls[0]?.[0])
    .toMatchObject({
      type: "error",
      title:
        "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
    });
  await expect.element(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled();
});

it("shows no microphone when voice input is off", async () => {
  setup({ available: false });
  await using screen = await render(<Composer onInsert={vi.fn()} onSubmit={vi.fn()} />);
  await expect.element(screen.getByRole("button", { name: "Send" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Start voice input" }).query()).toBeNull();
});
