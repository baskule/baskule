import { z } from "zod";

const object = z.record(z.string(), z.json());
const provider = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["social", "oidc"]),
  // Better Auth's JSON-compatible provider options; executable callbacks are deliberately excluded.
  options: object,
}).strict();

export const authConfigSchema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(["authenticated", "anonymous"]).default("authenticated"),
  publicOrigin: z.url({ protocol: /^https$/ }).refine(value => /^https:\/\/[^/?#@\\\s]+\/?$/i.test(value))
    .transform(value => new URL(value).origin).optional(),
  password: z.boolean().default(true),
  providers: z.array(provider).max(30).default([]),
  trustedProviders: z.array(z.string()).default([]),
}).strict().superRefine((cfg, ctx) => {
  const ids = cfg.providers.map(p => p.id);
  if (new Set(ids).size !== ids.length || ids.includes("credential"))
    ctx.addIssue({ code: "custom", message: "Provider IDs must be unique and cannot be credential" });
  if (cfg.mode === "authenticated" && !cfg.password && !ids.length)
    ctx.addIssue({ code: "custom", message: "Enable password login or at least one provider" });
  if (cfg.mode === "anonymous" && (ids.length || cfg.trustedProviders.length))
    ctx.addIssue({ code: "custom", message: "Anonymous mode cannot configure identity providers" });
  if (cfg.trustedProviders.some(id => !ids.includes(id)))
    ctx.addIssue({ code: "custom", message: "Trusted providers must be configured providers" });
  for (const p of cfg.providers) {
    if (p.type === "social" && p.id === "google" && "hd" in p.options)
      ctx.addIssue({ code: "custom", message: "Configure Google signup domains in the admin Authentication settings, not provider options.hd" });
    const clientId = p.options.clientId;
    if (!(typeof clientId === "string" && clientId) && !(p.type === "social" && Array.isArray(clientId) && clientId.length && clientId.every(id => typeof id === "string" && id)))
      ctx.addIssue({ code: "custom", message: `Provider ${p.id} requires clientId` });
    if (p.type === "oidc" && typeof p.options.discoveryUrl !== "string")
      ctx.addIssue({ code: "custom", message: `OIDC provider ${p.id} requires discoveryUrl` });
    if (["disableSignUp", "disableImplicitSignUp", "providerId", "requireIdTokenVerification"].some(k => k in p.options))
      ctx.addIssue({ code: "custom", message: `Provider ${p.id}: admission and provider identity are managed by Baskule` });
  }
});

export type InstallationAuth = z.infer<typeof authConfigSchema>;

export function parseAuthConfig(raw?: string): InstallationAuth {
  // Never include raw config or validation values in an error: it may contain provider secrets.
  let value: unknown;
  try { value = JSON.parse(raw || "{}"); }
  catch { throw new Error("Invalid installation authentication JSON"); }
  const result = authConfigSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid installation authentication configuration: ${result.error.issues.map(i => i.path.join(".") || "authentication").join(", ")}`);
  return result.data;
}

export function publicAuthConfig(cfg: InstallationAuth) {
  return { mode: cfg.mode, password: cfg.mode === "authenticated" && cfg.password,
    providers: cfg.providers.map(({ id, name, type }) => ({ id, name, type })) };
}
