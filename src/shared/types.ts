export type LimitWindow = "total" | "day" | "month";

export type KeyStatus = "active" | "cooling" | "disabled";

export type ProviderKind = "openai" | "opencode";

export type ProviderDTO = {
  id: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  extraHeaders: Record<string, string> | null;
  enabled: boolean;
  lastSyncedAt: number | null;
  createdAt: number;
  updatedAt: number;
  keyCount: number;
  modelCount: number;
  keyStatusCounts: { active: number; cooling: number; disabled: number };
};

export type EgressEntryDTO = {
  id: string;
  label: string;
  /** `host:port` of the proxy, or null for the direct entry. Credentials and paths never leave the server. */
  host: string | null;
  direct: boolean;
  enabled: boolean;
  weight: number;
  failures: number;
  cooling: boolean;
  cooldownUntil: number | null;
  lastError: string | null;
  lastOkAt: number | null;
  lastUsedAt: number | null;
};

export type EgressPoolDTO = {
  strategy: "round-robin" | "failover" | "random";
  relayHost: string | null;
  active: boolean;
  entries: EgressEntryDTO[];
};

export type EgressEntryUpdate = {
  id?: string;
  label?: string;
  url?: string;
  enabled?: boolean;
  weight?: number;
};

export type EgressPoolUpdate = {
  strategy?: EgressPoolDTO["strategy"];
  relayUrl?: string | null;
  entries?: EgressEntryUpdate[];
};

export type EgressTestResult = {
  id: string;
  label: string;
  host: string | null;
  skipped?: true;
  ok?: boolean;
  status?: number | null;
  exitIp?: string | null;
  latencyMs?: number | null;
  error?: string | null;
};

export type OpenCodeIdentityDTO = {
  version: string;
  channel: string;
  source: "static" | "update-api" | "atom-feed";
  sha: string | null;
  userAgent: string;
  sessionPrefix: string;
  sessionLength: number;
  chatUrl: string;
  fetchedAt: number | null;
  catalogFetchedAt: number | null;
  availableVersion: string | null;
  lastError: string | null;
  catalogError: string | null;
  refreshInFlight: boolean;
};

export type OpenCodeGateDTO = {
  status: "open" | "throttled" | "ip-blocked";
  throttledUntil: number | null;
  lastRejection: {
    at: number;
    kind: "free-tier-gate" | "ip-abuse";
    status: number;
    logId: string | null;
    shapeOk: boolean;
    missing: string[];
    model: string;
  } | null;
};

export type OpenCodeProviderDTO = {
  identity: OpenCodeIdentityDTO;
  gate: OpenCodeGateDTO;
  egress: EgressPoolDTO;
};

export type ProviderKeyDTO = {
  id: number;
  providerId: number;
  label: string;
  keyPreview: string;
  enabled: boolean;
  status: KeyStatus;
  cooldownUntil: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ModelDTO = {
  id: number;
  providerId: number;
  providerName: string;
  upstreamId: string;
  publicId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  notes: string | null;
  upstreamCreatedAt: number | null;
  upstreamOwnedBy: string | null;
  upstreamAvailable: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ProviderDetailDTO = ProviderDTO & {
  keys: ProviderKeyDTO[];
  models: ModelDTO[];
  /** Present only for `opencode` providers. */
  opencode?: OpenCodeProviderDTO;
};

/** The most recent failed request signed with a client key. */
export type ClientKeyError = {
  status: number;
  message: string;
  at: number;
};

export type ClientKeyDTO = {
  id: number;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  limitWindow: LimitWindow;
  limitTokens: number | null;
  limitRequests: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastError: ClientKeyError | null;
  usage: { requests: number; tokens: number; windowStart: number | null };
};

export type ClientKeyCreatedDTO = ClientKeyDTO & { key: string };

export type UsageRow = {
  id: number;
  requestId: string;
  clientKeyId: number | null;
  clientKeyLabel: string;
  providerId: number | null;
  providerName: string;
  providerKeyId: number | null;
  modelId: number | null;
  modelPublicId: string;
  endpoint: string;
  method: string;
  streamed: boolean;
  status: number;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  latencyMs: number;
  upstreamLatencyMs: number | null;
  createdAt: number;
};

export type UsagePage = {
  rows: UsageRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type SyncField = "displayName" | "contextWindow" | "maxOutputTokens";

export type SyncPreview = {
  providerId: number;
  fetchedAt: number;
  added: {
    upstreamId: string;
    suggestedPublicId: string;
    aliasConflict: boolean;
    upstream: {
      displayName?: string;
      contextWindow?: number;
      maxOutputTokens?: number;
    };
  }[];
  matched: { modelId: number; publicId: string; changedFields: SyncField[] }[];
  missing: {
    modelId: number;
    upstreamId: string;
    publicId: string;
    currentUpstreamAvailable: boolean;
  }[];
  conflicts: {
    modelId: number;
    publicId: string;
    field: SyncField;
    local: string | number | null;
    upstream: string | number;
    synced: string | number | null;
  }[];
};

export type SyncApplyBody = {
  added?: { upstreamId: string; publicId: string }[];
  missing?: { modelId: number; action: "keep" | "disable" | "delete" }[];
  resolutions?: {
    modelId: number;
    field: SyncField;
    choice: "local" | "upstream";
  }[];
};

export type StatsRange = "24h" | "7d" | "30d" | "all";

export type StatsResponse = {
  generatedAt: number;
  range: StatsRange;
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedRequests: number;
    errors: number;
    averageCompletionTokens: number;
  };
  today: { requests: number; totalTokens: number };
  series: { bucket: string; requests: number; totalTokens: number }[];
  /** Model IDs routeable through this proxy. No provider names. */
  byModel: { label: string; requests: number; totalTokens: number }[];
};

/** A model the playground may send to, enabled end to end. */
export type PlaygroundModelDTO = {
  publicId: string;
  providerName: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  providerKind: ProviderKind;
};

export type PlaygroundMessageRole = "system" | "user" | "assistant";

/**
 * The text result of one playground run. `content` is the text as it was
 * streamed, so an aborted run still shows what arrived.
 */
export type PlaygroundResult = {
  status: number;
  content: string;
  error: string | null;
  streamed: boolean;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  requestId: string | null;
  latencyMs: number;
};

export type AdminErrorBody = { error: { message: string; code?: string } };

export type HealthResponse = { ok: true };
