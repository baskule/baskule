// baskule: finer assistant streaming (E2E UX review). Upstream delivers streamed assistant text
// only at paragraph boundaries (its per-token mode was retired), so a one-paragraph answer shows
// "Thinking" and then lands at once. OpenCode emits token deltas; in Baskule deployments the
// filter also delivers up to the last complete word, still throttled to one update per 400 ms.
// Inside an unterminated code fence it keeps upstream's boundary so a code block lands whole.
// `BASKULE_STREAMING=paragraph` restores upstream behavior.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { splitBufferedAssistantText } from "./assistantStreaming.ts";

const FENCE_LINE = /^ *(?:`{3,}|~{3,})/;

export function splitAssistantTextAtWord(text: string): { ready: string; rest: string } {
  const paragraph = splitBufferedAssistantText(text);
  const fences = text.split("\n").filter((line) => FENCE_LINE.test(line)).length;
  if (fences % 2 === 1) return paragraph;
  const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
  if (lastSpace + 1 <= paragraph.ready.length) return paragraph;
  return { ready: text.slice(0, lastSpace + 1), rest: text.slice(lastSpace + 1) };
}

export const baskuleAssistantTextSplit = Effect.gen(function* () {
  const streaming = yield* Config.String("BASKULE_STREAMING").pipe(Config.option);
  const baskule = yield* Config.Boolean("BASKULE").pipe(Config.withDefault(false));
  const authMode = yield* Config.String("BASKULE_AUTH_MODE").pipe(Config.option);
  const mode = Option.getOrElse(streaming, () =>
    baskule || Option.isSome(authMode) ? "word" : "paragraph",
  );
  return mode === "word" ? splitAssistantTextAtWord : splitBufferedAssistantText;
}).pipe(Effect.orElseSucceed(() => splitBufferedAssistantText));
