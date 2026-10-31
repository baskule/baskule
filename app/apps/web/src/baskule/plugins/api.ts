import {
  PLUGIN_ERROR_CODES,
  type AdminPlugin,
  type Group,
  type GroupInput,
  type MemberPlugin,
  type Plugin,
  type PluginErrorCode,
  type PluginInstallInput,
  type PluginPatch,
  type PluginSearchResponse,
  type PluginSearchResult,
  type PluginSecretInput,
  type SpacePluginSettings,
} from "@t3tools/contracts/baskule-plugins";
import { toastManager } from "../../components/ui/toast";
import { t } from "../../i18n";
import { BaskuleApiError, request } from "../api";

const root = "/api/baskule";
const enc = encodeURIComponent;

/** One vendor's OAuth client. Write-only: the server only says whether one is saved. */
export interface VendorClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export const pluginsApi = {
  search: (q: string, kind?: PluginSearchResult["kind"]) =>
    request<PluginSearchResponse>(
      "GET",
      `${root}/admin/plugins/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}) })}`,
    ),
  installed: async () =>
    (await request<{ plugins: AdminPlugin[] }>("GET", `${root}/admin/plugins`)).plugins,
  install: (input: PluginInstallInput) => request<Plugin>("POST", `${root}/admin/plugins`, input),
  update: (id: string, input: PluginPatch) =>
    request<Plugin>("PATCH", `${root}/admin/plugins/${enc(id)}`, input),
  remove: (id: string) => request<{ ok: true }>("DELETE", `${root}/admin/plugins/${enc(id)}`),
  secret: (id: string, input: PluginSecretInput) =>
    request<{ ok: true }>("PUT", `${root}/admin/plugins/${enc(id)}/secret`, input),
  vendorSetup: (vendor: string, client: VendorClient | null) =>
    request<{ ok: true; configured: boolean }>(
      "PUT",
      `${root}/admin/vendors/${enc(vendor)}`,
      client,
    ),
  mine: async () => (await request<{ plugins: MemberPlugin[] }>("GET", `${root}/plugins`)).plugins,
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

const tooLarge = () => t("It is too large to add (10 MB packed, 20 MB unpacked at most).");
const cantOpen = () => t("This file can't be opened. Use a .zip or .tar.gz file.");

const PLUGIN_ERRORS: Record<PluginErrorCode, () => string> = {
  address_not_allowed: () =>
    t(
      "Baskule can't use this address. Enter the full https:// address of the server, without a password or placeholder in it.",
    ),
  archive_hash_mismatch: () => t("The file changed while it was being sent. Try again."),
  archive_required: () => t("Choose the file to upload."),
  builtin_group: () => t("Everyone always includes every person, and keeps its name."),
  connection_failed: () =>
    t("The sign-in didn't finish. Try again. If it keeps failing, ask your admin."),
  connection_not_allowed: () =>
    t("The plugin changed or was paused in the meantime. Reload the page and try again."),
  consent_denied: () => t("The sign-in was cancelled or permission was not granted."),
  duplicate_plugin_path: () => t("It contains the same file twice."),
  duplicate_skill_name: () => t("Two of its skills have the same name."),
  empty_plugin: () => t("No skills or tools were found in it."),
  empty_plugin_archive: () => t("This file is empty."),
  forbidden: () => t("You don't have permission to do this."),
  group_exists: () => t("A group with this name already exists."),
  invalid_archive: cantOpen,
  invalid_authorization_metadata: () =>
    t("This service's sign-in is set up in a way Baskule can't use. Ask your admin."),
  invalid_commit: () => t("Enter the full commit ID: 40 letters and digits."),
  invalid_group: () => t("One of these groups no longer exists. Reload the page and try again."),
  invalid_json: () => t("Baskule couldn't read what was sent. Reload the page and try again."),
  invalid_oauth_client: () => t("Check the client ID and secret, then try again."),
  invalid_oauth_code: () => t("The service refused the sign-in. Try again."),
  invalid_oauth_resource: () =>
    t("This server's address can't be used to sign in. Remove the part from “?” onwards."),
  invalid_oauth_state: () =>
    t(
      "This sign-in expired or was started in another browser. Start again from Settings → Plugins.",
    ),
  invalid_oauth_token: () =>
    t("The service answered the sign-in in a way Baskule can't use. Try again."),
  invalid_plugin_input: () => t("Some details aren't valid. Check them and try again."),
  invalid_plugin_manifest: () => t("Its plugin.json file can't be read."),
  invalid_resource_metadata: () =>
    t("This server's sign-in details can't be used. Ask the people who make it."),
  invalid_return_url: () =>
    t("The sign-in couldn't come back to Baskule. Start again from Settings → Plugins."),
  invalid_secret_headers: () => t("This key can't be sent with that header name."),
  no_remote_servers: () =>
    t(
      "This server runs as a program on someone's computer. Baskule needs its web address; ask its maker whether it has one.",
    ),
  not_found: () => t("It no longer exists. Reload the page."),
  not_oauth_server: () => t("This server doesn't use each person's own account."),
  not_organization_server: () => t("This server doesn't use an organization key."),
  oauth_client_configuration_required: () => t("Your administrator needs to finish setting it up"),
  oauth_grant_expired: () => t("Your sign-in expired. Reconnect your account."),
  oauth_issuer_changed: () =>
    t(
      "This service now signs in somewhere other than where it was set up. Ask your admin to check its setup and save it again.",
    ),
  oauth_issuer_mismatch: () =>
    t("The sign-in came back from another service than expected. Try again."),
  oauth_registration_failed: () =>
    t("The service didn't accept Baskule's sign-in. Ask your admin."),
  oauth_resource_mismatch: () =>
    t("This service's sign-in is for another address. Ask your admin."),
  oauth_scope_missing: () =>
    t(
      "The sign-in didn't give the access this plugin needs. Try again and allow everything it asks.",
    ),
  oauth_unavailable: () => t("The service's sign-in didn't answer. Try again in a moment."),
  plugin_links_unsupported: () =>
    t("It contains links to other files. Put the files themselves in it instead."),
  plugin_not_found: () =>
    t("One of these plugins no longer exists. Reload the page and try again."),
  plugin_server_required: () => t("Choose which of its servers to connect."),
  plugin_skill_file_too_large: () => t("One of its skill files is too large."),
  plugin_source_changed: () => t("Its source changed while it was being read. Try again."),
  plugin_source_unavailable: () => t("Its source didn't answer. Try again in a moment."),
  plugin_storage_limit: () =>
    t("There is no room for more plugins. Remove one you don't use first."),
  plugin_too_large: tooLarge,
  plugin_tree_too_large: tooLarge,
  proprietary_plugin: () => t("Its license doesn't allow using it here."),
  registry_plugin_not_found: () => t("This plugin is no longer listed. Search again."),
  too_many_plugin_files: () => t("It has too many files to add."),
  unknown_plugin_server: () =>
    t("One of its servers no longer exists. Reload the page and try again."),
  unknown_registry: () => t("This catalog is no longer available. Reload the page."),
  unsafe_plugin_path: () => t("It contains a file path Baskule can't accept."),
  unsupported_archive: cantOpen,
  unsupported_git_host: () =>
    t("Only public GitHub repositories can be added by address. Upload the files instead."),
  unsupported_marketplace_source: () =>
    t("This plugin has no fixed version to install. Add it from its git repository instead."),
  unsupported_plugin_version: () => t("It uses a plugin format version Baskule can't read yet."),
  user_not_found: () => t("One of these people no longer exists. Reload the page and try again."),
  vendor_unknown: () => t("Baskule no longer knows this service. Reload the page and try again."),
};

const isPluginErrorCode = (code: string): code is PluginErrorCode =>
  (PLUGIN_ERROR_CODES as ReadonlyArray<string>).includes(code);

/** A plugin error code in plain words. Anything else gets `fallback`, never the raw code. */
export function pluginErrorCodeText(code: string | null | undefined, fallback: string): string {
  return code && isPluginErrorCode(code) ? PLUGIN_ERRORS[code]() : fallback;
}

/** The backend's error codes for plugins and groups, in plain words. */
export function pluginErrorText(cause: unknown, fallback: string): string {
  return pluginErrorCodeText(cause instanceof BaskuleApiError ? cause.code : undefined, fallback);
}

export function notifyPluginError(title: string, cause: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: pluginErrorText(cause, t("Something went wrong.")),
  });
}
