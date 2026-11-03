import { createHash, randomBytes } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { AppDb } from "../../db.ts";
import { HttpError } from "../../errors.ts";
import { egressHealth, providerEgress } from "../../schema.ts";
import type {
  EgressEntryDTO,
  EgressPoolDTO,
  EgressPoolUpdate,
  EgressTestResult,
} from "../../../shared/types.ts";

/**
 * Where an OpenCode provider's requests leave from.
 *
 * The free tier's allowance is per egress IP, so a spent address is worth
 * rotating away from. Entries are explicit proxy URLs plus, optionally, the
 * host's own address as a `direct` entry; health (failures, cooldown) is
 * runtime observation and is stored apart from the configured pool.
 */

const EGRESS_BASE_COOLDOWN_MS = 120_000;
const EGRESS_MAX_COOLDOWN_MS = 1_800_000;
const EGRESS_TEST_TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 32;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DIRECT_KEY = "@direct";

export type EgressStrategy = "round-robin" | "failover" | "random";

export type EgressEntryConfig = {
  id: string;
  label: string;
  /** Empty means "this host": the direct entry. */
  url: string;
  enabled: boolean;
  weight: number;
};

export type EgressPoolConfig = {
  strategy: EgressStrategy;
  relayUrl: string | null;
  entries: EgressEntryConfig[];
};

export type EgressSelection = {
  providerId: number;
  /** Health key: `@direct` or 16 hex of sha256(url). */
  key: string;
  url: string;
  id: string | null;
  label: string | null;
  direct: boolean;
  cooling: boolean;
  cooldownUntil: number | null;
  relayUrl: string | null;
};

export type HealthEntry = {
  failures: number;
  cooldownUntil: number;
  lastError: string | null;
  lastOkAt: number | null;
  lastUsedAt: number | null;
};

/** Per-app runtime state: health rows and the round-robin cursor. */
export type EgressState = {
  health: Map<number, Map<string, HealthEntry>>;
  cursors: Map<number, number>;
};

export function createEgressState(): EgressState {
  return { health: new Map(), cursors: new Map() };
}

export function forgetEgress(state: EgressState, providerId: number): void {
  state.health.delete(providerId);
  state.cursors.delete(providerId);
}

