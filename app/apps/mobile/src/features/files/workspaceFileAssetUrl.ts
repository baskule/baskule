import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { workspaceFileResource } from "./workspaceFileResource";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly draftCwd?: string | null;
}) {
  const { cwd, relativePath, threadId, draftCwd } = props;
  const resource = useMemo(
    () => workspaceFileResource({ cwd, relativePath, threadId, draftCwd }),
    [cwd, relativePath, threadId, draftCwd],
  );
  const state = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}
