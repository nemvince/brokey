import type {
  ClientKeyDTO,
  LimitWindow,
  ModelDTO,
  ProviderDTO,
  ProviderKeyDTO,
  UsageRow,
} from "../../shared/types.ts";
import type {
  ClientKeyRow,
  ModelRow,
  ProviderKeyRow,
  ProviderRow,
  UsageLogRow,
} from "../schema.ts";
import type { WindowUsage } from "../proxy/limits.ts";
import { providerKeyStatus } from "../proxy/keys.ts";

export type ProviderCounts = {
  keyCount: number;
  modelCount: number;
  active: number;
  cooling: number;
  disabled: number;
};

export function parseExtraHeaders(
  raw: string | null,
): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through: treat a corrupt value as absent
  }
  return null;
}

export function toProviderDTO(
  row: ProviderRow,
  counts: ProviderCounts,
): ProviderDTO {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "opencode" ? "opencode" : "openai",
    baseUrl: row.baseUrl,
    extraHeaders: parseExtraHeaders(row.extraHeaders),
    enabled: row.enabled,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    keyCount: counts.keyCount,
    modelCount: counts.modelCount,
    keyStatusCounts: {
      active: counts.active,
      cooling: counts.cooling,
      disabled: counts.disabled,
    },
  };
}

export function toProviderKeyDTO(
  row: ProviderKeyRow,
  now = Date.now(),
): ProviderKeyDTO {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    keyPreview: row.keyPreview,
    enabled: row.enabled,
    status: providerKeyStatus(row, now),
    cooldownUntil: row.cooldownUntil,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toModelDTO(row: ModelRow, providerName: string): ModelDTO {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName,
    upstreamId: row.upstreamId,
    publicId: row.publicId,
    displayName: row.displayName,
    enabled: row.enabled,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    notes: row.notes,
    upstreamCreatedAt: row.upstreamCreatedAt,
    upstreamOwnedBy: row.upstreamOwnedBy,
    upstreamAvailable: row.upstreamAvailable,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toClientKeyDTO(
  row: ClientKeyRow,
  usage: WindowUsage,
): ClientKeyDTO {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    enabled: row.enabled,
    limitWindow: row.limitWindow as LimitWindow,
    limitTokens: row.limitTokens,
    limitRequests: row.limitRequests,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    usage,
  };
}

export function toUsageRow(row: UsageLogRow): UsageRow {
  return {
    id: row.id,
    requestId: row.requestId,
    clientKeyId: row.clientKeyId,
    clientKeyLabel: row.clientKeyLabel,
    providerId: row.providerId,
    providerName: row.providerName,
    providerKeyId: row.providerKeyId,
    modelId: row.modelId,
    modelPublicId: row.modelPublicId,
    endpoint: row.endpoint,
    method: row.method,
    streamed: row.streamed,
    status: row.status,
    errorCode: row.errorCode,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    estimated: row.estimated,
    latencyMs: row.latencyMs,
    upstreamLatencyMs: row.upstreamLatencyMs,
    createdAt: row.createdAt,
  };
}
