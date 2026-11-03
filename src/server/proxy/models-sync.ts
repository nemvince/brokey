import { eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import {
  models,
  type ModelRow,
  type ProviderRow,
  providers,
} from "../schema.ts";
import { HttpError } from "../errors.ts";
import type {
  SyncApplyBody,
  SyncField,
  SyncPreview,
} from "../../shared/types.ts";
import type { OpenCodeRuntime } from "./opencode/runtime.ts";
import {
  classifyHttpFailure,
  networkFailure,
  recordKeyFailure,
  recordKeySuccess,
  redactSecret,
  selectCandidates,
  upstreamUrl,
} from "./keys.ts";

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_MODELS_BODY_BYTES = 8 * 1024 * 1024;

export type UpstreamModel = {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  upstreamCreatedAt?: number;
  upstreamOwnedBy?: string;
};

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return Math.round(value);
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function normalizeUpstreamModel(raw: unknown): UpstreamModel | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = nonEmptyString(item.id);
  if (!id) return null;

  const topProvider =
    item.top_provider && typeof item.top_provider === "object"
      ? (item.top_provider as Record<string, unknown>)
      : undefined;

  const created = item.created;
  return {
    id,
    displayName: nonEmptyString(item.name),
    contextWindow: firstPositive(item.context_length, item.context_window),
    maxOutputTokens: firstPositive(
      topProvider?.max_completion_tokens,
      item.max_completion_tokens,
      item.max_output_tokens,
    ),
    upstreamCreatedAt:
      typeof created === "number" && Number.isFinite(created) && created >= 0
        ? Math.round(created)
        : undefined,
    upstreamOwnedBy: nonEmptyString(item.owned_by),
  };
}

