// baskule: user-facing copy says "chat", not "thread" (E2E UX review). Applied at a few seams
// (confirm dialogs, toasts, empty states) rather than by editing every upstream string.
import { BASKULE_HOSTED, BASKULE_UI } from "./flags";

const WORDS: Readonly<Record<string, string>> = {
  thread: "chat",
  threads: "chats",
  Thread: "Chat",
  Threads: "Chats",
};

export function baskuleCopy<T>(text: T): T {
  if (!BASKULE_UI || typeof text !== "string") return text;
  return text.replace(/\b(?:[Tt]hreads?)\b/g, (word) => WORDS[word] ?? word) as T;
}

/** Rewrites the title and description of every toast added or updated through `manager`. */
export function rewriteToastCopy<
  M extends {
    add: (options: never) => unknown;
    update: (id: never, options: never) => unknown;
  },
>(manager: M): void {
  if (!BASKULE_UI) return;
  const rewrite = <O>(options: O): O =>
    options && typeof options === "object"
      ? {
          ...options,
          ...("title" in options ? { title: baskuleCopy(options.title) } : {}),
          ...("description" in options ? { description: baskuleCopy(options.description) } : {}),
        }
      : options;
  const add = manager.add.bind(manager) as (options: unknown) => unknown;
  const update = manager.update.bind(manager) as (id: unknown, options: unknown) => unknown;
  Object.assign(manager, {
    add: (options: unknown) => add(rewrite(options)),
    update: (id: unknown, options: unknown) => update(id, rewrite(options)),
  });
}

/**
 * Connection banners name the host's "T3 Code"; in the hosted build the host is a space, so
 * "T3 Code on Acme did not answer" reads "Acme did not answer".
 */
export function baskuleHostCopy(text: string): string {
  if (!BASKULE_HOSTED) return text;
  return text.replace(/T3 Code on /g, "").replace(/T3 Code/g, "Baskule");
}
