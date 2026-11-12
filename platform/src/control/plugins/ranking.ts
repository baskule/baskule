// Category, recommendation and ranking tables adapted from Rakazo (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { CatalogEntry, PluginCategory } from "../../../../app/packages/contracts/src/baskule-plugins";

/** Registries use their own coarse labels; these are the ones that already say what a plugin is for. */
const REGISTRY_CATEGORIES: Record<string, PluginCategory> = {
  productivity: "productivity", development: "code", "developer-tools": "code", deployment: "ops", monitoring: "ops",
  observability: "ops", security: "ops", database: "data", media: "design", design: "design", marketing: "marketing",
  finance: "finance",
};

const NAMED_CATEGORIES: Record<PluginCategory, readonly string[]> = {
  productivity: ["google-drive", "google-calendar", "google-docs", "google-sheets", "google-slides", "outlook-calendar", "onedrive",
    "sharepoint", "todoist", "calendly", "calcom", "smartsheet", "wrike", "coda", "guru", "craft", "mem", "readwise", "trello", "lark",
    "feishu", "zoom", "fireflies", "otter", "fathom", "circleback", "plaud", "docusign", "typeform", "jotform", "gamma", "quo",
    "productivity", "product-management", "enterprise-search", "small-business", "legal"],
  communication: ["gmail", "outlook", "teams", "whatsapp-business", "ringcentral-phone", "ringcentral-chat", "intercom", "zoho-desk", "x", "stable",
    "customer-support"],
  sales: ["sales", "salesforce", "salesforce-headless-360", "hubspot", "gong", "clay", "outreach", "amplemarket", "attio", "hunter", "zoho-crm",
    "highlevel", "pitchbook", "shopify-store", "jobber"],
  marketing: ["google-ads", "klaviyo", "customer-io", "mailerlite", "brevo", "semrush", "ahrefs", "similarweb", "x-ads", "meta-ads",
    "tiktok-for-business", "buffer", "beehiiv", "meltwater", "profound", "helena", "omneky", "godaddy", "marketing", "brand-voice"],
  finance: ["stripe", "navan", "brex", "xero", "finance", "webull", "sp-global", "interactive-brokers", "daloopa", "robinhood", "coinbase",
    "etoro-trading", "x-money", "quickbooks-online", "zoho-books", "square", "finary"],
  people: ["human-resources", "ashby", "greenhouse", "juicebox", "upwork", "workable", "workday", "gusto"],
  design: ["figma", "framer", "excalidraw", "canva", "videogen", "html-css-to-image", "design"],
  code: ["github", "playwright", "engineering"],
  data: ["data", "google-cloud-bigquery", "power-bi", "databricks-genie-one", "posthog-mcp", "statsig"],
  ops: ["vanta", "tailscale", "servicenow", "operations"],
};
const CATEGORY_BY_NAME = new Map(Object.entries(NAMED_CATEGORIES).flatMap(([category, names]) => names.map(name => [name, category as PluginCategory])));

/** Brands people look for first; plugins outside this list follow in catalog quality order. */
const RECOMMENDED = ["github", "stripe", "vercel", "figma", "hubspot", "salesforce", "sentry", "supabase", "calcom", "zoom", "datadog",
  "attio", "intercom", "cloudflare", "neon", "docusign"];
const RECOMMENDED_RANK = new Map(RECOMMENDED.map((name, index) => [name, index]));

export function pluginCategory(name: string, label: string | null): PluginCategory | null {
  return CATEGORY_BY_NAME.get(name) ?? (label ? REGISTRY_CATEGORIES[label.toLowerCase()] : undefined) ?? null;
}

export const isRecommended = (name: string) => RECOMMENDED_RANK.has(name);

const quality = (entry: Pick<CatalogEntry, "logo" | "description">) => (entry.logo ? 0 : 2) + (entry.description ? 0 : 1);

export function comparePlugins(a: Pick<CatalogEntry, "id" | "name" | "displayName" | "logo" | "description">, b: typeof a): number {
  const recommended = (RECOMMENDED_RANK.get(a.name) ?? RECOMMENDED.length) - (RECOMMENDED_RANK.get(b.name) ?? RECOMMENDED.length);
  return recommended || quality(a) - quality(b) || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
}

/** "Apollo", "Apollo.io" and "Apollo Skills" are one brand; so are "Atlassian" and "Atlassian MCP". */
export const brandKey = (name: string) =>
  name.toLowerCase().replace(/\.(io|com|ai|app)\b/g, "").replace(/\b(plugins?|skills|mcp|server)\b/g, "").replace(/[^a-z0-9]/g, "");

export function displayName(name: string): string {
  return name.split(/[-_\s]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}
