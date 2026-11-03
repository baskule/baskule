import {
  repositoryGroupingKeyOf,
  type ModelSelection,
  type RepositoryIdentity,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel, type SelectableModelOption } from "@t3tools/shared/model";

import type { PromptLinkRepository } from "@t3tools/shared/promptLinks";

// A link's `owner/name` is GitHub's. GitCafe syncs a repository two-way with GitHub under the
// same path, so a checkout cloned from git.cafe counts as the linked repository.
const PROMPT_LINK_REPOSITORY_HOSTS = ["github.com", "git.cafe", "staging.git.cafe"];

/**
 * The repository's projects in the order given. Callers pass projects most recently active
 * first and open the first, so the user lands where they last worked.
 */
export function findPromptLinkProjects<
  P extends { readonly repositoryIdentity?: RepositoryIdentity | null | undefined },
>(projects: ReadonlyArray<P>, repository: PromptLinkRepository): P[] {
  const path = `${repository.owner}/${repository.name}`.toLowerCase();
  const keys = new Set(PROMPT_LINK_REPOSITORY_HOSTS.map((host) => `${host}/${path}`));
  return projects.filter(
    (project) =>
      project.repositoryIdentity != null &&
      keys.has(repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()),
  );
}

const PROVIDER_ALIASES: Record<string, string> = { claude: "claudeagent" };

/**
 * `exact` is false when the instance exists but the model does not, so its default model
 * stands in. Null when no usable instance of that provider exists; the user's default
 * applies then.
 */
export function resolvePromptLinkModelSelection(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "availability" | "status"> & {
      readonly models: ReadonlyArray<
        SelectableModelOption & { readonly isDefault?: boolean | undefined }
      >;
    }
  >,
  request: { readonly provider: string; readonly model: string | null },
): { readonly selection: ModelSelection; readonly exact: boolean } | null {
  const driver = PROVIDER_ALIASES[request.provider] ?? request.provider;
  const usable = providers.filter(
    (provider) =>
      provider.driver.toLowerCase() === driver &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
  const instance =
    usable.find((provider) => provider.status === "ready") ??
    usable.find((provider) => provider.status === "warning");
  if (instance === undefined) return null;
  const requested =
    request.model === null
      ? null
      : resolveSelectableModel(instance.driver, request.model, instance.models);
  const model =
    requested ??
    (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug;
  if (model === undefined) return null;
  return {
    selection: { instanceId: instance.instanceId, model },
    exact: request.model === null || requested !== null,
  };
}
