// baskule: the sections of the person's Settings modal, in nav order. The settings route, its nav
// and each page's heading all read this list. T3's own settings pages stay unreachable.
import {
  AlarmClockIcon,
  ArchiveIcon,
  BlocksIcon,
  ChartNoAxesColumnIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MonitorDownIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { msg } from "../i18n";
import type { BaskuleMe } from "./api";
import { BASKULE_HOSTED } from "./flags";

export type BaskuleSettingsPath =
  | "/settings/scheduled-tasks"
  | "/settings/usage"
  | "/settings/plugins"
  | "/settings/spaces"
  | "/settings/desktop"
  | "/settings/password"
  | "/settings/general"
  | "/settings/archived";

export interface BaskuleSettingsSection {
  readonly path: BaskuleSettingsPath;
  /** English source; translate with `t(...)` where it is shown. */
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Needs the hosted multi-user build. */
  readonly hosted?: boolean;
  /** Listed only for people it applies to; the page itself still opens. */
  readonly listed?: (me: BaskuleMe) => boolean;
}

const SECTIONS: ReadonlyArray<BaskuleSettingsSection> = [
  {
    path: "/settings/scheduled-tasks",
    label: msg("Scheduled tasks"),
    description: msg("Chats that start on a schedule or when a webhook calls them."),
    icon: AlarmClockIcon,
    hosted: true,
  },
  {
    path: "/settings/usage",
    label: msg("Usage"),
    description: msg("What you used in the last 90 days, and the limits that apply to you."),
    icon: ChartNoAxesColumnIcon,
    hosted: true,
  },
  {
    path: "/settings/plugins",
    label: msg("Plugins"),
    description: msg("The plugins you can use, and the accounts you connect to them."),
    icon: BlocksIcon,
    hosted: true,
  },
  {
    path: "/settings/spaces",
    label: msg("Spaces"),
    description: msg("The spaces you belong to. Owners manage their members here."),
    icon: UsersIcon,
    hosted: true,
    listed: (me) =>
      me.canCreateSpaces ||
      me.user.role === "admin" ||
      me.spaces.some((space) => space.kind === "team" && space.role === "owner"),
  },
  {
    path: "/settings/desktop",
    label: msg("Desktop app"),
    description: msg("Download the apps, and connect a computer or phone to this installation."),
    icon: MonitorDownIcon,
    hosted: true,
  },
  {
    path: "/settings/password",
    label: msg("Change password"),
    description: msg("Your other devices will be signed out."),
    icon: KeyRoundIcon,
    hosted: true,
    listed: (me) => me.authentication.password,
  },
  {
    path: "/settings/general",
    label: msg("Language & appearance"),
    description: msg("The language and theme Baskule uses on this device."),
    icon: LanguagesIcon,
  },
  {
    path: "/settings/archived",
    label: msg("Archived chats"),
    description: msg("Chats you archived. Unarchive one to bring it back to the sidebar."),
    icon: ArchiveIcon,
  },
];

const AVAILABLE = SECTIONS.filter((section) => BASKULE_HOSTED || !section.hosted);

export function isBaskuleSettingsPage(pathname: string): boolean {
  return AVAILABLE.some((section) => section.path === pathname);
}

/** Baskule's own pages, outside T3's settings scopes (environment, project). */
export function isBaskuleOwnSettingsPage(pathname: string): boolean {
  return (
    isBaskuleSettingsPage(pathname) &&
    pathname !== "/settings/scheduled-tasks" &&
    pathname !== "/settings/archived"
  );
}

export function baskuleSettingsSection(pathname: string): BaskuleSettingsSection | null {
  return AVAILABLE.find((section) => section.path === pathname) ?? null;
}

/** The nav's rows; before the session loads, every row that needs no session. */
export function baskuleSettingsSections(
  me: BaskuleMe | null,
): ReadonlyArray<BaskuleSettingsSection> {
  return AVAILABLE.filter((section) => (section.listed ? me !== null && section.listed(me) : true));
}

export function firstBaskuleSettingsPath(): BaskuleSettingsPath {
  return AVAILABLE[0]!.path;
}
