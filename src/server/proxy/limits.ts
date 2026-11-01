import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import { type ClientKeyRow, usageLogs } from "../schema.ts";
import type { LimitWindow } from "../../shared/types.ts";

export function windowStart(kind: LimitWindow, now: number): number | null {
  if (kind === "total") return null;
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (kind === "month") return Date.UTC(year, month, 1);
  return Date.UTC(year, month, date.getUTCDate());
}

export type WindowUsage = { requests: number; tokens: number; windowStart: number | null };

export function usageForWindow(
  db: AppDb,
  clientKeyId: number,
  kind: LimitWindow,
  now = Date.now(),
): WindowUsage {
  const start = windowStart(kind, now);
  const rows = db
    .select({
      requests: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)`,
    })
    .from(usageLogs)
    .where(
      start === null
        ? eq(usageLogs.clientKeyId, clientKeyId)
        : and(eq(usageLogs.clientKeyId, clientKeyId), gte(usageLogs.createdAt, start)),
    )
    .all();
  const row = rows[0];
  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
    windowStart: start,
  };
}

export type LimitViolation = { kind: "requests" | "tokens"; message: string };

export function checkLimits(
  key: ClientKeyRow,
  usage: WindowUsage,
): LimitViolation | null {
  if (key.limitRequests !== null && usage.requests + 1 > key.limitRequests) {
    return {
      kind: "requests",
      message: `API key usage limit exceeded (requests) for this ${key.limitWindow} window.`,
    };
  }
  if (key.limitTokens !== null && usage.tokens >= key.limitTokens) {
    return {
      kind: "tokens",
      message: `API key usage limit exceeded (tokens) for this ${key.limitWindow} window.`,
    };
  }
  return null;
}

export type RemainingHeaders = Record<string, string>;

export function remainingHeaders(
  key: ClientKeyRow,
  usage: WindowUsage,
  estimatedPromptTokens: number,
): RemainingHeaders {
  const headers: RemainingHeaders = {};
  if (key.limitRequests !== null) {
    headers["x-brokey-requests-remaining"] = String(
      Math.max(0, key.limitRequests - (usage.requests + 1)),
    );
  }
  if (key.limitTokens !== null) {
    headers["x-brokey-tokens-remaining"] = String(
      Math.max(0, key.limitTokens - (usage.tokens + estimatedPromptTokens)),
    );
  }
  return headers;
}
