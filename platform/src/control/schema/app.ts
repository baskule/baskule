// Baskule-owned tables in ControlCell (E6). Better Auth's own tables are in ./auth.ts.
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, primaryKey, check } from "drizzle-orm/sqlite-core";
import { user, session } from "./auth";

/** One organisation per installation in 0.2; the model allows several. */
export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Per-user Baskule state that Better Auth does not model. */
export const userProfile = sqliteTable("user_profile", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /** Set on the first session ever created; admin set-password is refused afterwards (review M7). */
  firstSignInAt: integer("first_sign_in_at", { mode: "timestamp_ms" }),
});

export const space = sqliteTable(
  "space",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["personal", "team"] }).notNull(),
    name: text("name").notNull(),
    /** Personal spaces only: the one person who may ever be a member (enforced by CHECK + triggers). */
    personalUserId: text("personal_user_id").unique().references(() => user.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("space_org_idx").on(t.organizationId),
    check("space_kind_ck", sql`${t.kind} in ('personal','team')`),
    check("space_personal_ck", sql`(${t.kind} = 'personal') = (${t.personalUserId} is not null)`),
  ],
);

export const spaceMember = sqliteTable(
  "space_member",
  {
    spaceId: text("space_id").notNull().references(() => space.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index("space_member_user_idx").on(t.userId),
    check("space_member_role_ck", sql`${t.role} in ('owner','member')`),
  ],
);

/** Admin invitations (review H7): 256-bit token stored as SHA-256 hex, single use, email-bound, expiring. */
export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
    /** JSON array of {spaceId, role} granted on acceptance. */
    spaces: text("spaces").notNull().default("[]"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    acceptedUserId: text("accepted_user_id"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);

/** Last status reported by the SpaceCell (`/_baskule/status`), a cache for the admin overview. */
export const spaceRuntime = sqliteTable("space_runtime", {
  spaceId: text("space_id").primaryKey().references(() => space.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // JSON SpaceStatus
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
});

/** Small key/value store (the generated auth secret, the bootstrap marker). */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** No foreign keys: billed history survives deletion of an alpha user or space. */
export const usageRecord = sqliteTable("usage_record", {
  spaceId: text("space_id").notNull(), messageId: text("message_id").notNull(),
  occurredAt: integer("occurred_at").notNull(), record: text("record").notNull(),
}, t => [primaryKey({ columns: [t.spaceId, t.messageId] }), index("usage_record_time_idx").on(t.occurredAt)]);

export const usageDaily = sqliteTable("usage_daily", {
  date: text("date").notNull(), userId: text("user_id").notNull(), provider: text("provider").notNull(),
  model: text("model").notNull(), spaceId: text("space_id").notNull(),
  tokens: integer("tokens").notNull(), costUsd: real("cost_usd").notNull(), turns: integer("turns").notNull(),
}, t => [primaryKey({ columns: [t.date, t.userId, t.provider, t.model, t.spaceId] }), index("usage_daily_user_date_idx").on(t.userId, t.date)]);

/** Permanent turn identities keep chat/turn counts exact after raw retention expires. */
export const usageTurn = sqliteTable("usage_turn", {
  spaceId: text("space_id").notNull(), turnId: text("turn_id").notNull(), userId: text("user_id").notNull(),
  chatId: text("chat_id").notNull(), date: text("date").notNull(),
}, t => [primaryKey({ columns: [t.spaceId, t.turnId] }), index("usage_turn_date_idx").on(t.date)]);

export const plugin = sqliteTable("plugin", {
  id: text("id").primaryKey(),
  definition: text("definition").notNull(), // JSON Plugin, never credentials
  skillFiles: text("skill_files").notNull(), // JSON SpacePlugins.skills (base64 files)
  storedBytes: integer("stored_bytes").notNull(),
});

export const group = sqliteTable("permission_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  builtin: text("builtin", { enum: ["everyone"] }).unique(),
  canCreateSpaces: integer("can_create_spaces", { mode: "boolean" }).notNull().default(false),
});

export const groupMember = sqliteTable("group_member", {
  groupId: text("group_id").notNull().references(() => group.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.groupId, t.userId] }), index("group_member_user_idx").on(t.userId)]);

export const groupPlugin = sqliteTable("group_plugin", {
  groupId: text("group_id").notNull().references(() => group.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull().references(() => plugin.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.groupId, t.pluginId] })]);

export const pluginSecret = sqliteTable("plugin_secret", {
  pluginId: text("plugin_id").notNull().references(() => plugin.id, { onDelete: "cascade" }),
  server: text("server").notNull(),
  data: text("data").notNull(),
}, t => [primaryKey({ columns: [t.pluginId, t.server] })]);

export const spacePluginSettings = sqliteTable("space_plugin_settings", {
  spaceId: text("space_id").primaryKey().references(() => space.id, { onDelete: "cascade" }),
  personalPluginsAllowed: integer("personal_plugins_allowed", { mode: "boolean" }).notNull().default(false),
});

export const spaceDisabledPlugin = sqliteTable("space_disabled_plugin", {
  spaceId: text("space_id").notNull().references(() => space.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull().references(() => plugin.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.spaceId, t.pluginId] })]);

/** Encrypted per-user credentials. No plaintext token migration: deploying 0.4.0 wipes alpha data. */
export const pluginConnection = sqliteTable("plugin_connection", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull().references(() => plugin.id, { onDelete: "cascade" }),
  server: text("server").notNull(),
  data: text("data").notNull(),
}, t => [primaryKey({ columns: [t.userId, t.pluginId, t.server] })]);

export const vendorSetup = sqliteTable("vendor_setup", {
  vendor: text("vendor").primaryKey(),
  data: text("data").notNull(),
});

export const pluginOAuthState = sqliteTable("plugin_oauth_state", {
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull().references(() => plugin.id, { onDelete: "cascade" }),
  server: text("server").notNull(),
  data: text("data").notNull(),
  consumed: integer("consumed").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
}, t => [index("plugin_oauth_state_expiry_idx").on(t.expiresAt)]);

export const pushDevice = sqliteTable("push_device", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  tokenKey: text("token_key").notNull().unique(),
  tokenVersion: text("token_version").notNull(),
  registration: text("registration").notNull(),
}, t => [index("push_device_user_idx").on(t.userId)]);

export const pushReceipt = sqliteTable("push_receipt", {
  spaceId: text("space_id").notNull().references(() => space.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  deviceId: text("device_id").notNull().references(() => pushDevice.id, { onDelete: "cascade" }),
  tokenVersion: text("token_version").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, t => [primaryKey({ columns: [t.spaceId, t.eventId, t.deviceId, t.tokenVersion] })]);
