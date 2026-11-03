import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** `openai` (key-pool upstream) or `opencode` (free tier, no API key). */
    kind: text("kind").notNull().default("openai"),
    baseUrl: text("base_url").notNull(),
    extraHeaders: text("extra_headers"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastSyncedAt: integer("last_synced_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("providers_name_unique").on(table.name)],
);

export const providerKeys = sqliteTable(
  "provider_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    keyPreview: text("key_preview").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    cooldownUntil: integer("cooldown_until"),
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("provider_keys_provider_enabled_idx").on(
      table.providerId,
      table.enabled,
    ),
  ],
);

/**
 * Where an OpenCode provider's requests leave from. `entries` is a JSON array of
 * `{ id, label, url, enabled, weight }`; an empty `url` is the direct entry.
 */
export const providerEgress = sqliteTable("provider_egress", {
  providerId: integer("provider_id")
    .primaryKey()
    .references(() => providers.id, { onDelete: "cascade" }),
  strategy: text("strategy").notNull().default("round-robin"),
  entries: text("entries").notNull().default("[]"),
  relayUrl: text("relay_url"),
  updatedAt: integer("updated_at").notNull(),
});

/** Cooldown bookkeeping per egress entry, keyed by a hash of the proxy URL. */
export const egressHealth = sqliteTable(
  "egress_health",
  {
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    egressKey: text("egress_key").notNull(),
    failures: integer("failures").notNull().default(0),
    cooldownUntil: integer("cooldown_until").notNull().default(0),
    lastError: text("last_error"),
    lastOkAt: integer("last_ok_at"),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.egressKey] })],
);

export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    upstreamId: text("upstream_id").notNull(),
    publicId: text("public_id").notNull(),
    displayName: text("display_name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    notes: text("notes"),
    upstreamCreatedAt: integer("upstream_created_at"),
    upstreamOwnedBy: text("upstream_owned_by"),
    upstreamAvailable: integer("upstream_available", { mode: "boolean" })
      .notNull()
      .default(true),
    syncedDisplayName: text("synced_display_name"),
    syncedContextWindow: integer("synced_context_window"),
    syncedMaxOutputTokens: integer("synced_max_output_tokens"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("models_public_id_unique").on(table.publicId),
    uniqueIndex("models_provider_upstream_unique").on(
      table.providerId,
      table.upstreamId,
    ),
    index("models_enabled_public_id_idx").on(table.enabled, table.publicId),
  ],
);

export const clientKeys = sqliteTable(
  "client_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    limitWindow: text("limit_window", { enum: ["total", "day", "month"] })
      .notNull()
      .default("total"),
    limitTokens: integer("limit_tokens"),
    limitRequests: integer("limit_requests"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    /** The most recent failed request signed with this key. */
    lastErrorStatus: integer("last_error_status"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: integer("last_error_at"),
  },
  (table) => [uniqueIndex("client_keys_key_hash_unique").on(table.keyHash)],
);

export const usageLogs = sqliteTable(
  "usage_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id").notNull(),
    clientKeyId: integer("client_key_id").references(() => clientKeys.id, {
      onDelete: "set null",
    }),
    clientKeyLabel: text("client_key_label").notNull(),
    providerId: integer("provider_id").references(() => providers.id, {
      onDelete: "set null",
    }),
    providerName: text("provider_name").notNull(),
    providerKeyId: integer("provider_key_id").references(
      () => providerKeys.id,
      {
        onDelete: "set null",
      },
    ),
    modelId: integer("model_id").references(() => models.id, {
      onDelete: "set null",
    }),
    modelPublicId: text("model_public_id").notNull().default(""),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    streamed: integer("streamed", { mode: "boolean" }).notNull().default(false),
    status: integer("status").notNull(),
    errorCode: text("error_code"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    estimated: integer("estimated", { mode: "boolean" })
      .notNull()
      .default(false),
    latencyMs: integer("latency_ms").notNull(),
    upstreamLatencyMs: integer("upstream_latency_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("usage_logs_created_at_idx").on(table.createdAt),
    index("usage_logs_client_key_created_at_idx").on(
      table.clientKeyId,
      table.createdAt,
    ),
    index("usage_logs_provider_created_at_idx").on(
      table.providerId,
      table.createdAt,
    ),
    index("usage_logs_model_created_at_idx").on(table.modelId, table.createdAt),
  ],
);

export type ProviderRow = typeof providers.$inferSelect;
export type ProviderInsert = typeof providers.$inferInsert;
export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type ProviderKeyInsert = typeof providerKeys.$inferInsert;
export type ModelRow = typeof models.$inferSelect;
export type ModelInsert = typeof models.$inferInsert;
export type ClientKeyRow = typeof clientKeys.$inferSelect;
export type ClientKeyInsert = typeof clientKeys.$inferInsert;
export type UsageLogRow = typeof usageLogs.$inferSelect;
export type UsageLogInsert = typeof usageLogs.$inferInsert;
export type ProviderEgressRow = typeof providerEgress.$inferSelect;
export type EgressHealthRow = typeof egressHealth.$inferSelect;

export { sql };
