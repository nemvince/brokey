import { gte, sql } from "drizzle-orm";
import type { AppDb } from "./db.ts";
import { usageLogs } from "./schema.ts";
import type { StatsRange, StatsResponse } from "../shared/types.ts";

const RANGE_MS: Record<Exclude<StatsRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const RANGES: readonly StatsRange[] = ["24h", "7d", "30d", "all"];

/**
 * The dashboard polls every 30s, so a few seconds of caching keeps the public
 * endpoint from being a cheap way to saturate SQLite with aggregates.
 */
const CACHE_TTL_MS = 5_000;

let cache: { key: string; at: number; payload: StatsResponse } | null = null;

export function invalidateStatsCache(): void {
  cache = null;
}
const BREAKDOWN_LIMIT = 10;
/**
 * The endpoint is unauthenticated, so nothing that identifies a client key or
 * a provider may leave this handler: names, key prefixes and per-request rows
 * are all leaks. Only counts, sums and anonymous labels are emitted.
 */

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function handleStats(
  req: Request,
  db: AppDb,
  now = Date.now(),
): Response {
  const url = new URL(req.url);
  const requested = url.searchParams.get("range") ?? "30d";
  const range: StatsRange = RANGES.includes(requested as StatsRange)
    ? (requested as StatsRange)
    : "30d";

  // New log rows bump `max(id)`; admin mutations call `invalidateStatsCache`
  // because they change snapshot labels and key prefixes.
  const logMarker = Number(
    db
      .select({ max: sql<number>`coalesce(max(${usageLogs.id}), 0)` })
      .from(usageLogs)
      .get()?.max ?? 0,
  );
  const cacheKey = `${range}:${logMarker}`;
  if (cache && cache.key === cacheKey && now - cache.at < CACHE_TTL_MS) {
    return Response.json(cache.payload, {
      headers: { "cache-control": "no-store" },
    });
  }

  const rangeStart = range === "all" ? null : now - RANGE_MS[range];
  const rangeWhere =
    rangeStart === null ? sql`1 = 1` : gte(usageLogs.createdAt, rangeStart);

  const totalsRow = db
    .select({
      requests: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${usageLogs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${usageLogs.completionTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)`,
      estimatedRequests: sql<number>`coalesce(sum(case when ${usageLogs.estimated} = 1 then 1 else 0 end), 0)`,
      errors: sql<number>`coalesce(sum(case when ${usageLogs.status} >= 400 then 1 else 0 end), 0)`,
    })
    .from(usageLogs)
    .where(rangeWhere)
    .get();

  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const todayRow = db
    .select({
      requests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)`,
    })
    .from(usageLogs)
    .where(gte(usageLogs.createdAt, dayStart))
    .get();

  const bucketExpression =
    range === "24h"
      ? sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${usageLogs.createdAt} / 1000, 'unixepoch')`
      : sql<string>`date(${usageLogs.createdAt} / 1000, 'unixepoch')`;

  const seriesRows = db
    .select({
      bucket: bucketExpression,
      requests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)`,
    })
    .from(usageLogs)
    .where(rangeWhere)
    .groupBy(bucketExpression)
    .all();

  const byModelRows = db
    .select({
      label: usageLogs.modelPublicId,
      requests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)`,
    })
    .from(usageLogs)
    .where(rangeWhere)
    .groupBy(usageLogs.modelPublicId)
    .all();

  const payload: StatsResponse = {
    generatedAt: now,
    range,
    totals: {
      requests: asNumber(totalsRow?.requests),
      promptTokens: asNumber(totalsRow?.promptTokens),
      completionTokens: asNumber(totalsRow?.completionTokens),
      totalTokens: asNumber(totalsRow?.totalTokens),
      estimatedRequests: asNumber(totalsRow?.estimatedRequests),
      errors: asNumber(totalsRow?.errors),
      averageCompletionTokens: Math.round(
        asNumber(totalsRow?.completionTokens) /
          Math.max(1, asNumber(totalsRow?.requests)),
      ),
    },
    today: {
      requests: asNumber(todayRow?.requests),
      totalTokens: asNumber(todayRow?.totalTokens),
    },
    series: seriesRows
      .map((row) => ({
        bucket: row.bucket,
        requests: asNumber(row.requests),
        totalTokens: asNumber(row.totalTokens),
      }))
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)),
    byModel: topByTokens(
      byModelRows.map((row) => ({
        label: row.label === "" ? "(unrouted)" : row.label,
        requests: asNumber(row.requests),
        totalTokens: asNumber(row.totalTokens),
      })),
    ),
  };

  cache = { key: cacheKey, at: now, payload };
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

function topByTokens<
  T extends { label: string; totalTokens: number; requests: number },
>(rows: T[]): T[] {
  return rows
    .sort((a, b) =>
      b.totalTokens - a.totalTokens !== 0
        ? b.totalTokens - a.totalTokens
        : a.label < b.label
          ? -1
          : a.label > b.label
            ? 1
            : 0,
    )
    .slice(0, BREAKDOWN_LIMIT);
}
