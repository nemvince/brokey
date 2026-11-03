import type { OpenCodeConfig } from "../../config.ts";
import { readBodyCapped } from "../streaming.ts";
import type { UpstreamModel } from "../models-sync.ts";

/**
 * The model catalog the real OpenCode client reads at boot.
 *
 * It carries everything this provider kind needs to describe the free tier:
 * which models are free (zero cost, not deprecated, tool-callable), their
 * output ceiling and reasoning flag, and the inference endpoints — so an
 * upstream URL migration is picked up without a broker release.
 */

const CATALOG_TIMEOUT_MS = 8_000;
const CATALOG_MAX_BYTES = 33_554_432;
const CATALOG_TTL_MS = 3_600_000;

/** Only endpoints under `opencode.ai` (or an operator override) are trusted. */
const TRUSTED_BASE = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai(\/|$)/i;

export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  maxOutput: number | null;
  context: number | null;
  /** Per-model endpoint, when the catalog states one that is safe to use. */
  base: string | null;
  free: boolean;
  deprecated: boolean;
};

export type Catalog = {
  /** Provider-wide endpoint from the catalog's `opencode` entry. */
  base: string | null;
  models: Map<string, CatalogModel>;
  free: CatalogModel[];
  /** lowercase catalog family → the free model id that stands for it. */
  families: Map<string, string>;
  fetchedAt: number;
};

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** A URL is usable only when it is https and under `opencode.ai`, or pinned. */
function trustedBase(value: unknown, override: boolean): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const url = value.trim().replace(/\/+$/, "");
  if (!override && !TRUSTED_BASE.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    return url;
  } catch {
    return null;
  }
}

export function parseCatalog(json: unknown, config: OpenCodeConfig): Catalog {
  const root = record(json);
  const opencode = record(root?.opencode);
  if (!opencode) throw new Error("OpenCode catalog has no opencode provider.");

  // An operator-pinned chat URL doubles as permission to trust the catalog's
  // own endpoints, which is what lets tests point at a mock gateway.
  const pinned = config.chatUrl !== null;
  const npm = String(opencode.npm ?? "");
  const models = new Map<string, CatalogModel>();
  const familyOf = new Map<string, string>();

  for (const [key, raw] of Object.entries(record(opencode.models) ?? {})) {
    const model = record(raw);
    if (!model) continue;
    const provider = record(model.provider);
    const limit = record(model.limit);
    const cost = record(model.cost);
    const deprecated = model.status === "deprecated";
    const speaksChat = String(provider?.npm ?? npm).startsWith(
      "@ai-sdk/openai",
    );
    const id = key.toLowerCase();
    if (typeof model.family === "string" && model.family.trim() !== "")
      familyOf.set(id, model.family.trim().toLowerCase());
    models.set(id, {
      id,
      name:
        typeof model.name === "string" && model.name !== "" ? model.name : key,
      reasoning: model.reasoning === true,
      maxOutput: positive(limit?.output),
      context: positive(limit?.context),
      base: speaksChat ? trustedBase(provider?.api, pinned) : null,
      deprecated,
      free:
        Number(cost?.input) === 0 &&
        Number(cost?.output) === 0 &&
        !deprecated &&
        model.tool_call !== false,
    });
  }

  const free = [...models.values()]
    .filter((model) => model.free)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // First free model of each family wins, so the choice is deterministic.
  const families = new Map<string, string>();
  for (const model of free) {
    const family = familyOf.get(model.id);
    if (family && !families.has(family)) families.set(family, model.id);
  }

  return {
    base: trustedBase(opencode.api, pinned),
    models,
    free,
    families,
    fetchedAt: Date.now(),
  };
}

export type CatalogStore = {
  /** Refresh the cache (or reuse it inside the TTL) and return it. */
  load(force?: boolean): Promise<Catalog>;
  current(): Catalog | null;
  fetchedAt(): number | null;
  lastError(): string | null;
};

