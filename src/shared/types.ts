export type LimitWindow = "total" | "day" | "month";

export type KeyStatus = "active" | "cooling" | "disabled";

export type ProviderDTO = {
  id: number;
  name: string;
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
  };
  today: { requests: number; totalTokens: number };
  series: { bucket: string; requests: number; totalTokens: number }[];
  byModel: {
    label: string;
    provider: string;
    requests: number;
    totalTokens: number;
  }[];
  byProvider: { label: string; requests: number; totalTokens: number }[];
  byClientKey: {
    label: string;
    prefix: string;
    requests: number;
    totalTokens: number;
  }[];
  recent: {
    requestId: string;
    createdAt: number;
    endpoint: string;
    method: string;
    model: string;
    provider: string;
    clientKey: string;
    status: number;
    streamed: boolean;
    estimated: boolean;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
  }[];
};

export type AdminErrorBody = { error: { message: string; code?: string } };

export type HealthResponse = { ok: true };
