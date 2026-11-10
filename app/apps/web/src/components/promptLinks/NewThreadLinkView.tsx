import { useTranslation } from "../../i18n";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryPath,
} from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProjects,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { type NewThreadLink, type PromptLinkRepository } from "@t3tools/shared/promptLinks";
import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";

import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { newProjectId } from "~/lib/utils";
import { useProjects, useThreadShells, waitForProject } from "~/state/entities";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { allReachableShellsLiveAtom } from "~/state/shell";
import { sourceControlEnvironment } from "~/state/sourceControl";

import { useAtomCommand } from "~/state/use-atom-command";

import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { placeLinkedPrompt } from "./linkedPrompt";

type LinkState =
  | { readonly status: "opening" }
  | { readonly status: "opened" }
  | { readonly status: "failed"; readonly message: string; readonly title?: string }
  | { readonly status: "missing-repository"; readonly repository: PromptLinkRepository };

type LinkLaunch =
  | { readonly kind: "draft"; readonly project: EnvironmentProject }
  | { readonly kind: "scratch" }
  | { readonly kind: "settled" };

const openedLinkKeys = new Set<string>();

export function NewThreadLinkView({ link }: { readonly link: NewThreadLink }) {
  const t = useTranslation();
  const locationKey = useLocation({ select: (location) => location.state.__TSR_key ?? "" });
  const ready = useAtomValue(allReachableShellsLiveAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const [state, setState] = useState<LinkState>(() =>
    openedLinkKeys.has(locationKey) ? { status: "opened" } : { status: "opening" },
  );
  const [started, setStarted] = useState(false);
  const [launch, setLaunch] = useState<LinkLaunch | null>(null);
  const launchedRef = useRef<LinkLaunch | null>(null);

  const recentProjects = () =>
    sortScopedProjectsForSidebar(
      projects.filter((project) => project.isScratch !== true),
      threads,
      "updated_at",
    );

  const lastActiveEnvironmentId = () => {
    let latest: (typeof threads)[number] | undefined;
    for (const thread of threads) {
      if (latest === undefined || thread.updatedAt > latest.updatedAt) latest = thread;
    }
    return latest?.environmentId ?? primaryEnvironmentId;
  };

  const openDraft = async (project: EnvironmentProject, extraPrompt?: string) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    }).catch(() => null);
    if (opened === null) {
      setState({ status: "failed", message: t("T3 Code could not open a new thread.") });
      return;
    }
    setState({ status: "opened" });
    const notes: Array<string> = [];
    if (link.kind === "new" && link.provider !== null) {
      const providers =
        appAtomRegistry
          .get(environmentPresentations.providersByEnvironmentAtom)
          .get(project.environmentId) ?? [];
      const resolved = resolvePromptLinkModelSelection(providers, {
        provider: link.provider,
        model: link.model,
      });
      if (resolved !== null) {
        useComposerDraftStore.getState().setModelSelection(opened.draftId, resolved.selection, {
          explicit: true,
          replaceOptions: true,
        });
      }
      if (resolved === null || !resolved.exact) {
        notes.push(
          resolved === null
            ? `The link asked for ${link.provider}, which is not set up here, so your default model is used.`
            : `The link asked for ${link.model}, which ${link.provider} does not offer here, so its default model is used.`,
        );
      }
    }
    const text = [link.prompt?.text, extraPrompt].filter(Boolean).join("\n\n");
    if (text.length === 0) return;
    placeLinkedPrompt(
      opened.draftId,
      { text, hiddenCharacters: link.prompt?.hiddenCharacters ?? 0 },
      notes,
    );
  };

  const openScratchDraft = async () => {
    const environmentId = scratchEnvironmentId(lastActiveEnvironmentId());
    const project = environmentId === null ? null : await openScratchProject(environmentId);
    if (project === null) {
      setState({
        status: "failed",
        message: t("None of your machines can start a thread without a project right now."),
      });
      return;
    }
    await openDraft(project, undefined);
  };

  const openWithoutProject = () => {
    setState({ status: "opening" });
    void openScratchDraft();
  };

  const cloneRepository = async (repository: PromptLinkRepository) => {
    const environmentId = lastActiveEnvironmentId();
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const serverConfig = environment?.serverConfig ?? null;
    const newProjectsRoot = serverConfig?.newProjectsRoot ?? null;
    if (environmentId === null || serverConfig === null || newProjectsRoot === null) {
      setState({
        status: "failed",
        message: t(
          "This machine cannot clone from a link. Update T3 Code on it, or clone the repository from the command palette.",
        ),
      });
      return;
    }
    setState({ status: "opening" });
    const projectId = newProjectId();
    const remoteUrl = `https://github.com/${repository.owner}/${repository.name}.git`;
    const settings = serverConfig.settings;
    const result = await startProjectClone({
      environmentId,
      input: {
        projectId,
        title: repository.name,
        createdAt: new Date().toISOString(),
        remoteUrl,
        destinationPath: getCloneDestinationPath(
          settings.ghqCloneLayout
            ? getAddProjectInitialQuery(settings.addProjectBaseDirectory)
            : newProjectsRoot,
          getCloneDirectoryPath(remoteUrl, settings.ghqCloneLayout === true),
        ),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Clone failed"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      }
      setState({ status: "missing-repository", repository });
      return;
    }
    const project = await waitForProject(scopeProjectRef(environmentId, projectId), 5_000).catch(
      () => null,
    );
    if (project === null) {
      setState({
        status: "failed",
        message: t("The clone started, but its project did not appear."),
      });
      return;
    }
    await openDraft(project);
  };

  if (ready && state.status === "opening" && !started) {
    setStarted(true);
    const repository = link.repository;
    const project =
      repository === null ? undefined : findPromptLinkProjects(recentProjects(), repository)[0];
    if (repository === null) setLaunch({ kind: "scratch" });
    else if (project === undefined) {
      setState({ status: "missing-repository", repository });
      setLaunch({ kind: "settled" });
    } else setLaunch({ kind: "draft", project });
  }

  const runLaunch = useEffectEvent((next: LinkLaunch) => {
    openedLinkKeys.add(locationKey);
    switch (next.kind) {
      case "scratch":
        void openScratchDraft();
        return;
      case "draft":
        void openDraft(next.project);
        return;
      case "settled":
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs each launch decision once: navigates to the thread or opens a draft
  useEffect(() => {
    if (launch === null || launchedRef.current === launch) return;
    launchedRef.current = launch;
    runLaunch(launch);
  }, [launch]);

  switch (state.status) {
    case "opening":
      return <LinkPage title={t("Opening the link...")} />;
    case "opened":
      return (
        <LinkPage title={t("This link is open")}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openedLinkKeys.delete(locationKey);
              setStarted(false);
              setState({ status: "opening" });
            }}
          >
            {t("Open it again")}
          </Button>
        </LinkPage>
      );
    case "failed":
      return (
        <LinkPage title={state.title ?? t("Could not open the link")} description={state.message} />
      );
    case "missing-repository": {
      const name = `${state.repository.owner}/${state.repository.name}`;
      return (
        <LinkPage
          title={t("You don't have {{name}}", { name: name })}
          description={t("Clone it to work on it here, or start without a project.")}
        >
          <Button size="sm" onClick={() => void cloneRepository(state.repository)}>
            {t("Clone")} {name}
          </Button>
          <Button size="sm" variant="outline" onClick={openWithoutProject}>
            {t("Use without project")}
          </Button>
        </LinkPage>
      );
    }
  }
}

function LinkPage({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>{title}</EmptyTitle>
          {description ? <EmptyDescription>{description}</EmptyDescription> : null}
          {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
