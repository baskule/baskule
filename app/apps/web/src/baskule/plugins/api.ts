import type {
  Group,
  GroupInput,
  Plugin,
  PluginInstallInput,
  PluginKind,
  PluginPatch,
  PluginSearchResponse,
  PluginSecretInput,
  SpacePluginSettings,
  UserPlugin,
} from "@t3tools/contracts/baskule-plugins";
import { toastManager } from "../../components/ui/toast";
import { t } from "../../i18n";
import { BaskuleApiError, request } from "../api";
import { errorText } from "../ui";

const root = "/api/baskule";
const enc = encodeURIComponent;
export const pluginsApi = {
  search: (q: string, kind?: PluginKind) =>
    request<PluginSearchResponse>(
      "GET",
      `${root}/admin/plugins/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}) })}`,
    ),
  installed: async () =>
    (await request<{ plugins: Plugin[] }>("GET", `${root}/admin/plugins`)).plugins,
  install: (input: PluginInstallInput) => request<Plugin>("POST", `${root}/admin/plugins`, input),
  update: (id: string, input: PluginPatch) =>
    request<Plugin>("PATCH", `${root}/admin/plugins/${enc(id)}`, input),
  remove: (id: string) => request<{ ok: true }>("DELETE", `${root}/admin/plugins/${enc(id)}`),
  secret: (id: string, input: PluginSecretInput) =>
    request<{ ok: true }>("PUT", `${root}/admin/plugins/${enc(id)}/secret`, input),
  mine: async () => (await request<{ plugins: UserPlugin[] }>("GET", `${root}/plugins`)).plugins,
  enable: (id: string, enabled: boolean) =>
    request<{ enabled: boolean }>("PUT", `${root}/plugins/${enc(id)}/enabled`, { enabled }),
  disconnect: (id: string, server: string) =>
    request<{ ok: true }>(
      "DELETE",
      `${root}/plugins/${enc(id)}/connection?server=${encodeURIComponent(server)}`,
    ),
  space: (id: string) => request<SpacePluginSettings>("GET", `${root}/spaces/${enc(id)}/plugins`),
  saveSpace: (id: string, settings: SpacePluginSettings) =>
    request<SpacePluginSettings>("PUT", `${root}/spaces/${enc(id)}/plugins`, settings),
  groups: async () => (await request<{ groups: Group[] }>("GET", `${root}/admin/groups`)).groups,
  group: (id: string) => request<Group>("GET", `${root}/admin/groups/${enc(id)}`),
  createGroup: (input: GroupInput) => request<Group>("POST", `${root}/admin/groups`, input),
  updateGroup: (id: string, input: Partial<GroupInput>) =>
    request<Group>("PATCH", `${root}/admin/groups/${enc(id)}`, input),
  removeGroup: (id: string) => request<{ ok: true }>("DELETE", `${root}/admin/groups/${enc(id)}`),
};

/**
 * Where the browser goes to connect one server of a plugin to the person's account. The endpoint
 * starts the sign-in and redirects; the person comes back to `returnTo` with `pluginConnection`.
 * Navigate to it: fetching it first would start a second sign-in.
 */
export function accountConnectionUrl(id: string, server: string, returnTo: string): string {
  const query = new URLSearchParams({ server, returnTo });
  return `${root}/plugins/${enc(id)}/connect?${query}`;
}

const PLUGIN_ERRORS: Readonly<Record<string, () => string>> = {
  invalid_mcp_url: () =>
    t(
      "Use the full address of the connector, like https://mcp.example.com/mcp, without a password in it.",
    ),
  no_remote_servers: () =>
    t("This connector only runs as a local program, which Baskule can't run."),
  invalid_commit: () => t("Enter the full commit ID: 40 letters and digits."),
  unsupported_git_host: () =>
    t("Only public GitHub repositories can be added by address. Upload the files instead."),
  unsupported_marketplace_source: () =>
    t("This plugin has no fixed version to install. Add it from its git repository instead."),
  archive_hash_mismatch: () => t("The file changed while it was being sent. Try again."),
  invalid_archive: () => t("This file can't be opened. Use a .zip or .tar.gz file."),
  unsupported_archive: () => t("This file can't be opened. Use a .zip or .tar.gz file."),
  empty_plugin: () => t("No skill or connector was found in it."),
  empty_plugin_archive: () => t("No skill or connector was found in it."),
  proprietary_plugin: () => t("Its license doesn't allow using it here."),
  plugin_too_large: () => t("It is too large to add (10 MB packed, 20 MB unpacked at most)."),
  plugin_tree_too_large: () => t("It is too large to add (10 MB packed, 20 MB unpacked at most)."),
  too_many_plugin_files: () => t("It has too many files to add."),
  plugin_storage_limit: () =>
    t("There is no room for more plugins. Remove one you don't use first."),
  plugin_source_unavailable: () => t("Its source didn't answer. Try again in a moment."),
  plugin_source_changed: () => t("Its source changed while it was being read. Try again."),
  registry_plugin_not_found: () => t("This plugin is no longer listed. Search again."),
  invalid_secret_headers: () => t("This key can't be sent with that header name."),
  group_exists: () => t("A group with this name already exists."),
  builtin_group: () => t("Everyone always includes every person, and keeps its name."),
};

/** The backend's error codes for plugins and groups, in plain words. */
export function pluginErrorText(cause: unknown, fallback: string): string {
  const message =
    cause instanceof BaskuleApiError && cause.code ? PLUGIN_ERRORS[cause.code] : undefined;
  return message ? message() : errorText(cause, fallback);
}

export function notifyPluginError(title: string, cause: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: pluginErrorText(cause, t("Something went wrong.")),
  });
}
