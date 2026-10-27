// baskule: message authorship in shared spaces (scope Part 3). The server stamps `author` from
// the signed-in identity; the client names everyone except the reader, like a group chat.
import { useBaskuleMe } from "./session";

export interface MessageAuthor {
  readonly id: string;
  readonly name: string;
}

export function otherAuthor(
  author: MessageAuthor | undefined,
  currentUserId: string | null,
): MessageAuthor | null {
  if (!author) return null;
  return author.id === currentUserId ? null : author;
}

export function useOtherAuthor(author: MessageAuthor | undefined): MessageAuthor | null {
  const me = useBaskuleMe();
  return otherAuthor(author, me?.user.id ?? null);
}
