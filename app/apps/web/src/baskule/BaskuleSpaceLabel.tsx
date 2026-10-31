// baskule: which space a chat belongs to (scope Part 2), shown once a person has several spaces.
import type { EnvironmentId } from "@t3tools/contracts";

import { baskule } from "./flags";
import { spaceForEnvironment, useSpaceEnvironments } from "./spaces";

export function BaskuleSpaceLabel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environments = useSpaceEnvironments();
  if (!baskule.hosted || environments.length < 2) return null;
  const space = spaceForEnvironment(environments, environmentId);
  if (space === null) return null;
  return (
    <span
      className="max-w-16 shrink-0 truncate rounded-sm bg-sidebar-control-surface px-1 text-2xs leading-4 text-sidebar-muted-foreground"
      data-testid="baskule-chat-space"
    >
      {space.name}
    </span>
  );
}
