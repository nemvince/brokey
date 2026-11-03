import { and, asc, eq, or, isNull, lte, sql } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import { type ProviderKeyRow, providerKeys } from "../schema.ts";
import type { KeyStatus } from "../../shared/types.ts";

export const MAX_KEY_ATTEMPTS = 10;

const COOLDOWN_401 = 86_400;
const COOLDOWN_402 = 86_400;
const COOLDOWN_QUOTA = 3_600;
const COOLDOWN_RATE_LIMIT_DEFAULT = 60;
const COOLDOWN_NETWORK = 15;

export function providerKeyStatus(
  row: ProviderKeyRow,
  now = Date.now(),
): KeyStatus {
  if (!row.enabled) return "disabled";
  if (row.cooldownUntil !== null && row.cooldownUntil > now) return "cooling";
  return "active";
}

export type CandidatePool = {
  candidates: ProviderKeyRow[];
  hasEnabledKeys: boolean;
  coolingCount: number;
  earliestCooldown: number | null;
};

/**
 * Enabled keys for a provider, minus keys currently cooling down.
 * Never-used keys come first, then least recently used, and keys already
 * handling a concurrent request are deprioritised.
 */
export function selectCandidates(
  db: AppDb,
  providerId: number,
  now: number,
  busyKeys: ReadonlySet<number> = new Set(),
): CandidatePool {
  const rows = db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.providerId, providerId),
        eq(providerKeys.enabled, true),
      ),
    )
    .orderBy(
      sql`${providerKeys.lastUsedAt} IS NOT NULL`,
      asc(providerKeys.lastUsedAt),
      asc(providerKeys.id),
    )
    .all();

  const cooling = rows.filter(
    (row) => row.cooldownUntil !== null && row.cooldownUntil > now,
  );
  const available = rows.filter(
    (row) => row.cooldownUntil === null || row.cooldownUntil <= now,
  );
  const idle = available.filter((row) => !busyKeys.has(row.id));
  const ordered =
    idle.length > 0
      ? [...idle, ...available.filter((row) => busyKeys.has(row.id))]
      : available;

  let earliestCooldown: number | null = null;
  for (const row of cooling) {
    const until = row.cooldownUntil as number;
    if (earliestCooldown === null || until < earliestCooldown)
      earliestCooldown = until;
  }

  return {
    candidates: ordered.slice(0, MAX_KEY_ATTEMPTS),
    hasEnabledKeys: rows.length > 0,
    coolingCount: cooling.length,
    earliestCooldown,
  };
}

export function markKeyUsed(db: AppDb, keyId: number, now = Date.now()): void {
  db.update(providerKeys)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(providerKeys.id, keyId))
    .run();
}

export function recordKeySuccess(
  db: AppDb,
  keyId: number,
  now = Date.now(),
): void {
  db.update(providerKeys)
    .set({
      lastUsedAt: now,
      lastError: null,
      lastErrorAt: null,
      updatedAt: now,
    })
    .where(eq(providerKeys.id, keyId))
    .run();
}

export type KeyFailure = {
  retryable: boolean;
  cooldownSeconds: number;
  errorCode: string;
};

export function recordKeyFailure(
  db: AppDb,
  keyId: number,
  failure: Pick<KeyFailure, "cooldownSeconds" | "errorCode">,
  message: string,
  now = Date.now(),
): number {
  const cooldownUntil = now + failure.cooldownSeconds * 1000;
  db.update(providerKeys)
    .set({
      cooldownUntil,
      lastError: message.slice(0, 500),
      lastErrorAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(providerKeys.id, keyId))
    .run();
  return cooldownUntil;
}

/**
 * Parse a `Retry-After` header into seconds, clamped to 1–3600.
 * Accepts integer seconds, an HTTP date, or durations like `1.5s` / `30m`.
 */
export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number {
  const fallback = COOLDOWN_RATE_LIMIT_DEFAULT;
  if (!header) return fallback;
  const value = header.trim();
  if (value === "") return fallback;

  if (/^\d+$/.test(value)) return clampSeconds(Number(value));

  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] as string).toLowerCase();
    const factor =
      unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : 3600;
    return clampSeconds(amount * factor);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) return clampSeconds((date - now) / 1000);

  return fallback;
}

function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return COOLDOWN_RATE_LIMIT_DEFAULT;
  return Math.min(3600, Math.max(1, Math.round(seconds)));
}

/**
 * Bodies that say this key's allowance is spent rather than that the request is
 * malformed. Providers use 402, 403, 429 and even 500 for a spent tenant quota,
 * so the text decides: a quota error must fail over to another key, never reach
 * a client as the provider wrote it.
 */
const QUOTA_BODY =
  /insufficient_quota|quota (?:exceeded|exhausted|reached)|exceeded (?:your|the) (?:current )?quota|out of credits?|credit balance|billing|payment required|usage limit|spending limit|allowance (?:is )?(?:exhausted|spent|exceeded)|free[- ]tier limit/i;

/** Map an upstream HTTP failure to cooldown/retry semantics. */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
  now = Date.now(),
): KeyFailure {
  if (status === 401) {
    return {
      retryable: true,
      cooldownSeconds: COOLDOWN_401,
      errorCode: "invalid_key",
    };
  }
  if (status === 402) {
    return {
      retryable: true,
      cooldownSeconds: COOLDOWN_402,
      errorCode: "payment_required",
    };
  }
  // Checked before the status: a spent quota is this key's problem whatever
  // code carries it, and a different key may still have allowance.
  if (QUOTA_BODY.test(bodyText)) {
    return {
      retryable: true,
      cooldownSeconds: COOLDOWN_QUOTA,
      errorCode: "quota_exhausted",
    };
  }
  if (status === 429) {
    return {
      retryable: true,
      cooldownSeconds: parseRetryAfter(retryAfterHeader, now),
      errorCode: "rate_limited",
    };
  }
  return { retryable: false, cooldownSeconds: 0, errorCode: `http_${status}` };
}

const FAILURE_LABELS: Record<string, string> = {
  quota_exhausted: "quota exhausted",
  rate_limited: "rate limited",
  invalid_key: "key rejected",
  payment_required: "payment required",
  network_error: "network unreachable",
};

/** The phrase a "no keys left" error uses for one failure code. */
export function failureReasonLabel(code: string): string {
  return FAILURE_LABELS[code] ?? "upstream failure";
}

export function networkFailure(): KeyFailure {
  return {
    retryable: true,
    cooldownSeconds: COOLDOWN_NETWORK,
    errorCode: "network_error",
  };
}

/**
 * Strips a provider credential out of upstream text before it is stored in
 * `provider_keys.last_error` or returned to a client. Some upstreams echo the
 * Authorization header in their error bodies ("Incorrect API key provided: sk-…").
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 8) return text;
  const encoded = encodeURIComponent(secret);
  let out = text.split(secret).join("[redacted]");
  if (encoded !== secret) out = out.split(encoded).join("[redacted]");
  return out;
}

export function upstreamUrl(
  baseUrl: string,
  pathname: string,
  search: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = pathname.replace(/^\/v1/, "");
  return `${base}${suffix}${search}`;
}

export function isClientAbort(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function activeKeyCount(
  db: AppDb,
  providerId: number,
  now = Date.now(),
): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.providerId, providerId),
          eq(providerKeys.enabled, true),
          or(
            isNull(providerKeys.cooldownUntil),
            lte(providerKeys.cooldownUntil, now),
          ),
        ),
      )
      .get()?.count ?? 0
  );
}
