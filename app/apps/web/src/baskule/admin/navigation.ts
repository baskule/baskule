// baskule: the admin area's sections and pages. One entry per page; the sidebar, the phone section
// list and the `/admin/$section/$page` route all read this list.
import {
  ActivityIcon,
  BlocksIcon,
  Building2Icon,
  CircleUserRoundIcon,
  ChartNoAxesColumnIcon,
  KeyRoundIcon,
  MailIcon,
  MicIcon,
  PackageCheckIcon,
  PackagePlusIcon,
  SparklesIcon,
  UserIcon,
  UsersIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import { msg } from "../../i18n";
import type { BaskuleMe } from "../api";

export interface AdminPage {
  readonly id: string;
  /** English source; translate with `t(...)` where it is shown. */
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Missing while the page is still being built this release: the shell shows a placeholder. */
  readonly component?: LazyExoticComponent<ComponentType>;
  /** One item of the page's list, at `/admin/$section/$page/$item`. */
  readonly detail?: LazyExoticComponent<ComponentType<{ readonly id: string }>>;
}

export interface AdminSection {
  readonly id: string;
  readonly label: string;
  readonly pages: ReadonlyArray<AdminPage>;
  /** Anonymous installations have no accounts, so no section about them. */
  readonly needsAccounts?: boolean;
}

const page = <Name extends string>(load: () => Promise<Record<Name, ComponentType>>, name: Name) =>
  lazy(() => load().then((module) => ({ default: module[name] })));
const detail = <Name extends string>(
  load: () => Promise<Record<Name, ComponentType<{ readonly id: string }>>>,
  name: Name,
) => lazy(() => load().then((module) => ({ default: module[name] })));

export const ADMIN_SECTIONS: ReadonlyArray<AdminSection> = [
  {
    id: "general",
    label: msg("General"),
    pages: [
      {
        id: "overview",
        label: msg("Overview"),
        description: msg("How your spaces and their computers are doing right now."),
        icon: ActivityIcon,
        component: page(() => import("./general/OverviewPage"), "OverviewPage"),
      },
      {
        id: "organization",
        label: msg("Organization"),
        description: msg("Your organization's name and how long idle computers keep running."),
        icon: Building2Icon,
        component: page(() => import("./general/OrganizationPage"), "OrganizationPage"),
      },
      {
        id: "authentication",
        label: msg("Authentication"),
        description: msg("How people sign in to Baskule."),
        icon: KeyRoundIcon,
        component: page(() => import("./general/AuthenticationPage"), "AuthenticationPage"),
      },
    ],
  },
  {
    id: "people",
    label: msg("People"),
    needsAccounts: true,
    pages: [
      {
        id: "users",
        label: msg("Users"),
        description: msg("Everyone who can sign in. Each person has a private personal space."),
        icon: CircleUserRoundIcon,
        component: page(() => import("./people/UsersPage"), "UsersPage"),
      },
      {
        id: "invitations",
        label: msg("Invitations"),
        description: msg("Invitation links that have not been used yet."),
        icon: MailIcon,
        component: page(() => import("./people/InvitationsPage"), "InvitationsPage"),
      },
      {
        id: "groups",
        label: msg("Groups"),
        description: msg("Give several people the same plugins and permissions at once."),
        icon: UsersRoundIcon,
        component: page(() => import("./people/GroupsPage"), "GroupsPage"),
        detail: detail(() => import("./people/GroupDetailPage"), "GroupDetailPage"),
      },
    ],
  },
  {
    id: "spaces",
    label: msg("Spaces"),
    pages: [
      {
        id: "team",
        label: msg("Team spaces"),
        description: msg("Shared by their members: chats, files and one computer per space."),
        icon: UsersIcon,
        component: page(() => import("./spaces/TeamSpacesPage"), "TeamSpacesPage"),
      },
      {
        id: "personal",
        label: msg("Personal spaces"),
        description: msg("Private to their person. You can't open them; you can only delete them."),
        icon: UserIcon,
        component: page(() => import("./spaces/PersonalSpacesPage"), "PersonalSpacesPage"),
      },
    ],
  },
  {
    id: "ai",
    label: msg("AI"),
    pages: [
      {
        id: "models",
        label: msg("Models"),
        description: msg("The AI provider and model everyone in your organization uses."),
        icon: SparklesIcon,
        component: page(() => import("./ai/ModelsPage"), "ModelsPage"),
      },
      {
        id: "voice",
        label: msg("Voice input"),
        description: msg("Let people dictate messages, and choose the speech-to-text model."),
        icon: MicIcon,
        component: page(() => import("./ai/VoiceInputPage"), "VoiceInputPage"),
      },
      {
        id: "usage",
        label: msg("Usage & limits"),
        description: msg("What each person uses, and the limits you set for everyone."),
        icon: ChartNoAxesColumnIcon,
        component: page(() => import("./ai/UsageLimitsPage"), "UsageLimitsPage"),
      },
    ],
  },
  {
    id: "plugins",
    label: msg("Plugins"),
    pages: [
      {
        id: "catalog",
        label: msg("Catalog"),
        description: msg("Plugins for the services your organization uses, ready to add."),
        icon: BlocksIcon,
        component: page(() => import("./plugins/CatalogPage"), "CatalogPage"),
      },
      {
        id: "installed",
        label: msg("Installed"),
        description: msg("The plugins you added, who can use them, and their settings."),
        icon: PackageCheckIcon,
        component: page(() => import("./plugins/InstalledPage"), "InstalledPage"),
        detail: detail(() => import("./plugins/PluginDetailPage"), "PluginDetailPage"),
      },
      {
        id: "add",
        label: msg("Add your own"),
        description: msg("Upload a plugin, add an MCP server, or write a skill."),
        icon: PackagePlusIcon,
        component: page(() => import("./plugins/AddOwnPage"), "AddOwnPage"),
      },
    ],
  },
];

export function adminSections(me: BaskuleMe | null): ReadonlyArray<AdminSection> {
  return me?.authentication.mode === "anonymous"
    ? ADMIN_SECTIONS.filter((section) => !section.needsAccounts)
    : ADMIN_SECTIONS;
}

export function findAdminPage(
  me: BaskuleMe | null,
  sectionId: string,
  pageId: string,
): { readonly section: AdminSection; readonly page: AdminPage } | null {
  const section = adminSections(me).find((entry) => entry.id === sectionId);
  const found = section?.pages.find((entry) => entry.id === pageId);
  return section && found ? { section, page: found } : null;
}
