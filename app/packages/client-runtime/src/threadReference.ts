import type { ComposerContextClipboardFragment, ScopedThreadRef } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { hostedThreadLink } from "@t3tools/shared/threadLinks";

export interface ThreadReferenceCopyTarget {
  readonly kind: "thread";
  readonly value: string;
  readonly description?: string;
  readonly fragment?: ComposerContextClipboardFragment;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}
export function resolveThreadReferenceCopyTarget(input: {
  readonly threadId: string;
}): ThreadReferenceCopyTarget {
  return {
    kind: "thread",
    value: input.threadId,
    clipboardTarget: "thread ID",
    successTitle: "Thread ID copied",
    failureTitle: "Failed to copy thread ID",
  };
}

export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
  hostedAppUrl?: string,
): ThreadReferenceCopyTarget {
  const record = threadContextRecord(threadRef, title);
  return {
    kind: "thread",
    value: hostedThreadLink(threadRef, hostedAppUrl),
    description: record.title,
    fragment: { version: 1, source: { environmentId: threadRef.environmentId }, records: [record] },
    clipboardTarget: "thread",
    successTitle: "Thread copied",
    failureTitle: "Failed to copy thread",
  };
}
