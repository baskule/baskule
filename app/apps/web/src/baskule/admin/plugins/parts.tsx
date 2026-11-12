// baskule: the pieces of a plugin's page, before and after it is added: its header, who can use
// it, its apps with their inline setup, and its skills.
import type { Group } from "@t3tools/contracts/baskule";
import type {
  PluginAccess,
  PluginVariable,
  ServerAuth,
  ServerSetup,
  SkippedKind,
} from "@t3tools/contracts/baskule-plugins";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, FileTextIcon, PlugIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import { Switch } from "../../../components/ui/switch";
import { useTranslation } from "../../../i18n";
import { PluginLogo } from "../../plugins/PluginLogo";
import { authText, setupText, skippedText } from "../../plugins/presentation";
import { FormField } from "../../ui";
import { PageSection } from "../../views/BaskulePage";
import { groupName } from "../people/groups";

export function PluginHeader({
  name,
  logo,
  site,
  sourceHref,
  description,
  status,
  actions,
  leading,
}: {
  readonly name: string;
  readonly logo: string | null;
  readonly site: string | null;
  readonly sourceHref: string | null;
  readonly description: string;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly leading?: ReactNode;
}) {
  const t = useTranslation();
  return (
    <div className="flex flex-col gap-4 px-3 sm:px-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-4">
          {leading}
          <PluginLogo name={name} logo={logo} site={site} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-xl font-semibold text-foreground">{name}</h1>
              {status}
            </div>
            {sourceHref ? (
              <a
                href={sourceHref}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {t("View source")}
                <ArrowUpRightIcon aria-hidden className="size-3.5" />
              </a>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 sm:pt-2">{actions}</div> : null}
      </div>
      {description ? (
        <p className="max-w-prose text-base leading-6 text-muted-foreground sm:text-sm">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { readonly status: "ready" | "needs_setup" | "paused" }) {
  const t = useTranslation();
  switch (status) {
    case "ready":
      return <Badge variant="success">{t("Ready")}</Badge>;
    case "needs_setup":
      return <Badge variant="warning">{t("Needs setup")}</Badge>;
    case "paused":
      return <Badge variant="secondary">{t("Paused")}</Badge>;
  }
}

export function accessSummary(
  access: PluginAccess,
  groups: ReadonlyArray<Group> | null,
  t: ReturnType<typeof useTranslation>,
): string {
  if (access.kind === "everyone") return t("Everyone");
  if (access.groups.length === 0) return t("No one yet");
  return access.groups
    .map((id) => {
      const group = groups?.find((entry) => entry.id === id);
      return group ? groupName(group) : t("Removed group");
    })
    .join(", ");
}

/** Everyone, or only the people in the groups the admin ticks. */
export function AccessSection({
  value,
  groups,
  disabled = false,
  busy = false,
  onChange,
}: {
  readonly value: PluginAccess;
  readonly groups: ReadonlyArray<Group> | null;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onChange: (access: PluginAccess) => void;
}) {
  const t = useTranslation();
  const own = groups?.filter((group) => !group.builtin) ?? [];
  const chosen = value.kind === "groups" ? value.groups : [];
  return (
    <PageSection
      title={t("Who can use it")}
      description={t("People switch it on or off for themselves in Settings → Plugins.")}
    >
      <div className="px-3 py-3.5 sm:px-4">
        <RadioGroup
          aria-label={t("Who can use it")}
          aria-busy={busy || undefined}
          value={value.kind}
          disabled={disabled}
          onValueChange={(kind) =>
            onChange(
              kind === "everyone" ? { kind: "everyone" } : { kind: "groups", groups: chosen },
            )
          }
        >
          <label className="flex cursor-pointer items-center gap-3">
            <Radio value="everyone" />
            <span className="text-sm text-foreground">{t("Everyone in your organization")}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-3">
            <Radio value="groups" />
            <span className="text-sm text-foreground">{t("Only people in some groups")}</span>
          </label>
        </RadioGroup>
        {value.kind === "groups" ? (
          own.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2.5 ps-7.5 sm:ps-7">
              {own.map((group) => (
                <label key={group.id} className="flex cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={chosen.includes(group.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange({
                        kind: "groups",
                        groups: checked
                          ? [...chosen, group.id]
                          : chosen.filter((entry) => entry !== group.id),
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{groupName(group)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("{{count}} person", {
                      count: group.members.length,
                      defaultValue_other: "{{count}} people",
                    })}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-3 ps-7.5 text-xs text-muted-foreground sm:ps-7">
              {t("You have no groups yet.")}{" "}
              <Link
                to="/admin/$section/$page"
                params={{ section: "people", page: "groups" }}
                className="text-foreground underline underline-offset-4"
              >
                {t("Create one in People → Groups")}
              </Link>
            </p>
          )
        ) : null}
      </div>
    </PageSection>
  );
}

export interface ServerView {
  readonly key: string;
  readonly name: string;
  readonly url: string;
  readonly auth: ServerAuth;
  readonly setup: ServerSetup;
  readonly connectedMembers?: number;
  /** Inline setup under the server, when it needs any. */
  readonly children?: ReactNode;
  /** Before install: whether the plugin keeps this server. */
  readonly include?: {
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
  };
}

export function AppsSection({ servers }: { readonly servers: ReadonlyArray<ServerView> }) {
  const t = useTranslation();
  if (servers.length === 0) return null;
  const choosing = servers.some((server) => server.include);
  return (
    <PageSection
      title={t("Apps ({{count}})", { count: servers.length })}
      description={
        choosing
          ? t(
              "The services the assistant connects to, with what each needs. Turn off the ones your team doesn't use.",
            )
          : t("The services the assistant connects to, with what each needs.")
      }
    >
      {servers.map((server) => (
        <div
          key={server.key}
          role="group"
          aria-label={server.name}
          className="flex flex-col gap-3 px-3 py-3 sm:px-4"
        >
          <div className="flex items-start gap-3">
            <PlugIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="max-w-full truncate text-sm font-medium text-foreground">
                  {server.name}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {server.include?.checked === false ? null : (
                    <Badge
                      variant={server.setup.state === "ready" ? "success" : "warning"}
                      className="shrink-0"
                    >
                      {setupText(server.setup)}
                    </Badge>
                  )}
                  {server.include ? (
                    <Switch
                      aria-label={t("Keep {{name}}", { name: server.name })}
                      checked={server.include.checked}
                      onCheckedChange={server.include.onChange}
                    />
                  ) : null}
                </span>
              </div>
              <span className="truncate font-mono text-xs text-muted-foreground">{server.url}</span>
              <span className="text-xs text-muted-foreground">
                {authText(server.auth)}
                {server.connectedMembers ? (
                  <>
                    {" · "}
                    {t("{{count}} person signed in", {
                      count: server.connectedMembers,
                      defaultValue_other: "{{count}} people signed in",
                    })}
                  </>
                ) : null}
              </span>
            </div>
          </div>
          {server.children && server.include?.checked !== false ? (
            <div className="sm:ps-7">{server.children}</div>
          ) : null}
        </div>
      ))}
    </PageSection>
  );
}

const SKILLS_SHOWN = 5;

export function SkillsSection({
  skills,
}: {
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly files?: number;
  }>;
}) {
  const t = useTranslation();
  const [all, setAll] = useState(false);
  if (skills.length === 0) return null;
  const shown = all ? skills : skills.slice(0, SKILLS_SHOWN);
  return (
    <PageSection
      title={t("Skills ({{count}})", { count: skills.length })}
      description={t("Instructions the assistant reads when a task calls for them.")}
    >
      {shown.map((skill) => (
        <div key={skill.name} className="flex items-start gap-3 px-3 py-3 sm:px-4">
          <FileTextIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
            {skill.description ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {skill.description}
              </span>
            ) : null}
          </div>
          {skill.files && skill.files > 1 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("{{count}} file", {
                count: skill.files,
                defaultValue_other: "{{count}} files",
              })}
            </span>
          ) : null}
        </div>
      ))}
      {skills.length > shown.length ? (
        <div className="flex justify-end px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t("{{count}} more", { count: skills.length - shown.length })}
          </Button>
        </div>
      ) : null}
    </PageSection>
  );
}

export function NotAdded({
  skipped,
}: {
  readonly skipped: ReadonlyArray<{
    readonly kind: SkippedKind;
    readonly subject: string;
  }>;
}) {
  const t = useTranslation();
  if (skipped.length === 0) return null;
  return (
    <p className="px-3 text-xs text-muted-foreground sm:px-4">
      {t("Not added: {{parts}}", {
        parts: skipped
          .map((part) =>
            t("{{subject}}, {{reason}}", {
              subject: part.subject,
              reason: skippedText(part.kind),
            }),
          )
          .join("; "),
      })}
    </p>
  );
}

/** One field per `${NAME}` placeholder. Saved values stay hidden; typing replaces them. */
export function VariableFields({
  variables,
  values,
  onChange,
}: {
  readonly variables: ReadonlyArray<PluginVariable & { readonly set?: boolean }>;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (name: string, value: string) => void;
}) {
  const t = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {variables.map((variable) => (
        <FormField
          key={variable.name}
          label={variable.name}
          type={variable.secret ? "password" : "text"}
          autoComplete={variable.secret ? "new-password" : "off"}
          spellCheck={false}
          font="mono"
          placeholder={variable.set ? t("Saved. Leave empty to keep it.") : ""}
          hint={variable.description}
          value={values[variable.name] ?? ""}
          onChange={(event) => onChange(variable.name, event.currentTarget.value)}
        />
      ))}
    </div>
  );
}
