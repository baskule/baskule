/** Marks English catalog prose for extraction (app/scripts/localization.ts); the web renders it with t(). */
const msg = (text: string) => text;

export type CatalogArea = "mail_calendar_files" | "communication" | "knowledge" | "work" | "crm" | "support" | "finance" | "design" | "engineering";

/** How every service of one vendor signs in. Set up once per vendor. */
export type VendorSignIn =
  | { type: "none" }
  | { type: "key"; header: string }                                    // one organization key
  | { type: "account"; client: "dynamic"; params?: Record<string, string> }
  | { type: "account"; client: "static"; issuer: string;               // may contain {tenant}
      fields?: "tenant"[]; params?: Record<string, string>; resource?: false; docs: string };

export interface CatalogVendor { id: string; name: string; signIn: VendorSignIn }

export interface CatalogService {
  id: string;               // becomes the plugin id: one install per entry
  vendor: string;           // CatalogVendor.id
  name: string;             // brand, never translated
  description: string;      // msg()
  area: CatalogArea;
  icon: string;             // https
  docs: string;             // the vendor's documentation of this server
  servers: { name: string; url: string; transport?: "sse"; scopes?: string[]; resource?: string }[];
  prerequisites: string[];  // msg(): plan, preview enrolment, tenant settings
  notYet?: string;          // msg(): replaces Add while the vendor has not admitted Baskule (Shopify, Figma, Docusign)
  reviewBy: string;         // YYYY-MM-DD. platform/test/unit/plugin-catalog.test.ts fails after it.
}
export const CATALOG_VENDORS: readonly CatalogVendor[] = [
  {
    id: "google",
    name: "Google",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://accounts.google.com",
      params: {
        access_type: "offline",
        prompt: "consent select_account",
      },
      resource: false,
      docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    },
  },
  // Tenant substitution is required. Live organizations/common metadata returns literal {tenantid}; do not pin organizations as a tenant issuer.
  {
    id: "microsoft",
    name: "Microsoft",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
      fields: ["tenant"],
      resource: false,
      docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    },
  },
  {
    id: "slack",
    name: "Slack",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://mcp.slack.com",
      docs: "https://docs.slack.dev/ai/slack-mcp-server/",
    },
  },
  {
    id: "zoom",
    name: "Zoom",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://zoom.us",
      docs: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
    },
  },
  {
    id: "notion",
    name: "Notion",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "atlassian",
    name: "Atlassian",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "box",
    name: "Box",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://api.box.com",
      docs: "https://developer.box.com/guides/box-mcp/setup/",
    },
  },
  {
    id: "dropbox",
    name: "Dropbox",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://www.dropbox.com",
      params: {
        token_access_type: "offline",
      },
      docs: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    },
  },
  // Use V2 metadata. The root metadata still exposes a different DCR server; it is not the V2 recipe. resource is optional, so this recipe omits it.
  {
    id: "asana",
    name: "Asana",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://app.asana.com",
      resource: false,
      docs: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    },
  },
  {
    id: "linear",
    name: "Linear",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "monday",
    name: "monday.com",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "clickup",
    name: "ClickUp",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "airtable",
    name: "Airtable",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "intercom",
    name: "Intercom",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "calendly",
    name: "Calendly",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "miro",
    name: "Miro",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "qonto",
    name: "Qonto",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "pennylane",
    name: "Pennylane",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://mcp.hubspot.com",
      docs: "https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available",
    },
  },
  // Production login.salesforce.com path only. Sandbox and organizations enforcing My Domain need a separately qualified issuer/endpoint recipe; this schema has no arbitrary domain field.
  {
    id: "salesforce",
    name: "Salesforce",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://login.salesforce.com",
      docs: "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html",
    },
  },
  // Use api.canva.com/connect/v1/mcp with this issuer. Do not mix in mcp.canva.com credentials or DCR.
  {
    id: "canva",
    name: "Canva",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://www.canva.com",
      docs: "https://www.canva.dev/docs/apps/mcp/access/",
    },
  },
  {
    id: "github",
    name: "GitHub",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://github.com/login/oauth",
      docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    },
  },
  // UNVERIFIED static-client onboarding; held pending vendor admission. Metadata exists but does not prove arbitrary client provisioning.
  {
    id: "shopify",
    name: "Shopify",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://setup.shopify.com/auth",
      docs: "https://shopify.dev/docs/apps/build/ai-toolkit",
    },
  },
  {
    id: "figma",
    name: "Figma",
    signIn: {
      type: "account",
      client: "dynamic",
    },
  },
  // HELD: protected resource advertises https://mcp.docusign.com but its AS metadata declares https://account.docusign.com. Preserve exact issuer validation.
  {
    id: "docusign",
    name: "Docusign",
    signIn: {
      type: "account",
      client: "static",
      issuer: "https://account.docusign.com",
      docs: "https://developers.docusign.com/platform/mcp-server/",
    },
  },
];

