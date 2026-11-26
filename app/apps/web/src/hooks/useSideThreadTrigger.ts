import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import { createContext, use } from "react";

export const SideThreadsOpenContext = createContext(true);

export function useSideThreadTrigger() {
  const canOpen = use(SideThreadsOpenContext);
  return (open: (intent: SideThreadOpenIntent) => void, _options?: { readonly panel?: boolean }) =>
    canOpen ? { onClick: () => open("primary") } : {};
}
