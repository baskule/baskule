import { t, useTranslation } from "../i18n";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";

import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("An error occurred.");
}

export function useNewProject() {
  const t = useTranslation();
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
  }): Promise<boolean> => {
    const result = await createNew({
      environmentId: input.environmentId,
      input: { name: input.name },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not create the project"),
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    }

    const { projectId, workspaceRoot, commitError } = result.value;
    toastManager.add(
      stackedThreadToast(
        commitError === undefined
          ? {
              type: "success",
              title: t("Created {{name}}", { name: input.name }),
              description: workspaceRoot,
            }
          : {
              type: "warning",
              title: t("Created {{name}} without a first commit", { name: input.name }),
              description: t("{{commitError}} The project is in {{workspaceRoot}}.", {
                commitError: commitError,
                workspaceRoot: workspaceRoot,
              }),
            },
      ),
    );

    const projectRef = scopeProjectRef(input.environmentId, projectId);
    // Wait for the stored project path; drafts use it as their key.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to open project"),
          description: t("{{value1}} It will appear in the sidebar once this client catches up.", {
            value1: errorMessage(error),
          }),
        }),
      );
      return null;
    });
    if (project === null) return true;
    await handleNewThread(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to open project"),
          description: errorMessage(error),
        }),
      );
    });
    return true;
  };
}
