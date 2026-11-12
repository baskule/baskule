import {
  PLUGIN_ERROR_CODES,
  type AdminPlugin,
  type AdminPluginList,
  type Catalog,
  type MemberPluginList,
  type MemberPluginUpdate,
  type OAuthClientInput,
  type OAuthClientSetup,
  type PluginErrorCode,
  type PluginInstallRequest,
  type PluginPreview,
  type PluginPreviewRequest,
  type PluginUpdateRequest,
  type ProviderId,
  type ProviderInput,
} from "@t3tools/contracts/baskule-plugins";
import { toastManager } from "../../components/ui/toast";
import { t } from "../../i18n";
import { BaskuleApiError, request } from "../api";

const root = "/api/baskule";
const enc = encodeURIComponent;

export const pluginsApi = {
  catalog: (refresh = false) =>
    request<Catalog>("GET", `${root}/admin/catalog${refresh ? "?refresh=1" : ""}`),
  installed: () => request<AdminPluginList>("GET", `${root}/admin/plugins`),
  preview: (input: PluginPreviewRequest) =>
    request<PluginPreview>("POST", `${root}/admin/plugins/preview`, input),
  install: (input: PluginInstallRequest) =>
    request<AdminPlugin>("POST", `${root}/admin/plugins`, input),
  update: (id: string, input: PluginUpdateRequest) =>
    request<AdminPlugin>("PATCH", `${root}/admin/plugins/${enc(id)}`, input),
  remove: (id: string) => request<{ ok: true }>("DELETE", `${root}/admin/plugins/${enc(id)}`),
  saveOAuthClient: (input: OAuthClientInput) =>
    request<OAuthClientSetup>("PUT", `${root}/admin/oauth-clients`, input),
  removeOAuthClient: (issuer: string) =>
    request<unknown>("DELETE", `${root}/admin/oauth-clients?issuer=${enc(issuer)}`),
  saveProvider: (input: ProviderInput) =>
    request<unknown>("PUT", `${root}/admin/plugin-providers/${enc(input.provider)}`, input),
  removeProvider: (provider: ProviderId) =>
    request<unknown>("DELETE", `${root}/admin/plugin-providers/${enc(provider)}`),
  mine: async () => (await request<MemberPluginList>("GET", `${root}/plugins`)).plugins,
  switch: (id: string, input: MemberPluginUpdate) =>
    request<unknown>("PUT", `${root}/plugins/${enc(id)}`, input),
  disconnect: (id: string, serverId: string) =>
    request<unknown>("DELETE", `${root}/plugins/${enc(id)}/servers/${enc(serverId)}/connection`),
};

/**
 * Where the browser goes to sign in to one server. The endpoint redirects to the service and
 * the person comes back to `returnTo` with `plugin` and `connection` in the query. Navigate to
 * it; fetching it would start a second sign-in.
 */
export function connectUrl(pluginId: string, serverId: string, returnTo = "/settings/plugins") {
  return `${root}/plugins/${enc(pluginId)}/servers/${enc(serverId)}/connect?${new URLSearchParams({ returnTo })}`;
}

/** The redirect URI administrators register with a service, before the server names it. */
export function defaultCallbackUrl(): string {
  const origin = window.desktopBridge?.getBaskuleServer?.() ?? window.location.origin;
  return `${origin}/api/baskule/plugins/oauth/callback`;
}

const PLUGIN_ERRORS: Record<PluginErrorCode, () => string> = {
  invalid_request: () => t("Some details aren't valid. Check them and try again."),
  plugin_not_found: () => t("This plugin no longer exists. Reload the page."),
  server_not_found: () => t("This app is no longer part of the plugin. Reload the page."),
  plugin_changed: () =>
    t("The plugin changed at its source since you opened it. Review it again before adding it."),
  plugin_exists: () => t("This plugin is already added. Open it from Installed."),
  plugin_empty: () => t("Baskule found no apps or skills it can use in this plugin."),
  plugin_too_large: () => t("This plugin is too large to add."),
  source_unreadable: () =>
    t("Baskule couldn't read this plugin's files. Check the link and try again."),
  source_not_github: () => t("Enter the link to a public repository on github.com."),
  invalid_server: () =>
    t("Baskule can't use this server address. Enter its full https:// address."),
  missing_values: () => t("Fill in the values this plugin needs first."),
  invalid_oauth_client: () => t("The service refused this client. Check its ID and secret."),
  oauth_client_required: () => t("An administrator needs to set up sign-in to this service first."),
  oauth_failed: () => t("The sign-in didn't finish. Try again."),
  provider_not_configured: () => t("Connect this app platform under Sign-in and sources first."),
  provider_rejected: () => t("The platform refused these credentials. Check them and try again."),
  provider_unavailable: () => t("The platform didn't answer. Try again in a moment."),
  group_not_found: () => t("One of these groups no longer exists. Reload the page and try again."),
};

/** Codes a sign-in can come back with, besides the plugin error codes. */
const CONNECTION_ERRORS: Record<string, () => string> = {
  access_denied: () => t("The sign-in was cancelled or permission was not granted."),
  plugin_off: () => t("Switch the plugin on first."),
  not_allowed: () => t("You can no longer use this plugin."),
  setup_incomplete: () => t("An administrator needs to finish setting this plugin up."),
  unavailable: () => t("The service didn't answer. Try again in a moment."),
};

const isPluginErrorCode = (code: string): code is PluginErrorCode =>
  (PLUGIN_ERROR_CODES as ReadonlyArray<string>).includes(code);

/** A plugin error code in plain words. Anything else gets `fallback`, never the raw code. */
export function pluginErrorCodeText(code: string | null | undefined, fallback: string): string {
  if (!code) return fallback;
  if (isPluginErrorCode(code)) return PLUGIN_ERRORS[code]();
  return CONNECTION_ERRORS[code]?.() ?? fallback;
}

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
