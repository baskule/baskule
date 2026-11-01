// baskule: "New chat" always opens a draft in the scratch ("No project") project of the
// primary environment; the server creates that project lazily (ensureScratchProject).
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../state/environments";
import { BASKULE_HOSTED } from "./flags";

export function useBaskuleNewChat() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  // A ready team must not become the default while the personal space is still starting.
  const environmentId = BASKULE_HOSTED
    ? primaryEnvironmentId !== null && scratchWorkspaceRootFor(primaryEnvironmentId) !== null
      ? primaryEnvironmentId
      : null
    : scratchEnvironmentId(primaryEnvironmentId);
  const startNewChat = async (options?: { readonly replace?: boolean }) => {
    if (environmentId === null) return null;
    const project = await openScratchProject(environmentId, "Could not start a new chat");
    if (project === null) return null;
    return handleNewThread(
      scopeProjectRef(project.environmentId, project.id),
      options?.replace ? { replace: true } : {},
    );
  };
  return { available: environmentId !== null, startNewChat };
}
