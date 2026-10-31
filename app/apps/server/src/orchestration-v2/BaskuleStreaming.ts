// baskule: OpenCode token deltas flush through the last complete word, at most every 400 ms,
// so one-paragraph answers stream before completion. Unterminated fences keep upstream's boundary
// to deliver whole code blocks. BASKULE_STREAMING=paragraph restores upstream behavior.
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