export const CATALOG: readonly CatalogService[] = [
  {
    id: "gmail",
    vendor: "google",
    name: "Gmail",
    description: msg("Search and read email and create drafts for you to review and send in Gmail."),
    area: "mail_calendar_files",
    icon: "https://www.gstatic.com/images/branding/product/2x/gmail_48dp.png",
    docs: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    servers: [
      {
        name: "gmail",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
      }
    ],
    prerequisites: [msg("Your Google Cloud project must be enrolled in the Workspace MCP Developer Preview and enable the product API and MCP API."), msg("An administrator must register a web OAuth client, add this installation's callback, and mark it as an AI-powered agent before November 11, 2026."), msg("Use an internal app for your own Workspace organization, or meet Google's external-app verification requirements.")],
    reviewBy: "2026-11-11",
  },
  // The setup guide lists read scopes despite write tools. The per-tool reference confirms calendar.events for writes; no generic full-calendar scope is needed.
  {
    id: "google-calendar",
    vendor: "google",
    name: "Google Calendar",
    description: msg("Read calendars, find available times, and create, update or cancel events."),
    area: "mail_calendar_files",
    icon: "https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png",
    docs: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
    servers: [
      {
        name: "google-calendar",
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"],
      }
    ],
    prerequisites: [msg("Your Google Cloud project must be enrolled in the Workspace MCP Developer Preview and enable the product API and MCP API."), msg("An administrator must register a web OAuth client, add this installation's callback, and mark it as an AI-powered agent before November 11, 2026."), msg("Use an internal app for your own Workspace organization, or meet Google's external-app verification requirements.")],
    reviewBy: "2026-11-11",
  },
  // INFERRED minimum scope unions: product readwrite scopes replace corresponding readonly scopes; Drive discovery needs drive.readonly. Exact tool-by-tool coverage remains untested. Docs/Sheets metadata omits drive.file even though their setup guides list it, so this recipe uses product scopes for edits.
  {
    id: "google-drive",
    vendor: "google",
    name: "Google Drive",
    description: msg("Find and read files, and create or edit documents, spreadsheets and presentations you can access."),
    area: "mail_calendar_files",
    icon: "https://www.gstatic.com/images/branding/product/2x/drive_48dp.png",
    docs: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
    servers: [
      {
        name: "google-drive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
      },
      {
        name: "google-docs",
        url: "https://docsmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/documents"],
      },
      {
        name: "google-sheets",
        url: "https://sheetsmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets"],
      },
      {
        name: "google-slides",
        url: "https://slidesmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/presentations"],
      }
    ],
    prerequisites: [msg("Your Google Cloud project must be enrolled in the Workspace MCP Developer Preview and enable the product API and MCP API."), msg("An administrator must register a web OAuth client, add this installation's callback, and mark it as an AI-powered agent before November 11, 2026."), msg("Use an internal app for your own Workspace organization, or meet Google's external-app verification requirements."), msg("Editing is limited to the tools and files allowed by your consent and existing permissions.")],
    reviewBy: "2026-11-11",
  },
  // INFERRED minimum for search/read/send only. Membership, read-state and space-setting tools require additional consent; do not silently enable them under this scope set.
  {
    id: "google-chat",
    vendor: "google",
    name: "Google Chat",
    description: msg("Search conversations, read messages and send messages in Google Chat."),
    area: "communication",
    icon: "https://www.gstatic.com/images/branding/product/2x/chat_48dp.png",
    docs: "https://developers.google.com/workspace/chat/api/guides/configure-mcp-server",
    servers: [
      {
        name: "google-chat",
        url: "https://chatmcp.googleapis.com/mcp/v1",
        scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.messages.readonly", "https://www.googleapis.com/auth/chat.messages.create"],
      }
    ],
    prerequisites: [msg("Your Google Cloud project must be enrolled in the Workspace MCP Developer Preview and enable the product API and MCP API."), msg("An administrator must register a web OAuth client, add this installation's callback, and mark it as an AI-powered agent before November 11, 2026."), msg("Use an internal app for your own Workspace organization, or meet Google's external-app verification requirements."), msg("Sending messages requires a configured Google Chat app; read-only access does not.")],
    reviewBy: "2026-11-11",
  },
  // UNVERIFIED final grant: WorkIQ.Act is documented but differs from the metadata-advertised Ask scope. Tenant-specific paths and write policy need an owned-client check. Full Word/Excel/PowerPoint document editing is not established.
  {
    id: "outlook",
    vendor: "microsoft",
    name: "Outlook mail and calendar",
    description: msg("Read email and calendars, send email and create events when your organization permits changes."),
    area: "mail_calendar_files",
    icon: "https://www.microsoft.com/favicon.ico",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    servers: [
      {
        name: "outlook",
        url: "https://workiq.svc.cloud.microsoft/mcp",
        scopes: ["api://workiq.svc.cloud.microsoft/WorkIQ.Act", "offline_access"],
      }
    ],
    prerequisites: [msg("Your organization must enable Work IQ and an administrator must register an Entra app and grant tenant consent."), msg("An Azure billing connection and Copilot Credits are required; usage is billed."), msg("Your tenant must allow changes before the assistant can send messages, create events or change files."), msg("Work IQ supports work or school Microsoft 365 accounts; consumer Outlook accounts are outside this recipe.")],
    notYet: msg("Not available yet: Microsoft tenant-specific sign-in and permissions need qualification."),
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED final grant: WorkIQ.Act is documented but differs from the metadata-advertised Ask scope. Tenant-specific paths and write policy need an owned-client check. Full Word/Excel/PowerPoint document editing is not established.
  {
    id: "onedrive",
    vendor: "microsoft",
    name: "OneDrive",
    description: msg("Find and read OneDrive files and perform file changes supported by your organization."),
    area: "mail_calendar_files",
    icon: "https://www.microsoft.com/favicon.ico",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    servers: [
      {
        name: "onedrive",
        url: "https://workiq.svc.cloud.microsoft/mcp",
        scopes: ["api://workiq.svc.cloud.microsoft/WorkIQ.Act", "offline_access"],
      }
    ],
    prerequisites: [msg("Your organization must enable Work IQ and an administrator must register an Entra app and grant tenant consent."), msg("An Azure billing connection and Copilot Credits are required; usage is billed."), msg("Your tenant must allow changes before the assistant can send messages, create events or change files."), msg("Work IQ supports work or school Microsoft 365 accounts; consumer Outlook accounts are outside this recipe.")],
    notYet: msg("Not available yet: Microsoft tenant-specific sign-in and permissions need qualification."),
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED final grant: WorkIQ.Act is documented but differs from the metadata-advertised Ask scope. Tenant-specific paths and write policy need an owned-client check. Full Word/Excel/PowerPoint document editing is not established.
  {
    id: "sharepoint",
    vendor: "microsoft",
    name: "SharePoint",
    description: msg("Find and read SharePoint content and perform changes supported by your organization."),
    area: "knowledge",
    icon: "https://www.microsoft.com/favicon.ico",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    servers: [
      {
        name: "sharepoint",
        url: "https://workiq.svc.cloud.microsoft/mcp",
        scopes: ["api://workiq.svc.cloud.microsoft/WorkIQ.Act", "offline_access"],
      }
    ],
    prerequisites: [msg("Your organization must enable Work IQ and an administrator must register an Entra app and grant tenant consent."), msg("An Azure billing connection and Copilot Credits are required; usage is billed."), msg("Your tenant must allow changes before the assistant can send messages, create events or change files."), msg("Work IQ supports work or school Microsoft 365 accounts; consumer Outlook accounts are outside this recipe.")],
    notYet: msg("Not available yet: Microsoft tenant-specific sign-in and permissions need qualification."),
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED final grant: WorkIQ.Act is documented but differs from the metadata-advertised Ask scope. Tenant-specific paths and write policy need an owned-client check. Full Word/Excel/PowerPoint document editing is not established.
  {
    id: "teams",
    vendor: "microsoft",
    name: "Microsoft Teams",
    description: msg("Find and read Teams conversations and send messages when your organization permits changes."),
    area: "communication",
    icon: "https://www.microsoft.com/favicon.ico",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    servers: [
      {
        name: "teams",
        url: "https://workiq.svc.cloud.microsoft/mcp",
        scopes: ["api://workiq.svc.cloud.microsoft/WorkIQ.Act", "offline_access"],
      }
    ],
    prerequisites: [msg("Your organization must enable Work IQ and an administrator must register an Entra app and grant tenant consent."), msg("An Azure billing connection and Copilot Credits are required; usage is billed."), msg("Your tenant must allow changes before the assistant can send messages, create events or change files."), msg("Work IQ supports work or school Microsoft 365 accounts; consumer Outlook accounts are outside this recipe.")],
    notYet: msg("Not available yet: Microsoft tenant-specific sign-in and permissions need qualification."),
    reviewBy: "2027-01-31",
  },
  {
    id: "slack",
    vendor: "slack",
    name: "Slack",
    description: msg("Search conversations, read channels and threads, and send messages in Slack."),
    area: "communication",
    icon: "https://slack.com/favicon.ico",
    docs: "https://docs.slack.dev/ai/slack-mcp-server/",
    servers: [
      {
        name: "slack",
        url: "https://mcp.slack.com/mcp",
        resource: "https://mcp.slack.com",
        scopes: ["search:read.public", "search:read.private", "search:read.mpim", "search:read.im", "channels:history", "groups:history", "mpim:history", "im:history", "chat:write"],
      }
    ],
    prerequisites: [msg("An administrator must create an internal Slack app for your workspace or use an approved Marketplace app; unlisted public apps cannot connect."), msg("Register this installation's callback and grant the listed user permissions; workspace app approval and IP restrictions apply.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED meeting-only scope selection on the unified Zoom endpoint. Other Zoom product tools require additional scopes; no complete unified-server scope set is claimed.
  {
    id: "zoom",
    vendor: "zoom",
    name: "Zoom",
    description: msg("Find meetings and recordings, read meeting content, and schedule or update meetings."),
    area: "communication",
    icon: "https://zoom.us/favicon.ico",
    docs: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
    servers: [
      {
        name: "zoom",
        url: "https://mcp.zoom.us/mcp/zoom/streamable",
        scopes: ["meeting:read:search", "meeting:read:assets", "cloud_recording:read:list_user_recordings", "cloud_recording:read:content", "meeting:write:meeting", "meeting:update:meeting"],
      }
    ],
    prerequisites: [msg("An administrator or developer must create a Zoom General app, register this installation's callback and enable the required scopes."), msg("Users need licenses for the Zoom products and meeting or recording content they use.")],
    reviewBy: "2027-01-31",
  },
  {
    id: "notion",
    vendor: "notion",
    name: "Notion",
    description: msg("Search your workspace and create or update Notion pages and databases."),
    area: "knowledge",
    icon: "https://www.notion.so/images/favicon.ico",
    docs: "https://developers.notion.com/guides/mcp/build-mcp-client",
    servers: [
      {
        name: "notion",
        url: "https://mcp.notion.com/mcp",
        scopes: ["default"],
      }
    ],
    prerequisites: [msg("Connect your Notion account; Enterprise administrators may need to allow the client."), msg("Some tools require a paid Notion feature; the server reports tool access for your plan.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED product-specific minimum scopes from live metadata. tools=all is the vendor-documented flat tool-list option. Both cards use the same resource; token scopes must prevent accidental cross-product access. Rovo credit impact is unverified for the tenant.
  {
    id: "confluence",
    vendor: "atlassian",
    name: "Confluence",
    description: msg("Find and read Confluence pages, and create or update pages in your sites."),
    area: "knowledge",
    icon: "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
    docs: "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
    servers: [
      {
        name: "confluence",
        url: "https://mcp.atlassian.com/v2/mcp?tools=all",
        resource: "https://mcp.atlassian.com/v2/mcp",
        scopes: ["offline_access", "read:confluence:agent-interface", "search:confluence:agent-interface", "write:confluence:agent-interface"],
      }
    ],
    prerequisites: [msg("An Atlassian Cloud account and access to the relevant sites are required."), msg("Your administrator must allow this client's callback domain and the requested read, search and write permissions; usage limits or Rovo credits may apply.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED product-specific minimum scopes from live metadata. tools=all is the vendor-documented flat tool-list option. Both cards use the same resource; token scopes must prevent accidental cross-product access. Rovo credit impact is unverified for the tenant.
  {
    id: "jira",
    vendor: "atlassian",
    name: "Jira",
    description: msg("Find issues and projects, create or update issues, and add comments in Jira."),
    area: "work",
    icon: "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
    docs: "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
    servers: [
      {
        name: "jira",
        url: "https://mcp.atlassian.com/v2/mcp?tools=all",
        resource: "https://mcp.atlassian.com/v2/mcp",
        scopes: ["offline_access", "read:jira:agent-interface", "search:jira:agent-interface", "write:jira:agent-interface"],
      }
    ],
    prerequisites: [msg("An Atlassian Cloud account and access to the relevant sites are required."), msg("Your administrator must allow this client's callback domain and the requested read, search and write permissions; usage limits or Rovo credits may apply.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED minimum for ordinary file operations: omit ai.readwrite and docgen.readwrite because AI-query and document-generation tools are not offered. Box resource metadata names api.box.com/ while AS issuer omits the slash.
  {
    id: "box",
    vendor: "box",
    name: "Box",
    description: msg("Find and read Box files, and upload or update content you can edit."),
    area: "knowledge",
    icon: "https://www.box.com/favicon.ico",
    docs: "https://developer.box.com/guides/box-mcp/setup/",
    servers: [
      {
        name: "box",
        url: "https://mcp.box.com",
        scopes: ["root_readwrite"],
      }
    ],
    prerequisites: [msg("A Box administrator must configure a Box MCP Server app, register this installation's callback and choose its access scopes."), msg("Document generation requires Enterprise Advanced and extra scopes; it is outside this entry's offered tools.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED reduced file-only scopes rather than the full vendor sample. File sharing, file requests, permanent deletion and Paper tools are outside the described surface.
  {
    id: "dropbox",
    vendor: "dropbox",
    name: "Dropbox",
    description: msg("Search and read Dropbox files, and upload or update file content."),
    area: "knowledge",
    icon: "https://www.dropbox.com/static/30168/images/favicon.ico",
    docs: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    servers: [
      {
        name: "dropbox",
        url: "https://mcp.dropbox.com/mcp",
        scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write"],
      }
    ],
    prerequisites: [msg("An administrator must create a scoped Full Dropbox app and register this installation's callback; team policies may block app connections."), msg("The service is in beta; automatic registration is reserved for Dropbox's named trusted clients.")],
    reviewBy: "2027-01-31",
  },
  {
    id: "asana",
    vendor: "asana",
    name: "Asana",
    description: msg("Find projects and tasks, create or update tasks, and coordinate work in Asana."),
    area: "work",
    icon: "https://asana.com/favicon.ico",
    docs: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    servers: [
      {
        name: "asana",
        url: "https://mcp.asana.com/v2/mcp",
        scopes: [],
      }
    ],
    prerequisites: [msg("An administrator must create an Asana MCP app, register this installation's callback and allow the relevant workspaces."), msg("Asana grants every available MCP tool subject to your own permissions; it does not offer per-tool OAuth scopes.")],
    reviewBy: "2027-01-31",
  },
  {
    id: "linear",
    vendor: "linear",
    name: "Linear",
    description: msg("Search issues and projects, create or update issues, and add comments in Linear."),
    area: "work",
    icon: "https://linear.app/favicon.ico",
    docs: "https://linear.app/docs/mcp",
    servers: [
      {
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        scopes: ["read", "write"],
      }
    ],
    prerequisites: [msg("Connect your Linear account and authorize access to the workspace; organization policies still apply.")],
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED minimum scopes: neither fetched resource nor AS metadata enumerates them. Omit scopes to use server-managed consent; do not interpret this as unrestricted unauthenticated access. scopes is intentionally absent, not an assertion that no permission is needed.
  {
    id: "monday",
    vendor: "monday",
    name: "monday.com",
    description: msg("Find boards, create or update items, and post updates in monday.com."),
    area: "work",
    icon: "https://monday.com/favicon.ico",
    docs: "https://developer.monday.com/api-reference/docs/build-on-monday-with-ai",
    servers: [
      {
        name: "monday",
        url: "https://mcp.monday.com/mcp",
      }
    ],
    prerequisites: [msg("Connect your monday.com account; an account administrator may need to approve the app."), msg("Available on all plans, subject to account permissions and API limits.")],
    reviewBy: "2027-01-31",
  },
  // Current vendor FAQ explicitly accepts custom MCP clients with PKCE. The prior allowlisted-clients-only claim is not retained. Delete tools and connected-app search are not supported.
  {
    id: "clickup",
    vendor: "clickup",
    name: "ClickUp",
    description: msg("Search tasks and documents, manage tasks, log time and post comments in ClickUp."),
    area: "work",
    icon: "https://clickup.com/favicon.ico",
    docs: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    servers: [
      {
        name: "clickup",
        url: "https://mcp.clickup.com/mcp",
        scopes: ["read", "write"],
      }
    ],
    prerequisites: [msg("Connect with OAuth and select the workspaces you want to share; API keys are not supported."), msg("Available on all plans; usage limits depend on the workspace plan and Everything AI add-on.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED board/card scope set from live metadata. Planner and Inbox tools are excluded. Two vendor help pages disagree on single versus multiple workspace connections; the catalog makes no numeric promise.
  {
    id: "trello",
    vendor: "atlassian",
    name: "Trello",
    description: msg("Find boards and cards, and create, update or archive cards and lists in Trello."),
    area: "work",
    icon: "https://trello.com/favicon.ico",
    docs: "https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/",
    servers: [
      {
        name: "trello",
        url: "https://mcp.trello.com/v1",
        scopes: ["offline_access", "read:board:trello", "write:board:trello", "read:organization:trello", "read:member:trello"],
      }
    ],
    prerequisites: [msg("Available on every Trello plan; authorize the workspaces and permissions on the consent screen."), msg("Your organization may need to allow this client's callback domain and read or write permissions."), msg("Permanent deletion is not supported; Planner focus time requires Premium or Enterprise.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED record-only minimum from live metadata. Do not request schema write or all-workspace discovery for a record-only description.
  {
    id: "airtable",
    vendor: "airtable",
    name: "Airtable",
    description: msg("Find bases and tables, read records, and create or update records in Airtable."),
    area: "work",
    icon: "https://airtable.com/favicon.ico",
    docs: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
    servers: [
      {
        name: "airtable",
        url: "https://mcp.airtable.com/mcp",
        resource: "https://mcp.airtable.com",
        scopes: ["schema.bases:read", "data.records:read", "data.records:write"],
      }
    ],
    prerequisites: [msg("Authorize the bases you want to share; Enterprise administrators may need to allow the integration."), msg("Schema changes, comments, interfaces and automation tools need additional permissions and are outside this entry's offered tools.")],
    reviewBy: "2027-01-31",
  },
  {
    id: "hubspot",
    vendor: "hubspot",
    name: "HubSpot",
    description: msg("Find CRM records and create or update contacts, companies and deals in HubSpot."),
    area: "crm",
    icon: "https://www.hubspot.com/favicon.ico",
    docs: "https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available",
    servers: [
      {
        name: "hubspot",
        url: "https://mcp.hubspot.com",
        scopes: [],
      }
    ],
    prerequisites: [msg("An administrator must create an MCP Auth App in the HubSpot account and register this installation's callback."), msg("Your HubSpot permissions and enabled objects apply; sensitive-data settings can block activity access.")],
    reviewBy: "2027-01-31",
  },
  {
    id: "salesforce",
    vendor: "salesforce",
    name: "Salesforce",
    description: msg("Find, create and update Salesforce records using the permissions of your account."),
    area: "crm",
    icon: "https://www.salesforce.com/favicon.ico",
    docs: "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html",
    servers: [
      {
        name: "salesforce",
        url: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
        scopes: ["mcp_api", "refresh_token"],
      }
    ],
    prerequisites: [msg("An administrator must enable the hosted server and create an External Client App with PKCE, JWT access tokens and this installation's callback."), msg("Your organization needs Flex Credits and may be billed for server usage."), msg("This entry uses the production login endpoint; sandbox or enforced My Domain access needs separate setup.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED mcp-only core scope; operator is excluded because Fin Operator tools are not described. EU alternative is mcp.eu.intercom.com/mcp with its own issuer; choose one deployment, do not install both as two mandatory servers.
  {
    id: "intercom",
    vendor: "intercom",
    name: "Intercom",
    description: msg("Search customers and conversations, review support context, and reply to conversations in Intercom."),
    area: "support",
    icon: "https://developers.intercom.com/assets/favicon.286f56791636e8382abf1d72b1e481c68874c05f76e399476b003e2da12d362a.8a5edab2.png",
    docs: "https://developers.intercom.com/docs/guides/mcp",
    servers: [
      {
        name: "intercom",
        url: "https://mcp.intercom.com/mcp",
        scopes: ["mcp"],
      }
    ],
    prerequisites: [msg("Intercom must approve this installation's non-localhost OAuth callback before sign-in can finish."), msg("Connect an account with the required workspace permissions; this entry uses the US server.")],
    reviewBy: "2027-01-31",
  },
  // Current docs explicitly support other MCP clients and recommend OAuth. The older vetted-redirect allowlist requirement is no longer stated in the current page; actual Baskule callback admission remains untested. Agent-tagged API keys are an alternative, not the selected recipe.
  {
    id: "stripe",
    vendor: "stripe",
    name: "Stripe",
    description: msg("Read Stripe account data and manage customers, invoices, subscriptions and payments within your permissions."),
    area: "finance",
    icon: "https://stripe.com/favicon.ico",
    docs: "https://docs.stripe.com/mcp",
    servers: [
      {
        name: "stripe",
        url: "https://mcp.stripe.com",
        scopes: ["mcp"],
      }
    ],
    prerequisites: [msg("Connect your Stripe account and choose live or sandbox access and permissions; administrators can disable MCP."), msg("Review authentication before November 30, 2026, when Stripe retires ordinary secret keys and restricted keys without the Agent tag.")],
    reviewBy: "2026-11-30",
  },
  {
    id: "calendly",
    vendor: "calendly",
    name: "Calendly",
    description: msg("Check availability and event types, book or cancel meetings, and manage Calendly scheduling availability."),
    area: "mail_calendar_files",
    icon: "https://calendly.com/favicon.ico",
    docs: "https://developer.calendly.com/docs/mcp/calendly-mcp-server",
    servers: [
      {
        name: "calendly",
        url: "https://mcp.calendly.com",
        scopes: ["mcp:scheduling:read", "mcp:scheduling:write"],
      }
    ],
    prerequisites: [msg("Connect your Calendly account through a client that supports automatic registration and PKCE."), msg("Manual OAuth console credentials and personal access tokens are not supported; your plan's scheduling features apply.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED basic-design scope set from generic integration metadata. Brand Kits, folders, assets and comments need additional scopes and are not offered here. Verify scopes against actual design generation/edit/export tools before admission.
  {
    id: "canva",
    vendor: "canva",
    name: "Canva",
    description: msg("Find designs, read their content, and create, edit or export designs in Canva."),
    area: "design",
    icon: "https://www.canva.dev/favicon.ico",
    docs: "https://www.canva.dev/docs/apps/mcp/access/",
    servers: [
      {
        name: "canva",
        url: "https://api.canva.com/connect/v1/mcp",
        scopes: ["profile:read", "design:meta:read", "design:content:read", "design:content:write"],
      }
    ],
    prerequisites: [msg("An administrator must create a Developer Portal app, turn on Canva MCP and register this installation's callback."), msg("Each person must connect their own Canva account; premium features and assets require the appropriate Canva plan or license.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED board-only scope subset; metadata also advertises openid/email, which are not data permissions and may be required by the server's own account flow. Team consent must not be treated as organization-wide access.
  {
    id: "miro",
    vendor: "miro",
    name: "Miro",
    description: msg("Read Miro boards and create or update board content and diagrams."),
    area: "design",
    icon: "https://miro.com/favicon.ico",
    docs: "https://developers.miro.com/docs/connecting-to-miro-mcp",
    servers: [
      {
        name: "miro",
        url: "https://mcp.miro.com/",
        scopes: ["boards:read", "boards:write"],
      }
    ],
    prerequisites: [msg("Choose the Miro team during sign-in; Enterprise users need an administrator to install or allow the integration."), msg("Available by default on Free, Starter, Business and Education plans, subject to board permissions.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED classic OAuth minimum for private-repository read/write. repo is broad. GitHub Apps instead use installation permissions and generally omit OAuth scopes; those grant models must not be combined. Additional default tools may need other scopes.
  {
    id: "github",
    vendor: "github",
    name: "GitHub",
    description: msg("Read repositories, issues and pull requests, and create or update issues and pull requests."),
    area: "engineering",
    icon: "https://github.com/favicon.ico",
    docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    servers: [
      {
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
        resource: "https://api.githubcopilot.com/mcp",
        scopes: ["repo"],
      }
    ],
    prerequisites: [msg("An administrator must register a GitHub OAuth App or GitHub App with this installation's callback."), msg("Organization app restrictions and repository permissions apply; this entry targets GitHub.com.")],
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED minimum scopes: public metadata lists granular scopes but the public tool-to-scope map is insufficient to derive a complete least-privilege set for transactions plus writes. Omit scopes to use server-managed consent; no broad arbitrary scope list is invented. Separate /multi-organization/mcp endpoint is read-only and not added as a mandatory server. scopes is intentionally absent, not an assertion that no permission is needed.
  {
    id: "qonto",
    vendor: "qonto",
    name: "Qonto",
    description: msg("Read account activity and invoices, and manage supported invoices or card requests in Qonto."),
    area: "finance",
    icon: "https://qonto.com/favicon.ico",
    docs: "https://docs.qonto.com/mcp/install/quickstart",
    servers: [
      {
        name: "qonto",
        url: "https://mcp.qonto.com/mcp",
        resource: "https://mcp.qonto.com",
      }
    ],
    prerequisites: [msg("An owner, administrator or accountant can connect; an owner or administrator must enable access for managers and employees."), msg("Choose the Qonto organization during sign-in; your existing role and approved permissions apply.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED minimum for the narrow described read tools. Firm-wide discovery needs mcp:companies:read; no mcp:private_api or unneeded ledger/tax scopes are requested. Whether server consent honors a reduced list needs an owned-client check.
  {
    id: "pennylane",
    vendor: "pennylane",
    name: "Pennylane",
    description: msg("Read invoices, transactions and financial reports in Pennylane without changing your accounting data."),
    area: "finance",
    icon: "https://www.pennylane.com/favicon.ico",
    docs: "https://www.pennylane.com/fr/mcp",
    servers: [
      {
        name: "pennylane",
        url: "https://mcp.pennylane.com/mcp",
        scopes: ["mcp:company:read", "mcp:customer_invoice:read", "mcp:supplier_invoice:read", "mcp:transaction:read", "mcp:financial_report:read"],
      }
    ],
    prerequisites: [msg("Accounting firms can use the service without an extra charge; companies need the Essentiel plan or higher."), msg("Connect your Pennylane account; access follows your company or firm permissions and remains read-only.")],
    reviewBy: "2027-01-31",
  },
  // INFERRED reduced CRM scope union from live metadata. No admin, mail sending, custom-field write or product/project permissions are requested. Registration endpoint is published but its admission policy has not been exercised.
  {
    id: "pipedrive",
    vendor: "pipedrive",
    name: "Pipedrive",
    description: msg("Find and update deals and contacts, create activities, and review your sales pipeline."),
    area: "crm",
    icon: "https://www.pipedrive.com/favicon.ico",
    docs: "https://www.pipedrive.com/en/features/mcp-server",
    servers: [
      {
        name: "pipedrive",
        url: "https://mcp.pipedrive.ai/mcp",
        scopes: ["base", "search:read", "deals:full", "contacts:full", "activities:full"],
      }
    ],
    prerequisites: [msg("Available on every Pipedrive plan; usage consumes the plan's MCP token allowance, with extra tokens available to purchase."), msg("Connect your account; company administrators may disable MCP and your existing CRM permissions apply.")],
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED generic merchant-client onboarding and tool scope minimum. Live setup.shopify.com metadata is real, but the public developer toolkit is not proof of arbitrary merchant client admission. No scope set is fabricated. scopes is intentionally absent, not an assertion that no permission is needed.
  {
    id: "shopify",
    vendor: "shopify",
    name: "Shopify",
    description: msg("Work with store information and supported merchant tasks after Shopify approves this connection."),
    area: "work",
    icon: "https://shopify.dev/favicon.ico",
    docs: "https://shopify.dev/docs/apps/build/ai-toolkit",
    servers: [
      {
        name: "shopify",
        url: "https://setup.shopify.com/mcp",
      }
    ],
    prerequisites: [msg("A Shopify store and vendor-approved MCP client are required.")],
    notYet: msg("Not available yet: Shopify must approve this client and confirm its merchant sign-in setup."),
    reviewBy: "2027-01-31",
  },
  {
    id: "figma",
    vendor: "figma",
    name: "Figma",
    description: msg("Read design context and assets to help turn Figma designs into code."),
    area: "design",
    icon: "https://www.figma.com/favicon.ico",
    docs: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    servers: [
      {
        name: "figma",
        url: "https://mcp.figma.com/mcp",
        scopes: ["mcp:connect"],
      }
    ],
    prerequisites: [msg("Figma must list the client in its MCP catalog; new clients must join the waitlist."), msg("Tool limits and available features depend on your Figma plan and seat.")],
    notYet: msg("Not available yet: Figma must admit Baskule to its MCP client catalog."),
    reviewBy: "2027-01-31",
  },
  // UNVERIFIED minimum tool scopes and production onboarding. Resource metadata names mcp.docusign.com; its AS document declares account.docusign.com. Do not disable issuer validation or substitute a demo account.
  {
    id: "docusign",
    vendor: "docusign",
    name: "Docusign",
    description: msg("Find agreements and prepare supported e-signature workflows after sign-in is qualified."),
    area: "work",
    icon: "https://www.docusign.com/favicon.ico",
    docs: "https://developers.docusign.com/platform/mcp-server/",
    servers: [
      {
        name: "docusign",
        url: "https://mcp.docusign.com/mcp",
        scopes: ["signature", "adm_store_unified_repo_read"],
      }
    ],
    prerequisites: [msg("An administrator needs a Docusign integration key, callback and permissions; production and developer accounts are separate.")],
    notYet: msg("Not available yet: Docusign's production sign-in metadata names conflicting issuers."),
    reviewBy: "2027-01-31",
  },
];

export const catalogService = (id: string) => CATALOG.find(service => service.id === id);
export const catalogVendor = (id: string) => CATALOG_VENDORS.find(vendor => vendor.id === id);
