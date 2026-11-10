import { useTranslation } from "../../i18n";

import { baskule } from "../../baskule/flags";
import { matchComposerThreadItems } from "@t3tools/client-runtime/composerThreadItems";
import { useState } from "react";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

import type { ComposerTrigger } from "../../composer-logic";
import { basenameOfPath } from "../../pierre-icons";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useVisibleThreadShells } from "~/state/entities";

import { useComposerPathSearch, useThreadSearch } from "~/state/queries";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

/** Builds the @, /, $ and # suggestion lists, running the searches each trigger needs. */
export function useComposerMenuItems({
  composerTrigger,
  environmentId,
  gitCwd,
  activeThreadId,
  sideChatAvailable,
  sideChatDisabledReason,
  freshSessionAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  workspaceSkillsScanning,
  modelMentions,
}: {
  readonly composerTrigger: ComposerTrigger | null;
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly freshSessionAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly workspaceSkillsScanning: boolean;
  readonly modelMentions: {
    readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
    readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  };
}) {
  const t = useTranslation();
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const environmentThreadShells = useVisibleThreadShells(isPathTrigger);
  // Mounts older settled threads matching the mention, which shells may leave out.
  useThreadSearch(isPathTrigger ? [environmentId] : [], pathTriggerQuery, { titlesOnly: true });
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const items = ((): ComposerCommandItem[] => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return [
        ...matchComposerThreadItems({
          shells: environmentThreadShells,
          environmentId,
          excludeThreadId: activeThreadId,
          query: composerTrigger.query,
          now,
        }),
        ...matchComposerModelItems({
          instanceEntries: modelMentions.instanceEntries,
          modelOptionsByInstance: modelMentions.modelOptionsByInstance,
          query: composerTrigger.query,
        }),
        ...workspaceEntries.entries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          pathKind: entry.kind,
          searchTarget: workspaceEntries.searchedTarget,
          label: basenameOfPath(entry.path),
          description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
        })),
      ];
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        // baskule: no /model; the composer has no model picker and the installation sets one model.
        ...(baskule.plainChat
          ? []
          : ([
              {
                id: "slash:model",
                type: "slash-command",
                command: "model",
                label: "/model",
                description: t("Switch response model for this thread"),
              },
            ] as const)),
        ...(sideChatAvailable
          ? ([
              {
                id: "slash:side",
                type: "slash-command",
                command: "side",
                label: "/side",
                description: sideChatDisabledReason ?? t("Ask a side question in a new side chat"),
              },
              {
                id: "slash:btw",
                type: "slash-command",
                command: "btw",
                label: "/btw",
                description: sideChatDisabledReason ?? t("Same as /side"),
              },
            ] as const)
          : []),
        ...(freshSessionAvailable
          ? ([
              {
                id: "slash:clear",
                type: "slash-command",
                command: "clear",
                label: "/clear",
                description: "Start a fresh session; earlier messages stay visible",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? t("Run provider command"),
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? t("{{scope}} skill", { scope: skill.scope }) : ""),
      }));
      // T3's `/clear` replaces the provider's, which would clear a session T3 still treats as live.
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...providerSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? t("{{scope}} skill", { scope: skill.scope }) : t("Run provider skill")),
      }));
    }
    return [];
  })();
  const isLoading =
    (composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    ((composerTriggerKind === "skill" || composerTriggerKind === "slash-command") &&
      workspaceSkillsScanning);
  const emptyState = (() => {
    if (composerTriggerKind === "skill") {
      return t("No skills found. Try / to browse provider commands.");
    }
    return composerTriggerKind === "path"
      ? t("No matching files or folders.")
      : t("No matching command.");
  })();

  return { items, isLoading, emptyState };
}