export function normalizeUpstreamList(payload: unknown): UpstreamModel[] {
  let items: unknown[] | null = null;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray(payload.data)
  ) {
    items = payload.data;
  }
  if (!items) throw new HttpError(502, "Upstream did not return a model list.");

  const byId = new Map<string, UpstreamModel>();
  for (const item of items) {
    const normalized = normalizeUpstreamModel(item);
    if (normalized && !byId.has(normalized.id))
      byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export async function fetchUpstreamModels(
  provider: ProviderRow,
  db: AppDb,
  now = Date.now(),
  opencode?: OpenCodeRuntime,
): Promise<UpstreamModel[]> {
  // The free tier has no keys to rotate and no `/v1/models` of its own: the
  // model list is the catalog the CLI reads at boot.
  if (provider.kind === "opencode" && opencode) {
    try {
      return await opencode.freeModels(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `OpenCode catalog is unreachable: ${message}`);
    }
  }
  const pool = selectCandidates(db, provider.id, now);
  if (!pool.hasEnabledKeys) {
    throw new HttpError(
      400,
      `Provider "${provider.name}" has no enabled API keys.`,
    );
  }
  if (pool.candidates.length === 0) {
    const wait = pool.earliestCooldown
      ? Math.max(1, Math.ceil((pool.earliestCooldown - now) / 1000))
      : 60;
    throw new HttpError(
      429,
      `All API keys for this provider are cooling down. Try again in ${wait}s.`,
    );
  }

  const extra = provider.extraHeaders
    ? (JSON.parse(provider.extraHeaders) as Record<string, string>)
    : {};
  const url = upstreamUrl(provider.baseUrl, "/v1/models", "");
  let lastMessage = "No provider key could reach the upstream.";

  for (const key of pool.candidates) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key.secret}`,
          ...extra,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastMessage = `Upstream request failed: ${message}`;
      recordKeyFailure(db, key.id, networkFailure(), lastMessage, now);
      continue;
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_MODELS_BODY_BYTES
    ) {
      throw new HttpError(
        502,
        `Upstream model list is too large (${declaredLength} bytes).`,
      );
    }
    const text = await response.text();
    if (text.length > MAX_MODELS_BODY_BYTES) {
      throw new HttpError(502, "Upstream model list is too large.");
    }
    if (response.ok) {
      recordKeySuccess(db, key.id, now);
      try {
        return normalizeUpstreamList(JSON.parse(text));
      } catch {
        throw new HttpError(
          502,
          `Upstream model list is not valid JSON (status ${response.status}).`,
        );
      }
    }

    // Upstream error bodies can echo the credential back; scrub it first.
    const safeText = redactSecret(text, key.secret);
    const failure = classifyHttpFailure(
      response.status,
      safeText,
      response.headers.get("retry-after"),
      now,
    );
    if (!failure.retryable) {
      throw new HttpError(
        502,
        `Upstream returned ${response.status} for ${url}: ${extractUpstreamMessage(safeText)}`,
      );
    }
    lastMessage = `Upstream returned ${response.status}: ${extractUpstreamMessage(safeText)}`;
    recordKeyFailure(db, key.id, failure, lastMessage, now);
  }

  throw new HttpError(502, lastMessage);
}

function extractUpstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim() !== "")
      return message.slice(0, 300);
  } catch {
    // fall through to the raw body
  }
  return text.slice(0, 300) || "no body";
}

export function sanitizePublicId(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._:/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._:/]+/, "")
    .replace(/[-._:/]+$/, "")
    .slice(0, 128);
  return sanitized;
}

export type MergeResult<T> =
  | { kind: "none" }
  | { kind: "noop" }
  | { kind: "adopt"; value: T }
  | { kind: "conflict"; local: T | null; upstream: T };

export function mergeField<T>(
  local: T | null,
  synced: T | null,
  upstream: T | null | undefined,
): MergeResult<T> {
  if (upstream === null || upstream === undefined) return { kind: "none" };
  if (local === upstream) return { kind: "noop" };
  if (synced === null || synced === undefined) {
    if (local === null || local === undefined)
      return { kind: "adopt", value: upstream };
    return { kind: "conflict", local, upstream };
  }
  if (local === synced) return { kind: "adopt", value: upstream };
  if (upstream === synced) return { kind: "none" };
  return { kind: "conflict", local, upstream };
}

type ModelFieldValues = {
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
};

function localFields(row: ModelRow): ModelFieldValues {
  return {
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
  };
}

function syncedFields(row: ModelRow): ModelFieldValues {
  return {
    displayName: row.syncedDisplayName,
    contextWindow: row.syncedContextWindow,
    maxOutputTokens: row.syncedMaxOutputTokens,
  };
}

function upstreamFields(model: UpstreamModel): Partial<ModelFieldValues> {
  const values: Partial<ModelFieldValues> = {};
  if (model.displayName !== undefined) values.displayName = model.displayName;
  if (model.contextWindow !== undefined)
    values.contextWindow = model.contextWindow;
  if (model.maxOutputTokens !== undefined)
    values.maxOutputTokens = model.maxOutputTokens;
  return values;
}

const SYNC_FIELDS: SyncField[] = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
];

export function buildPreview(
  db: AppDb,
  provider: ProviderRow,
  upstreamModels: UpstreamModel[],
  fetchedAt = Date.now(),
): SyncPreview {
  const localRows = db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
    .all();
  const allPublicIds = new Set(
    db
      .select({ publicId: models.publicId })
      .from(models)
      .all()
      .map((row) => row.publicId),
  );
  const upstreamById = new Map(
    upstreamModels.map((model) => [model.id, model]),
  );
  const localByUpstream = new Map(
    localRows.map((row) => [row.upstreamId, row]),
  );

  const assigned = new Set<string>(allPublicIds);
  const added: SyncPreview["added"] = [];
  for (const model of upstreamModels) {
    if (localByUpstream.has(model.id)) continue;
    const base =
      sanitizePublicId(model.id) ||
      sanitizePublicId(`${provider.name}-model`) ||
      "model";
    let candidate = base;
    let aliasConflict = false;
    if (assigned.has(candidate)) {
      aliasConflict = true;
      let suffix = 2;
      while (assigned.has(`${base}-${suffix}`)) suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    assigned.add(candidate);
    const values: SyncPreview["added"][number]["upstream"] = {};
    if (model.displayName !== undefined) values.displayName = model.displayName;
    if (model.contextWindow !== undefined)
      values.contextWindow = model.contextWindow;
    if (model.maxOutputTokens !== undefined)
      values.maxOutputTokens = model.maxOutputTokens;
    added.push({
      upstreamId: model.id,
      suggestedPublicId: candidate,
      aliasConflict,
      upstream: values,
    });
  }

  const matched: SyncPreview["matched"] = [];
  const conflicts: SyncPreview["conflicts"] = [];
  for (const row of localRows) {
    const model = upstreamById.get(row.upstreamId);
    if (!model) continue;
    const local = localFields(row);
    const synced = syncedFields(row);
    const upstream = upstreamFields(model);
    const changedFields: SyncField[] = [];
    for (const field of SYNC_FIELDS) {
      const result = mergeField(
        local[field] ?? null,
        synced[field] ?? null,
        upstream[field],
      );
      if (result.kind === "adopt") changedFields.push(field);
      if (result.kind === "conflict") {
        changedFields.push(field);
        conflicts.push({
          modelId: row.id,
          publicId: row.publicId,
          field,
          local: result.local,
          upstream: result.upstream,
          synced: synced[field] ?? null,
        });
      }
    }
    matched.push({ modelId: row.id, publicId: row.publicId, changedFields });
  }

  const missing: SyncPreview["missing"] = localRows
    .filter((row) => !upstreamById.has(row.upstreamId))
    .map((row) => ({
      modelId: row.id,
      upstreamId: row.upstreamId,
      publicId: row.publicId,
      currentUpstreamAvailable: row.upstreamAvailable,
    }));

  return {
    providerId: provider.id,
    fetchedAt,
    added,
    matched,
    missing,
    conflicts,
  };
}

export function validatePublicId(value: string): string {
  const trimmed = value.trim();
  if (!PUBLIC_ID_PATTERN.test(trimmed)) {
    throw new HttpError(
      400,
      `"publicId" must start with a letter or digit and contain only letters, digits, and . _ : / - (max 128 characters).`,
    );
  }
  return trimmed;
}

export function applySync(
  db: AppDb,
  provider: ProviderRow,
  body: SyncApplyBody,
  upstreamModels: UpstreamModel[],
  now = Date.now(),
): void {
  const upstreamById = new Map(
    upstreamModels.map((model) => [model.id, model]),
  );
  const resolutionChoice = new Map<string, "local" | "upstream">();
  for (const resolution of body.resolutions ?? []) {
    resolutionChoice.set(
      `${resolution.modelId}:${resolution.field}`,
      resolution.choice,
    );
  }
  const missingAction = new Map<number, "keep" | "disable" | "delete">();
  for (const decision of body.missing ?? [])
    missingAction.set(decision.modelId, decision.action);

  const additions = (body.added ?? []).map((entry) => {
    const upstreamId =
      typeof entry.upstreamId === "string" ? entry.upstreamId.trim() : "";
    if (upstreamId === "")
      throw new HttpError(
        400,
        `"added[].upstreamId" must be a non-empty string.`,
      );
    return {
      upstreamId,
      publicId: validatePublicId(String(entry.publicId ?? "")),
    };
  });

  db.transaction((tx) => {
    const localRows = tx
      .select()
      .from(models)
      .where(eq(models.providerId, provider.id))
      .all();
    const localByUpstream = new Map(
      localRows.map((row) => [row.upstreamId, row]),
    );
    const publicIdOwners = new Map(
      tx
        .select({ id: models.id, publicId: models.publicId })
        .from(models)
        .all()
        .map((row) => [row.publicId, row.id]),
    );

    for (const addition of additions) {
      const upstream = upstreamById.get(addition.upstreamId);
      if (!upstream) {
        throw new HttpError(
          409,
          `Model "${addition.upstreamId}" is no longer available upstream.`,
        );
      }
      if (localByUpstream.has(addition.upstreamId)) {
        throw new HttpError(
          409,
          `Model "${addition.upstreamId}" already exists for this provider.`,
        );
      }
      const owner = publicIdOwners.get(addition.publicId);
      if (owner !== undefined) {
        throw new HttpError(
          409,
          `Public ID "${addition.publicId}" is already in use by another model.`,
        );
      }
      tx.insert(models)
        .values({
          providerId: provider.id,
          upstreamId: upstream.id,
          publicId: addition.publicId,
          displayName: upstream.displayName ?? upstream.id,
          enabled: true,
          contextWindow: upstream.contextWindow ?? null,
          maxOutputTokens: upstream.maxOutputTokens ?? null,
          notes: null,
          upstreamCreatedAt: upstream.upstreamCreatedAt ?? null,
          upstreamOwnedBy: upstream.upstreamOwnedBy ?? null,
          upstreamAvailable: true,
          syncedDisplayName: upstream.displayName ?? null,
          syncedContextWindow: upstream.contextWindow ?? null,
          syncedMaxOutputTokens: upstream.maxOutputTokens ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      publicIdOwners.set(addition.publicId, -1);
    }

    for (const row of localRows) {
      const upstream = upstreamById.get(row.upstreamId);
      if (!upstream) {
        const action = missingAction.get(row.id) ?? "keep";
        if (action === "delete") {
          tx.delete(models).where(eq(models.id, row.id)).run();
        } else if (action === "disable") {
          tx.update(models)
            .set({ enabled: false, upstreamAvailable: false, updatedAt: now })
            .where(eq(models.id, row.id))
            .run();
        } else {
          tx.update(models)
            .set({ upstreamAvailable: false, updatedAt: now })
            .where(eq(models.id, row.id))
            .run();
        }
        continue;
      }

      const local = localFields(row);
      const synced = syncedFields(row);
      const upstreamValues = upstreamFields(upstream);
      const patch: Record<string, unknown> = {
        upstreamAvailable: true,
        updatedAt: now,
      };
      if (upstream.upstreamCreatedAt !== undefined) {
        patch.upstreamCreatedAt = upstream.upstreamCreatedAt;
      }
      if (upstream.upstreamOwnedBy !== undefined)
        patch.upstreamOwnedBy = upstream.upstreamOwnedBy;

      for (const field of SYNC_FIELDS) {
        const upstreamValue = upstreamValues[field];
        if (upstreamValue === undefined) continue;
        const result = mergeField(
          local[field] ?? null,
          synced[field] ?? null,
          upstreamValue,
        );
        if (result.kind === "adopt") {
          patch[field] = result.value;
        } else if (result.kind === "conflict") {
          if (resolutionChoice.get(`${row.id}:${field}`) === "upstream") {
            patch[field] = result.upstream;
          }
        } else {
          continue;
        }
        patch[`synced${field.charAt(0).toUpperCase()}${field.slice(1)}`] =
          upstreamValue;
      }

      tx.update(models).set(patch).where(eq(models.id, row.id)).run();
    }

    tx.update(providers)
      .set({ lastSyncedAt: now, updatedAt: now })
      .where(eq(providers.id, provider.id))
      .run();
  });
}
