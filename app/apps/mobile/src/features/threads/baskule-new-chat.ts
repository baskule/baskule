import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { readSpaceEnvironments } from "../../baskule/spaces";
import * as Dialog from "../../components/ui/Dialog";
import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { workspaceConnections } from "../../state/workspace";
import { resolveNewChatEnvironment } from "./personal-environment-selection";

export type NewChatDraft = {
  readonly draft: {
    readonly requestId: string;
    readonly environmentId: string;
    readonly projectId: string;
  };
};

let starting = false;

/**
 * baskule: opens the scratch project first, so the draft appears with its project and never
 * passes through the project picker. Repeated taps while it opens start one chat.
 */
export async function startBaskuleNewChat(
  selectedEnvironmentId: EnvironmentId | null,
  open: (params: NewChatDraft) => void,
): Promise<void> {
  if (starting) return;
  const target = resolveNewChatEnvironment({
    selectedEnvironmentId,
    spaces: readSpaceEnvironments(),
    environments: appAtomRegistry.get(workspaceConnections.environmentsAtom),
    serverConfigs: appAtomRegistry.get(environmentServerConfigsAtom),
  });
  if (target.kind === "unavailable") {
    Dialog.alert(
      t("Can't start a chat yet"),
      target.environmentId === null
        ? t("Your spaces are still loading. Try again in a moment.")
        : t("This space is not connected. Try again when it is back online."),
    );
    return;
  }
  starting = true;
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.openScratch,
      { environmentId: target.environmentId, input: {} },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          t("Could not start a new chat"),
          error instanceof Error ? error.message : t("Try again."),
        );
      }
      return;
    }
    open({
      draft: {
        requestId: uuidv4(),
        environmentId: String(result.value.environmentId),
        projectId: String(result.value.id),
      },
    });
  } finally {
    starting = false;
  }
}
