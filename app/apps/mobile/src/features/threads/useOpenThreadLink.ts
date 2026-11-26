import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function useOpenThreadLink(_viaEnvironmentId?: EnvironmentId | null) {
  const openThread = useOpenLinkedThread();
  return (thread: ScopedThreadRef) => {
    openThread({ environmentId: String(thread.environmentId), threadId: String(thread.threadId) });
  };
}
