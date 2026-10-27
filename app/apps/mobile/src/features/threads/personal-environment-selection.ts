import type { EnvironmentId } from "@t3tools/contracts";

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