/** Health key for an entry URL: the URL itself never leaves the process. */
export function egressKey(url: string): string {
  return url === ""
    ? DIRECT_KEY
    : createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** `host:port` for display. Credentials are never part of this string. */
function displayHost(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

/**
 * Canonical form of a proxy URL. Only scheme, credentials, host, and port are
 * accepted: Bun's `fetch({ proxy })` tunnels with CONNECT, so a path or a
 * SOCKS scheme would be silently useless.
 */
export function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (value === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(
      400,
      '"url" must be an absolute proxy URL, for example http://user:pass@host:8080.',
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      400,
      `Proxy scheme ${parsed.protocol} is not supported; use http:// or https://.`,
    );
  }
  if (!parsed.hostname)
    throw new HttpError(400, '"url" must include a proxy host.');
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "")
    throw new HttpError(
      400,
      '"url" may only contain scheme, credentials, host, and port.',
    );
  // Credentials stay percent-encoded exactly as typed, which is what Bun
  // expects; rebuilding also drops the trailing slash `URL` normalizes in.
  const auth =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
      : "";
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}`;
}

function normalizeRelayUrl(raw: string): string {
  const value = raw.trim();
  if (value === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, '"relayUrl" must be an absolute URL.');
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new HttpError(400, '"relayUrl" must use http or https.');
  if (!parsed.hostname)
    throw new HttpError(400, '"relayUrl" must include a host.');
  if (parsed.hash !== "")
    throw new HttpError(400, '"relayUrl" must not contain a fragment.');
  return value.replace(/#.*$/, "");
}

function parseEntries(raw: string): EgressEntryConfig[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.url !== "string")
        return [];
      return [
        {
          id: record.id,
          label: typeof record.label === "string" ? record.label : record.id,
          url: record.url,
          enabled: record.enabled !== false,
          weight: Number(record.weight) > 0 ? Number(record.weight) : 1,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function readPool(db: AppDb, providerId: number): EgressPoolConfig {
  const row = db
    .select()
    .from(providerEgress)
    .where(eq(providerEgress.providerId, providerId))
    .get();
  if (!row) return { strategy: "round-robin", relayUrl: null, entries: [] };
  const strategy =
    row.strategy === "failover" || row.strategy === "random"
      ? row.strategy
      : "round-robin";
  return {
    strategy,
    relayUrl: row.relayUrl,
    entries: parseEntries(row.entries),
  };
}

function healthFor(
  state: EgressState,
  providerId: number,
): Map<string, HealthEntry> {
  const existing = state.health.get(providerId);
  if (existing) return existing;
  const loaded = new Map<string, HealthEntry>();
  state.health.set(providerId, loaded);
  return loaded;
}

function loadHealth(db: AppDb, state: EgressState, providerId: number) {
  const cache = healthFor(state, providerId);
  if (cache.size > 0) return cache;
  const rows = db
    .select()
    .from(egressHealth)
    .where(eq(egressHealth.providerId, providerId))
    .all();
  for (const row of rows) {
    cache.set(row.egressKey, {
      failures: row.failures,
      cooldownUntil: row.cooldownUntil,
      lastError: row.lastError,
      lastOkAt: row.lastOkAt,
      lastUsedAt: row.lastUsedAt,
    });
  }
  return cache;
}

const EMPTY_HEALTH: HealthEntry = {
  failures: 0,
  cooldownUntil: 0,
  lastError: null,
  lastOkAt: null,
  lastUsedAt: null,
};

export function egressPool(
  db: AppDb,
  state: EgressState,
  providerId: number,
  now = Date.now(),
): EgressPoolDTO {
  const pool = readPool(db, providerId);
  const health = loadHealth(db, state, providerId);
  const entries: EgressEntryDTO[] = pool.entries.map((entry) => {
    const record = health.get(egressKey(entry.url)) ?? EMPTY_HEALTH;
    return {
      id: entry.id,
      label: entry.label,
      host: displayHost(entry.url),
      direct: entry.url === "",
      enabled: entry.enabled,
      weight: entry.weight,
      failures: record.failures,
      cooling: record.cooldownUntil > now,
      cooldownUntil: record.cooldownUntil > 0 ? record.cooldownUntil : null,
      lastError: record.lastError,
      lastOkAt: record.lastOkAt,
      lastUsedAt: record.lastUsedAt,
    };
  });
  return {
    strategy: pool.strategy,
    relayHost: displayHost(pool.relayUrl),
    active: entries.length > 0,
    entries,
  };
}

function writePool(
  db: AppDb,
  providerId: number,
  pool: EgressPoolConfig,
  now: number,
): void {
  const values = {
    providerId,
    strategy: pool.strategy,
    entries: JSON.stringify(pool.entries),
    relayUrl: pool.relayUrl,
    updatedAt: now,
  };
  db.insert(providerEgress)
    .values(values)
    .onConflictDoUpdate({
      target: providerEgress.providerId,
      set: {
        strategy: values.strategy,
        entries: values.entries,
        relayUrl: values.relayUrl,
        updatedAt: values.updatedAt,
      },
    })
    .run();
  const keys = pool.entries.map((entry) => egressKey(entry.url));
  db.delete(egressHealth)
    .where(
      and(
        eq(egressHealth.providerId, providerId),
        keys.length > 0 ? notInArray(egressHealth.egressKey, keys) : undefined,
      ),
    )
    .run();
}

export function saveEgressPool(
  db: AppDb,
  state: EgressState,
  providerId: number,
  update: EgressPoolUpdate,
  now = Date.now(),
): EgressPoolDTO {
  const current = readPool(db, providerId);
  const next: EgressPoolConfig = {
    strategy: current.strategy,
    relayUrl: current.relayUrl,
    entries: current.entries,
  };

  if (update.strategy !== undefined) {
    if (
      update.strategy !== "round-robin" &&
      update.strategy !== "failover" &&
      update.strategy !== "random"
    )
      throw new HttpError(
        400,
        '"strategy" must be round-robin, failover, or random.',
      );
    next.strategy = update.strategy;
  }

  if (update.relayUrl !== undefined) {
    next.relayUrl =
      update.relayUrl === null || update.relayUrl === ""
        ? null
        : normalizeRelayUrl(update.relayUrl);
  }

  if (update.entries !== undefined) {
    if (!Array.isArray(update.entries))
      throw new HttpError(400, '"entries" must be an array.');
    if (update.entries.length > MAX_ENTRIES)
      throw new HttpError(400, `A pool holds at most ${MAX_ENTRIES} entries.`);
    const existing = new Map(current.entries.map((entry) => [entry.id, entry]));
    const ids = new Set<string>();
    let direct = 0;
    const entries: EgressEntryConfig[] = [];
    for (const [index, raw] of update.entries.entries()) {
      if (!raw || typeof raw !== "object")
        throw new HttpError(400, `"entries[${index}]" must be an object.`);
      const id = raw.id?.trim();
      if (id !== undefined && !ENTRY_ID.test(id))
        throw new HttpError(
          400,
          `"entries[${index}].id" must match ${ENTRY_ID.source}.`,
        );
      const stored = id === undefined ? undefined : existing.get(id);
      if (id !== undefined && !stored)
        throw new HttpError(400, `Unknown egress entry "${id}".`);
      if (id === undefined && raw.url === undefined)
        throw new HttpError(
          400,
          `"entries[${index}].url" is required for a new entry.`,
        );
      const url =
        raw.url === undefined
          ? (stored?.url ?? "")
          : normalizeProxyUrl(raw.url);
      const entryId = id ?? `eg_${randomBytes(4).toString("hex")}`;
      if (ids.has(entryId))
        throw new HttpError(400, `Duplicate egress entry id "${entryId}".`);
      ids.add(entryId);
      if (url === "") direct += 1;
      if (direct > 1)
        throw new HttpError(400, "Only one direct egress entry is allowed.");
      const weight = raw.weight ?? stored?.weight ?? 1;
      if (!Number.isInteger(weight) || weight < 1 || weight > 100)
        throw new HttpError(
          400,
          `"entries[${index}].weight" must be an integer between 1 and 100.`,
        );
      const label = (raw.label ?? stored?.label ?? "").trim();
      if (label.length > 64)
        throw new HttpError(
          400,
          `"entries[${index}].label" must be at most 64 characters.`,
        );
      entries.push({
        id: entryId,
        label: label || displayHost(url) || "direct",
        url,
        enabled: raw.enabled ?? stored?.enabled ?? true,
        weight,
      });
    }
    next.entries = entries;
  }

  writePool(db, providerId, next, now);
  // Health is keyed by URL hash, so a changed pool must not reuse cached rows.
  forgetEgress(state, providerId);
  return egressPool(db, state, providerId, now);
}

function isCooling(health: HealthEntry | undefined, now: number): boolean {
  return (health?.cooldownUntil ?? 0) > now;
}

/**
 * The egress for one request.
 *
 * Never returns empty while the pool has enabled entries: when every entry is
 * cooling the one that recovers first is used anyway, because refusing to send
 * turns a throttled pool into a dead proxy.
 */
export function pickEgress(
  db: AppDb,
  state: EgressState,
  providerId: number,
  options: { exclude?: string | null; now?: number } = {},
): EgressSelection {
  const now = options.now ?? Date.now();
  const pool = readPool(db, providerId);
  const health = loadHealth(db, state, providerId);
  const enabled = pool.entries.filter((entry) => entry.enabled);
  const base = {
    providerId,
    relayUrl: pool.relayUrl,
  };
  if (enabled.length === 0) {
    const record = health.get(DIRECT_KEY);
    const cooling = isCooling(record, now);
    return {
      ...base,
      key: DIRECT_KEY,
      url: "",
      id: null,
      label: null,
      direct: true,
      cooling,
      cooldownUntil: cooling ? (record?.cooldownUntil ?? null) : null,
    };
  }

  // `null` means "no preference", which must not be confused with the direct
  // entry's empty URL: both would map to the same health key.
  const exclude = options.exclude ?? null;
  let candidates =
    exclude === null
      ? enabled.slice()
      : enabled.filter((entry) => egressKey(entry.url) !== exclude);
  if (candidates.length === 0) candidates = enabled.slice();

  const healthy = candidates.filter(
    (entry) => !isCooling(health.get(egressKey(entry.url)), now),
  );
  let chosen: EgressEntryConfig;
  let cooling = false;
  if (healthy.length > 0) {
    if (pool.strategy === "random") {
      const total = healthy.reduce((sum, entry) => sum + entry.weight, 0);
      let roll = Math.random() * total;
      chosen = healthy[healthy.length - 1] as EgressEntryConfig;
      for (const entry of healthy) {
        roll -= entry.weight;
        if (roll <= 0) {
          chosen = entry;
          break;
        }
      }
    } else if (pool.strategy === "failover") {
      // Sticky: keeping the same IP preserves upstream prompt caching.
      chosen = healthy[0] as EgressEntryConfig;
    } else {
      const cursor = state.cursors.get(providerId) ?? 0;
      chosen = healthy[cursor % healthy.length] as EgressEntryConfig;
      state.cursors.set(providerId, (cursor + 1) % Number.MAX_SAFE_INTEGER);
    }
  } else {
    cooling = true;
    chosen = candidates
      .slice()
      .sort(
        (a, b) =>
          (health.get(egressKey(a.url))?.cooldownUntil ?? 0) -
          (health.get(egressKey(b.url))?.cooldownUntil ?? 0),
      )[0] as EgressEntryConfig;
  }

  const key = egressKey(chosen.url);
  const record = health.get(key);
  if (record) record.lastUsedAt = now;
  return {
    ...base,
    key,
    url: chosen.url,
    id: chosen.id,
    label: chosen.label,
    direct: chosen.url === "",
    cooling,
    cooldownUntil: cooling ? (record?.cooldownUntil ?? null) : null,
  };
}

function persistHealth(
  db: AppDb,
  providerId: number,
  key: string,
  record: HealthEntry,
  now: number,
): void {
  const values = {
    providerId,
    egressKey: key,
    failures: record.failures,
    cooldownUntil: record.cooldownUntil,
    lastError: record.lastError,
    lastOkAt: record.lastOkAt,
    lastUsedAt: record.lastUsedAt ?? now,
  };
  db.insert(egressHealth)
    .values(values)
    .onConflictDoUpdate({
      target: [egressHealth.providerId, egressHealth.egressKey],
      set: {
        failures: values.failures,
        cooldownUntil: values.cooldownUntil,
        lastError: values.lastError,
        lastOkAt: values.lastOkAt,
        lastUsedAt: values.lastUsedAt,
      },
    })
    .run();
}

/**
 * Record a refusal. The cooldown doubles per consecutive failure so a spent
 * address is retried less and less often, capped just above its base.
 */
export function markEgressFailure(
  db: AppDb,
  state: EgressState,
  providerId: number,
  key: string,
  reason: string,
  cooldownMs: number | null = null,
  now = Date.now(),
): void {
  const health = loadHealth(db, state, providerId);
  const record = health.get(key) ?? { ...EMPTY_HEALTH };
  record.failures += 1;
  record.lastError = reason.slice(0, 200);
  const base =
    cooldownMs !== null && cooldownMs > 0
      ? cooldownMs
      : EGRESS_BASE_COOLDOWN_MS;
  const backoff = Math.min(
    base * 2 ** (record.failures - 1),
    Math.max(EGRESS_MAX_COOLDOWN_MS, base),
  );
  record.cooldownUntil = now + backoff;
  health.set(key, record);
  persistHealth(db, providerId, key, record, now);
}

export function markEgressSuccess(
  db: AppDb,
  state: EgressState,
  providerId: number,
  key: string,
  now = Date.now(),
): void {
  const health = loadHealth(db, state, providerId);
  const record = health.get(key);
  const wasUnhealthy =
    record !== undefined && (record.failures > 0 || record.cooldownUntil > 0);
  const next: HealthEntry = {
    failures: 0,
    cooldownUntil: 0,
    lastError: null,
    lastOkAt: now,
    lastUsedAt: record?.lastUsedAt ?? now,
  };
  health.set(key, next);
  // A healthy row would otherwise be rewritten on every single request.
  if (wasUnhealthy) persistHealth(db, providerId, key, next, now);
}

/**
 * Send one attempt through the selected egress. A relay replaces the transport
 * entirely: it receives the target in headers and forwards the request itself.
 */
export function fetchThroughEgress(
  url: string,
  init: RequestInit,
  selection: EgressSelection,
): Promise<Response> {
  const headers = new Headers(init.headers);
  let target = url;
  if (selection.relayUrl) {
    const parsed = new URL(url);
    headers.set("x-relay-target", parsed.origin);
    headers.set("x-relay-path", parsed.pathname + parsed.search);
    target = selection.relayUrl;
  }
  return fetch(target, {
    ...init,
    headers,
    proxy: selection.url || undefined,
  });
}

/**
 * Probe every enabled entry through its own egress and report what upstream
 * answered. A refusal counts as a failure for that entry, so a spent address is
 * taken out of rotation immediately; any other answer proves the transport.
 */
export async function testEgress(
  db: AppDb,
  state: EgressState,
  providerId: number,
  chatBase: string,
  headersFor: (sessionId: string) => Headers,
  now = Date.now(),
): Promise<EgressTestResult[]> {
  const pool = readPool(db, providerId);
  const modelsUrl = `${chatBase}/models`;
  const probe = async (entry: EgressEntryConfig): Promise<EgressTestResult> => {
    const host = displayHost(entry.url);
    if (!entry.enabled)
      return { id: entry.id, label: entry.label, host, skipped: true };
    const selection: EgressSelection = {
      providerId,
      key: egressKey(entry.url),
      url: entry.url,
      id: entry.id,
      label: entry.label,
      direct: entry.url === "",
      cooling: false,
      cooldownUntil: null,
      relayUrl: null,
    };
    const startedAt = Date.now();
    try {
      const response = await fetchThroughEgress(
        modelsUrl,
        {
          method: "GET",
          headers: headersFor(`ses_${randomBytes(19).toString("hex")}`),
          signal: AbortSignal.timeout(EGRESS_TEST_TIMEOUT_MS),
        },
        selection,
      );
      await response.body?.cancel().catch(() => undefined);
      const latencyMs = Date.now() - startedAt;
      // What is being tested is the transport: the gateway may not serve the
      // probe path at all (it answers 404 there), so only a refusal that means
      // "this egress is spent or blocked" counts as a failure.
      const spent =
        response.status === 401 ||
        response.status === 403 ||
        response.status === 407 ||
        response.status === 429 ||
        response.status >= 500;
      if (spent) {
        markEgressFailure(
          db,
          state,
          providerId,
          selection.key,
          `upstream ${response.status}`,
          null,
          now,
        );
        return {
          id: entry.id,
          label: entry.label,
          host,
          ok: false,
          status: response.status,
          latencyMs,
          error: `upstream ${response.status}`,
        };
      }
      markEgressSuccess(db, state, providerId, selection.key, now);
      return {
        id: entry.id,
        label: entry.label,
        host,
        ok: true,
        status: response.status,
        latencyMs,
        exitIp: await probeExitIp(selection),
      };
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      markEgressFailure(
        db,
        state,
        providerId,
        selection.key,
        message,
        null,
        now,
      );
      return {
        id: entry.id,
        label: entry.label,
        host,
        ok: false,
        status: null,
        latencyMs: Date.now() - startedAt,
        error: message,
      };
    }
  };
  return Promise.all(pool.entries.map(probe));
}

/** Best-effort: the egress's public address, for the operator's eyes only. */
async function probeExitIp(selection: EgressSelection): Promise<string | null> {
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(EGRESS_TEST_TIMEOUT_MS),
      proxy: selection.url || undefined,
    });
    const text = await response.text();
    return /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