/**
 * One catalog cache per runtime. Concurrent callers share the in-flight
 * request, so a burst of traffic costs one fetch.
 */
export function createCatalogStore(config: OpenCodeConfig): CatalogStore {
  let catalog: Catalog | null = null;
  let fetchedAt: number | null = null;
  let error: string | null = null;
  let lastAttempt = 0;
  let inFlight: Promise<Catalog> | null = null;

  const fetchCatalog = async (): Promise<Catalog> => {
    lastAttempt = Date.now();
    const response = await fetch(config.catalogUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`catalog returned HTTP ${response.status}`);
    }
    const body = await readBodyCapped(response, CATALOG_MAX_BYTES);
    if (body.truncated)
      throw new Error(`catalog exceeded ${CATALOG_MAX_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      throw new Error("catalog is not valid JSON");
    }
    return parseCatalog(parsed, config);
  };

  return {
    async load(force = false) {
      // A forced call joins a running fetch instead of starting a second one.
      if (inFlight) {
        await inFlight.catch(() => undefined);
        if (!force) return catalog as Catalog;
      }
      if (!force && catalog && Date.now() - lastAttempt < CATALOG_TTL_MS)
        return catalog;
      inFlight = fetchCatalog();
      try {
        catalog = await inFlight;
        fetchedAt = catalog.fetchedAt;
        error = null;
        return catalog;
      } catch (failure) {
        // Keep the last good catalog: a sync failure must not empty `/v1/models`.
        error = failure instanceof Error ? failure.message : String(failure);
        throw new Error(error);
      } finally {
        inFlight = null;
      }
    },
    current: () => catalog,
    fetchedAt: () => fetchedAt,
    lastError: () => error,
  };
}

export function catalogFacts(
  catalog: Catalog | null,
  modelId: string,
): { reasoning: boolean; maxOutput: number | null } {
  const model = catalog?.models.get(modelId.toLowerCase());
  // A missing catalog only raises the token floor; it cannot truncate an answer.
  return {
    reasoning: model?.reasoning ?? true,
    maxOutput: model?.maxOutput ?? null,
  };
}

export function catalogFreeModels(catalog: Catalog | null): UpstreamModel[] {
  return (catalog?.free ?? []).map((model) => ({
    id: model.id,
    displayName: model.name,
    contextWindow: model.context ?? undefined,
    maxOutputTokens: model.maxOutput ?? undefined,
    upstreamOwnedBy: "opencode",
  }));
}

export function catalogVerdict(
  catalog: Catalog | null,
  modelId: string,
): "free" | "paid" | "deprecated" | null {
  const model = catalog?.models.get(modelId.toLowerCase());
  if (!model) return null;
  if (model.deprecated) return "deprecated";
  return model.free ? "free" : "paid";
}

/** The provider-wide inference root the catalog states, if any. */
export function catalogBase(catalog: Catalog | null): string | null {
  return catalog?.base ?? null;
}

/** A catalog model's endpoint, falling back to the provider-wide one. */
export function catalogModelBase(
  catalog: Catalog | null,
  modelId: string,
): string | null {
  return (
    catalog?.models.get(modelId.toLowerCase())?.base ?? catalog?.base ?? null
  );
}

/**
 * Resolve a family shorthand (`mimo`, `deepseek`) to a free model id: the
 * family the catalog names, else the shortest free id in that family.
 */
export function resolveFamilyAlias(
  catalog: Catalog | null,
  name: string,
): string | null {
  if (!catalog) return null;
  const key = name.trim().toLowerCase();
  if (key === "") return null;
  if (catalog.models.get(key)?.free) return key;
  const family =
    catalog.families.get(key) ??
    catalog.families.get(key.replace(/-free$/, ""));
  if (family) return family;
  const matches = catalog.free
    .filter((model) => model.id === key || model.id.startsWith(`${key}-`))
    .map((model) => model.id);
  matches.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return matches[0] ?? null;
}
