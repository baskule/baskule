// baskule: pieces every plugin screen shares: its tile, its title lines, its skills and what Baskule
// leaves out, and, for admins adding one, who can use it.
import type { CatalogService } from "@t3tools/contracts/baskule-catalog";
import type { Group, Omission, Plugin } from "@t3tools/contracts/baskule-plugins";
import { BanIcon, ExternalLinkIcon, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import {
  CONTENTS_ICONS,
  contentsLabel,
  groupName,
  omissionText,
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

/** What a package had that Baskule leaves out: one plain sentence per reason. */
export function NotUsedList({ omitted }: { readonly omitted: ReadonlyArray<Omission> }) {
  const codes = [...new Set(omitted.map((entry) => entry.code))];
  return (
    <ul className="flex list-disc flex-col gap-1.5 ps-4 text-sm text-foreground/80">
      {codes.map((code) => (
        <li key={code}>{omissionText(code)}</li>
      ))}
    </ul>
  );
}

/** A plugin's skills, then the parts Baskule doesn't use and why. Its servers are listed with their tools. */
export function PluginContents({
  plugin,
}: {
  readonly plugin: Pick<Plugin, "skills" | "omitted">;
}) {
  const t = useTranslation();
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
      {plugin.omitted.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
            <BanIcon aria-hidden />
            {t("Not used, and why")}
          </h3>
          <div className="ps-5">
            <NotUsedList omitted={plugin.omitted} />
          </div>
        </div>
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

/** One checkbox row per group, with its size; the parent draws the frame around them. */
export function GroupChoiceRows({
  groups,
  value,
  onChange,
  disabled = false,
  rowClassName,
}: {
  readonly groups: ReadonlyArray<Group>;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
  readonly disabled?: boolean;
  readonly rowClassName?: string;
}) {
  const t = useTranslation();
  const id = useId();
  return groups.map((group) => (
    <div key={group.id} className={cn("flex items-center gap-3", rowClassName)}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <Checkbox
          aria-describedby={`${id}-${group.id}`}
          checked={value.includes(group.id)}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange(checked ? [...value, group.id] : value.filter((entry) => entry !== group.id))
          }
        />
        <span className="truncate text-sm">{groupName(group)}</span>
      </label>
      <span id={`${id}-${group.id}`} className="shrink-0 text-xs text-muted-foreground">
        {group.builtin
          ? t("Every person in your organization")
          : t("{{count}} person", {
              count: group.members.length,
              defaultValue_other: "{{count}} people",
            })}
      </span>
    </div>
  ));
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
          <div className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
            <GroupChoiceRows
              groups={groups}
              value={value}
              onChange={onChange}
              disabled={disabled}
              rowClassName="px-3 py-2"
            />
          </div>
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

/** A catalog service's plan, preview and tenant requirements, as its vendor states them. */
export function ServiceNeedsList({ service }: { readonly service: CatalogService }) {
  const t = useTranslation();
  return (
    <ul className="flex list-disc flex-col gap-1 ps-4 text-sm text-muted-foreground">
      {service.prerequisites.map((prerequisite) => (
        <li key={prerequisite}>{t(prerequisite)}</li>
      ))}
    </ul>
  );
}

export function ServiceNeeds({ service }: { readonly service: CatalogService }) {
  const t = useTranslation();
  const id = useId();
  if (service.prerequisites.length === 0) return null;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className="text-sm font-medium text-foreground">
        {t("What it needs")}
      </h3>
      <ServiceNeedsList service={service} />
    </div>
  );
}

/** The vendor's documentation of a catalog service, in a new tab. */
export function DocsLink({ service }: { readonly service: CatalogService }) {
  const t = useTranslation();
  return (
    <a
      href={service.docs}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-foreground/80 underline underline-offset-4 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"
    >
      {t("{{name}} documentation", { name: service.name })}
      <ExternalLinkIcon aria-hidden />
    </a>
  );
}
