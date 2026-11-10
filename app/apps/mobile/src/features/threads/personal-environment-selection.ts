import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

export type NewChatSelection =
  | { readonly kind: "default-personal" }
  | { readonly kind: "explicit"; readonly environmentId: EnvironmentId };

export function newChatEnvironmentId(
  selection: NewChatSelection,
  spaces: ReadonlyArray<{
    readonly kind: "personal" | "team";
    readonly environmentId: EnvironmentId;
  }>,
): EnvironmentId | null {
  return selection.kind === "explicit"
    ? selection.environmentId
    : (spaces.find((space) => space.kind === "personal")?.environmentId ?? null);
}

export type NewChatEnvironment =
  | { readonly kind: "ready"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unavailable"; readonly environmentId: EnvironmentId | null };

/**
 * baskule: a new chat starts in the space the list shows, else Personal, and only once that
 * space can open its scratch project. It never moves to another space that happens to be ready.
 */
export function resolveNewChatEnvironment(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly spaces: ReadonlyArray<{
    readonly kind: "personal" | "team";
    readonly environmentId: EnvironmentId;
  }>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "scratchWorkspaceRoot">>;
}): NewChatEnvironment {
  const selected = input.spaces.some((space) => space.environmentId === input.selectedEnvironmentId)
    ? input.selectedEnvironmentId
    : null;
  const environmentId = newChatEnvironmentId(
    selected === null
      ? { kind: "default-personal" }
      : { kind: "explicit", environmentId: selected },
    input.spaces,
  );
  if (environmentId === null) return { kind: "unavailable", environmentId: null };
  const environment = input.environments.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  return environment &&
    availableScratchWorkspaceRoot(
      environment.connectionState,
      input.serverConfigs.get(environmentId),
    ) !== null
    ? { kind: "ready", environmentId }
    : { kind: "unavailable", environmentId };
}
