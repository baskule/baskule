import { m as resolveMessage } from "../../../i18n/messages";
import { msg } from "gt-react";
// baskule: how to register an OAuth client with the services that refuse automatic registration,
// keyed by the host of their authorization server.


export interface GuideLink {
  readonly href: string;
  readonly label: string;
}

export interface GuideStep {
  readonly text: string;
  readonly links?: ReadonlyArray<GuideLink>;
}

export interface SignInGuide {
  readonly vendor: string;
  readonly steps: (hosts: ReadonlyArray<string>) => ReadonlyArray<GuideStep>;
  readonly scopesPlaceholder: string;
}

const google: SignInGuide = {
  vendor: "Google",
  scopesPlaceholder: "https://www.googleapis.com/auth/gmail.readonly",
  steps: (hosts) => [
    {
      text: resolveMessage(msg("In Google Auth Platform, create an OAuth client of the type Web application.")),
      links: [
        {
          href: "https://console.cloud.google.com/auth/clients/create",
          label: resolveMessage(msg("Create a client")),
        },
      ],
    },
    {
      text: resolveMessage(msg("Under Audience, choose Internal to let only people in your Google Workspace sign in, or External and add each person as a test user.")),
      links: [
        { href: "https://console.cloud.google.com/auth/audience", label: resolveMessage(msg("Open Audience")) },
      ],
    },
    { text: resolveMessage(msg("Under Authorized redirect URIs, add the callback URL above.")) },
    ...(hosts.length > 0
      ? [
          {
            text: resolveMessage(msg("Enable the API of each service in your Google Cloud project.")),
            links: hosts.map((host) => ({
              href: `https://console.cloud.google.com/apis/library/${encodeURIComponent(host)}`,
              label: resolveMessage(msg("Enable {host}"), { host }),
            })),
          },
        ]
      : []),
    { text: resolveMessage(msg("Copy the client ID and client secret into the fields below.")) },
  ],
};

const microsoft: SignInGuide = {
  vendor: "Microsoft",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- OAuth scope identifiers
  scopesPlaceholder: "offline_access User.Read",
  steps: () => [
    {
      text: resolveMessage(msg("In the Microsoft Entra admin center, open App registrations and choose New registration.")),
      links: [
        {
          href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
          label: resolveMessage(msg("Open App registrations")),
        },
      ],
    },
    {
      text: resolveMessage(msg("For who can use it, accounts in your organization only is the usual choice.")),
    },
    { text: resolveMessage(msg("Under Redirect URI, choose Web and add the callback URL above.")) },
    { text: resolveMessage(msg("Under Certificates & secrets, create a client secret and copy its value.")) },
    {
      text: resolveMessage(msg("Copy the Application (client) ID and the secret into the fields below.")),
    },
  ],
};

const slack: SignInGuide = {
  vendor: "Slack",
  scopesPlaceholder: "channels:read chat:write",
  steps: () => [
    {
      text: resolveMessage(msg("Create a Slack app from scratch in your workspace.")),
      links: [{ href: "https://api.slack.com/apps?new_app=1", label: resolveMessage(msg("Create a Slack app")) }],
    },
    { text: resolveMessage(msg("Under OAuth & Permissions, add the callback URL above as a redirect URL.")) },
    { text: resolveMessage(msg("Add the user token scopes the plugin needs.")) },
    {
      text: resolveMessage(msg("Under Basic Information, copy the client ID and client secret into the fields below.")),
    },
  ],
};

const github: SignInGuide = {
  vendor: "GitHub",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- OAuth scope identifiers
  scopesPlaceholder: "repo read:org",
  steps: () => [
    {
      text: resolveMessage(msg("Create an OAuth app in your organization's settings, under Developer settings → OAuth Apps.")),
      links: [{ href: "https://github.com/settings/applications/new", label: resolveMessage(msg("New OAuth app")) }],
    },
    { text: resolveMessage(msg("Use the callback URL above as the Authorization callback URL.")) },
    { text: resolveMessage(msg("Generate a client secret.")) },
    { text: resolveMessage(msg("Copy the client ID and client secret into the fields below.")) },
  ],
};

const GUIDES: Record<string, SignInGuide> = {
  "accounts.google.com": google,
  "login.microsoftonline.com": microsoft,
  "slack.com": slack,
  "github.com": github,
};

/** The issuer's host with its port, so two local or self-hosted servers stay apart. */
function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

export function signInGuide(issuer: string): SignInGuide {
  const host = issuerHost(issuer);
  return (
    GUIDES[host] ?? {
      vendor: host,
      // oxlint-disable-next-line t3code/no-untranslated-copy -- OAuth scope identifiers
      scopesPlaceholder: "openid email",
      steps: () => [
        {
          text: resolveMessage(msg("Register an OAuth client of the type web application with {vendor}."), {
            vendor: host,
          }),
        },
        { text: resolveMessage(msg("Add the callback URL above as its redirect URI.")) },
        {
          text: resolveMessage(msg("Copy its client ID and, if it has one, its client secret into the fields below.")),
        },
      ],
    }
  );
}
