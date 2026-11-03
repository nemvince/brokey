import { eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import type {
  ClientKeyRow,
  ModelRow,
  ProviderRow,
  UsageLogInsert,
} from "../schema.ts";
import { clientKeys, usageLogs } from "../schema.ts";
import type { RequestSlot } from "./limits.ts";
import { EMPTY_USAGE, estimateTokens, type TokenUsage } from "./usage.ts";

export type EndpointKind = "chat" | "responses" | "embeddings" | "other";

export type AttemptContext = {
  db: AppDb;
  requestId: string;
  clientKey: ClientKeyRow;
  provider: ProviderRow;
  /** Null when the attempt did not use a provider API key (OpenCode free tier). */
  providerKeyId: number | null;
  model: ModelRow | null;
  pathname: string;
  method: string;
  kind: EndpointKind;
  startedAt: number;
  upstreamLatencyMs: number | null;
  limitHeaders: Record<string, string>;
  estimatedPromptTokens: number;
};

export function writeUsageLog(
  db: AppDb,
  values: UsageLogInsert,
  slot?: RequestSlot,
): void {
  db.insert(usageLogs).values(values).run();
  // The row now counts towards the client key's window, so the in-flight
  // reservation can be dropped.
  slot?.release();
}

export function logFor(
  ctx: AttemptContext,
  extra: {
    streamed: boolean;
    status: number;
    errorCode: string | null;
    usage: TokenUsage;
    estimated: boolean;
    /** The error text shown to the client; kept as the key's last error. */
    errorMessage?: string | null;
  },
): UsageLogInsert {
  // Every failed request is remembered on its client key, so the keys page can
  // show what last went wrong per key. Truncated like provider keys: the admin
  // page only needs enough of the message to recognise the failure.
  if (extra.status >= 400) {
    ctx.db
      .update(clientKeys)
      .set({
        lastErrorStatus: extra.status,
        lastErrorMessage: (extra.errorMessage ?? extra.errorCode ?? "").slice(
          0,
          500,
        ),
        lastErrorAt: Date.now(),
      })
      .where(eq(clientKeys.id, ctx.clientKey.id))
      .run();
  }
  return {
    requestId: ctx.requestId,
    clientKeyId: ctx.clientKey.id,
    clientKeyLabel: ctx.clientKey.name,
    providerId: ctx.provider.id,
    providerName: ctx.provider.name,
    providerKeyId: ctx.providerKeyId,
    modelId: ctx.model?.id ?? null,
    modelPublicId: ctx.model?.publicId ?? "",
    endpoint: ctx.pathname,
    method: ctx.method,
    streamed: extra.streamed,
    status: extra.status,
    errorCode: extra.errorCode,
    promptTokens: extra.usage.promptTokens,
    completionTokens: extra.usage.completionTokens,
    totalTokens: extra.usage.totalTokens,
    estimated: extra.estimated,
    latencyMs: Date.now() - ctx.startedAt,
    upstreamLatencyMs: ctx.upstreamLatencyMs,
    createdAt: Date.now(),
  };
}

export function resolveUsage(
  kind: EndpointKind,
  observed: TokenUsage | null,
  promptEstimate: number,
  completionText: string,
): { usage: TokenUsage; estimated: boolean } {
  if (observed) return { usage: observed, estimated: false };
  if (kind !== "chat" && kind !== "responses")
    return { usage: EMPTY_USAGE, estimated: false };
  const completionTokens = estimateTokens(completionText);
  return {
    usage: {
      promptTokens: promptEstimate,
      completionTokens,
      totalTokens: promptEstimate + completionTokens,
    },
    estimated: true,
  };
}
