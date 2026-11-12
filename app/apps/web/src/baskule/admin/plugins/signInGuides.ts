// baskule: how to register an OAuth client with the services that refuse automatic registration,
// keyed by the host of their authorization server.
import { t } from "../../../i18n";

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
      text: t("In Google Auth Platform, create an OAuth client of the type Web application."),
      links: [
        {
          href: "https://console.cloud.google.com/auth/clients/create",
          label: t("Create a client"),
        },
      ],
    },
    {
      text: t(
        "Under Audience, choose Internal to let only people in your Google Workspace sign in, or External and add each person as a test user.",
      ),
      links: [
        { href: "https://console.cloud.google.com/auth/audience", label: t("Open Audience") },
      ],
    },
    { text: t("Under Authorized redirect URIs, add the callback URL above.") },
    ...(hosts.length > 0
      ? [
          {
            text: t("Enable the API of each service in your Google Cloud project."),
            links: hosts.map((host) => ({
              href: `https://console.cloud.google.com/apis/library/${encodeURIComponent(host)}`,
              label: t("Enable {{host}}", { host }),
            })),
          },
        ]
      : []),
    { text: t("Copy the client ID and client secret into the fields below.") },
  ],
};

const microsoft: SignInGuide = {
  vendor: "Microsoft",
  scopesPlaceholder: "offline_access User.Read",
  steps: () => [
    {
      text: t(
        "In the Microsoft Entra admin center, open App registrations and choose New registration.",
      ),
      links: [
        {
          href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
          label: t("Open App registrations"),
        },
      ],
    },
    {
      text: t("For who can use it, accounts in your organization only is the usual choice."),
    },
    { text: t("Under Redirect URI, choose Web and add the callback URL above.") },
    { text: t("Under Certificates & secrets, create a client secret and copy its value.") },
    {
      text: t("Copy the Application (client) ID and the secret into the fields below."),
    },
  ],
};

const slack: SignInGuide = {
  vendor: "Slack",
  scopesPlaceholder: "channels:read chat:write",
  steps: () => [
    {
      text: t("Create a Slack app from scratch in your workspace."),
      links: [{ href: "https://api.slack.com/apps?new_app=1", label: t("Create a Slack app") }],
    },
    { text: t("Under OAuth & Permissions, add the callback URL above as a redirect URL.") },
    { text: t("Add the user token scopes the plugin needs.") },
    {
      text: t(
        "Under Basic Information, copy the client ID and client secret into the fields below.",
      ),
    },
  ],
};

const github: SignInGuide = {
  vendor: "GitHub",
  scopesPlaceholder: "repo read:org",
  steps: () => [
    {
      text: t(
        "Create an OAuth app in your organization's settings, under Developer settings → OAuth Apps.",
      ),
      links: [{ href: "https://github.com/settings/applications/new", label: t("New OAuth app") }],
    },
    { text: t("Use the callback URL above as the Authorization callback URL.") },
    { text: t("Generate a client secret.") },
    { text: t("Copy the client ID and client secret into the fields below.") },
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
      scopesPlaceholder: "openid email",
      steps: () => [
        {
          text: t("Register an OAuth client of the type web application with {{vendor}}.", {
            vendor: host,
          }),
        },
        { text: t("Add the callback URL above as its redirect URI.") },
        {
          text: t(
            "Copy its client ID and, if it has one, its client secret into the fields below.",
          ),
        },
      ],
    }
  );
}
