import { decodeReleasedLanguage, SYSTEM_LANGUAGE } from "@t3tools/client-runtime/locales";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import type {
  ConfirmDialogOptions,
  ContextMenuItem,
  ContextMenuSource,
  LocalApi,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { isWebUrl } from "./browser/webUrl";
import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { m } from "./i18n/messages";

let cachedApi: LocalApi | undefined;
const RELEASED_LANGUAGE_KEY = "baskule.language";

function releasedBrowserLanguage(): string | undefined {
  try {
    const cookie = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith("baskule_language="))
      ?.split("=")[1];
    return decodeReleasedLanguage(cookie ?? localStorage.getItem(RELEASED_LANGUAGE_KEY));
  } catch {
    return undefined;
  }
}

export function createLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error(m(msg("Unable to open link.")));
          }
          return;
        }

        if (!isWebUrl(url)) throw new Error(m(msg("Unable to open link.")));
        window.open(url, "_blank", "noopener,noreferrer");
      },
      openSystemSettings: async (pane) => {
        if (!window.desktopBridge) {
          throw new Error(m(msg("Unable to open System Settings.")));
        }
        const opened = await window.desktopBridge.openSystemSettings(pane);
        if (!opened) {
          throw new Error(m(msg("Unable to open System Settings.")));
        }
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
        source?: ContextMenuSource,
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position, source) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position, source);
      },
      // Unlike native menus, the DOM fallback needs dismissal when underlying state disappears.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        const bridge = window.desktopBridge;
        const settings = bridge ? await bridge.getClientSettings() : readBrowserClientSettings();
        const language = releasedBrowserLanguage();
        if (language === undefined) return settings;
        const migrated = {
          ...(settings ?? DEFAULT_CLIENT_SETTINGS),
          language:
            settings?.language && settings.language !== SYSTEM_LANGUAGE
              ? settings.language
              : language,
        };
        try {
          if (bridge) await bridge.setClientSettings(migrated);
          else writeBrowserClientSettings(migrated);
          localStorage.removeItem(RELEASED_LANGUAGE_KEY);
          document.cookie = "baskule_language=; Path=/; SameSite=Lax; Max-Age=0";
        } catch {
          // Keep the legacy preference available on the next read if persistence failed.
        }
        return migrated;
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}
