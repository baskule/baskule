// baskule: pieces every plugin screen shares: its tile, its title lines, what it contains and,
// for admins adding one, who can use it.
import type { Group, Plugin } from "@t3tools/contracts/baskule-plugins";
import { BanIcon, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import {
  CONTENTS_ICONS,
  contentsLabel,
  credentialLabel,
  groupName,
  serverHost,
  type PluginContentsKind,
} from "./presentation";

/** Plugins get a rounded square, people a circle: the two never read as the same thing. */
export function PluginIcon({
  contents,
  icon,
  className,
}: {
  readonly contents: PluginContentsKind;
  readonly icon?: string | undefined;
  readonly className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const Icon = CONTENTS_ICONS[contents];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-foreground/4 text-foreground/70 [&_svg]:size-4",
        className,
      )}
    >
      {icon && !broken ? (
        <img src={icon} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <Icon />
      )}
    </span>
  );
}

/** Name and "what it gives · extra" under it, for list rows. */
export function PluginTitle({
  name,
  contents,
  extra,
}: {
  readonly name: string;
  readonly contents: PluginContentsKind;
  readonly extra?: ReactNode;
}) {
  return (
    <>
      <span className="truncate text-sm text-foreground">{name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {contentsLabel(contents)}
        {extra ? <> · {extra}</> : null}
      </span>
    </>
  );
}

function ContentsGroup({
  icon: Icon,
  title,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        <Icon aria-hidden />
        {title}
      </h3>
      <ul className="flex flex-col gap-2 ps-5">{children}</ul>
    </div>
  );
}

function ContentsItem({ name, detail }: { readonly name: string; readonly detail?: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm text-foreground [overflow-wrap:anywhere]">{name}</span>
      {detail ? <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span> : null}
    </li>
  );
}

/**
 * What an installed plugin brings: its skills, the servers its tools come from and the parts
 * Baskule skips. Shown when it is added and on its page.
 */
export function PluginContents({ plugin }: { readonly plugin: Plugin }) {
  const t = useTranslation();
  const empty =
    plugin.skills.length === 0 && plugin.servers.length === 0 && plugin.ignored.length === 0;
  return (
    <div className="flex flex-col gap-4">
      {plugin.skills.length > 0 ? (
        <ContentsGroup
          icon={CONTENTS_ICONS.skills}
          title={t("{{count}} skill", {
            count: plugin.skills.length,
            defaultValue_other: "{{count}} skills",
          })}
        >
          {plugin.skills.map((skill) => (
            <ContentsItem key={skill.name} name={skill.name} detail={skill.description} />
          ))}
        </ContentsGroup>
      ) : null}
      {plugin.servers.length > 0 ? (
        <ContentsGroup
          icon={CONTENTS_ICONS.tools}
          title={t("Tools from {{count}} server", {
            count: plugin.servers.length,
            defaultValue_other: "Tools from {{count}} servers",
          })}
        >
          {plugin.servers.map((server) => (
            <ContentsItem
              key={server.name}
              name={server.name}
              detail={`${serverHost(server)} · ${credentialLabel(server.credential)}`}
            />
          ))}
        </ContentsGroup>
      ) : null}
      {plugin.ignored.length > 0 ? (
        <ContentsGroup
          icon={BanIcon}
          title={t("{{count}} part Baskule can't run", {
            count: plugin.ignored.length,
            defaultValue_other: "{{count}} parts Baskule can't run",
          })}
        >
          <li className="text-xs text-muted-foreground">
            {t(
              "Programs that would run on a computer, and parts made for other apps, are left out. The rest works without them.",
            )}
          </li>
          {plugin.ignored.map((part) => (
            <ContentsItem key={part} name={part} />
          ))}
        </ContentsGroup>
      ) : null}
      {empty ? (
        <p className="text-sm text-muted-foreground">
          {t("Nothing usable was found in this plugin.")}
        </p>
      ) : null}
    </div>
  );
}

/** Everyone is preselected; the admin may choose other groups, or none. */
export function useGroupChoice(groups: ReadonlyArray<Group> | null | undefined) {
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(null);
  const value =
    picked ??
    groups?.filter((group) => group.builtin === "everyone").map((group) => group.id) ??
    [];
  return { value, onChange: setPicked, reset: () => setPicked(null) };
}

/** Who can use a plugin from the moment it is added. */
export function PluginGroupsField({
  groups,
  error,
  value,
  onChange,
  disabled = false,
}: {
  readonly groups: ReadonlyArray<Group> | null | undefined;
  readonly error?: string | null | undefined;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
  readonly disabled?: boolean;
}) {
  const t = useTranslation();
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <Label id={labelId} render={<span />}>
        {t("Who can use it")}
      </Label>
      {groups ? (
        <>
          <ul className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
            {groups.map((group) => (
              <li key={group.id} className="flex items-center gap-3 px-3 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <Checkbox
                    aria-describedby={`${labelId}-${group.id}`}
                    checked={value.includes(group.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...value, group.id]
                          : value.filter((entry) => entry !== group.id),
                      )
                    }
                  />
                  <span className="truncate text-sm">{groupName(group)}</span>
                </label>
                <span
                  id={`${labelId}-${group.id}`}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {group.builtin
                    ? t("Every person in your organization")
                    : t("{{count}} person", {
                        count: group.members.length,
                        defaultValue_other: "{{count}} people",
                      })}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {value.length === 0
              ? t("No one can use it until you choose a group on its page.")
              : t("People in these groups get it as soon as it is added.")}
          </p>
        </>
      ) : error ? (
        <p className="text-xs text-destructive-foreground">{error}</p>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          {t("Loading groups…")}
        </p>
      )}
    </div>
  );
}
