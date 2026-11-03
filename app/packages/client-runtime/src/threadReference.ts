export interface ThreadReferenceCopyTarget {
  readonly kind: "thread";
  readonly value: string;
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
