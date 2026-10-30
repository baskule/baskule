import { useTranslation } from "../../i18n";
// baskule: pieces every plugin screen shares: its tile, its title lines and what it contains.
import type { Plugin, PluginKind } from "@t3tools/contracts/baskule-plugins";
import { BanIcon, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { credentialLabel, KIND_ICONS, kindLabel, serverHost } from "./presentation";

/** Plugins get a rounded square, people a circle: the two never read as the same thing. */
export function PluginIcon({
  kind,
  icon,
  className,
}: {
  readonly kind: PluginKind;
  readonly icon?: string | undefined;
  readonly className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const Icon = KIND_ICONS[kind];
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

/** Name and "kind · extra" under it, for list rows. */
export function PluginTitle({
  name,
  kind,
  extra,
}: {
  readonly name: string;
  readonly kind: PluginKind;
  readonly extra?: ReactNode;
}) {
  return (
    <>
      <span className="truncate text-sm text-foreground">{name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {kindLabel(kind)}
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
 * What an installed plugin brings: its skills, its connectors and the parts Baskule skips. Shown
 * when it is added (before anyone can use it) and on its page.
 */
export function PluginContents({ plugin }: { readonly plugin: Plugin }) {
  const t = useTranslation();
  const empty =
    plugin.skills.length === 0 && plugin.servers.length === 0 && plugin.ignored.length === 0;
  return (
    <div className="flex flex-col gap-4">
      {plugin.skills.length > 0 ? (
        <ContentsGroup
          icon={KIND_ICONS.skill}
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
          icon={KIND_ICONS.mcp}
          title={t("{{count}} connector", {
            count: plugin.servers.length,
            defaultValue_other: "{{count}} connectors",
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
