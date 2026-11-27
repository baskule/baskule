import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";

import { useAtomCommand } from "~/state/use-atom-command";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : m(msg("An error occurred."));
}

export function useNewProject(openProject: (projectRef: ScopedProjectRef) => Promise<void>) {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });

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
            title: m(msg("Could not create the project")),
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
              title: m(msg("Created {name}", { name: input.name })),
              description: workspaceRoot,
            }
          : {
              type: "warning",
              title: m(msg("Created {name} without a first commit", { name: input.name })),
              description: m(
                msg("{error} The project is in {path}.", {
                  error: commitError,
                  path: workspaceRoot,
                }),
              ),
            },
      ),
    );

    const projectRef = scopeProjectRef(input.environmentId, projectId);
    // Wait for the stored project path; drafts use it as their key.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to open project")),
          description: m(
            msg("{error} It will appear in the sidebar once this client catches up.", {
              error: errorMessage(error),
            }),
          ),
        }),
      );
      return null;
    });
    if (project === null) return true;
    await openProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to open project")),
          description: errorMessage(error),
        }),
      );
    });
    return true;
  };
}
