import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import { usageLogs } from "../schema.ts";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (Array.isArray(part)) return part.map(partText).join("");
  if (part && typeof part === "object") {
    const obj = part as Record<string, unknown>;
    if (
      typeof obj.text === "string" &&
      (obj.type === undefined || obj.type === "text")
    ) {
      return obj.text;
    }
    if (obj.content !== undefined) return partText(obj.content);
  }
  return "";
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const obj = message as Record<string, unknown>;
    return partText(obj.content) + partText(obj.text);
  }
  return "";
}

export function estimateChatPromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) chars += messageText(message).length;
  return Math.ceil(chars / 4) + 4 * messages.length;
}

export function estimateResponsesPromptTokens(input: unknown): number {
  if (typeof input === "string") return estimateTokens(input);
  if (!Array.isArray(input)) return 0;
  let chars = 0;
  for (const item of input) chars += messageText(item).length;
  return Math.ceil(chars / 4) + 4 * input.length;
}

export function usageFromChatJson(obj: unknown): TokenUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const usage = (obj as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = numberOrNull(record.prompt_tokens) ?? 0;
  const completionTokens = numberOrNull(record.completion_tokens) ?? 0;
  const totalTokens =
    numberOrNull(record.total_tokens) ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0)
    return null;
  return { promptTokens, completionTokens, totalTokens };
}

export function usageFromResponsesJson(obj: unknown): TokenUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const root = obj as Record<string, unknown>;
  const candidates: unknown[] = [root.usage];
  if (root.response && typeof root.response === "object") {
    candidates.unshift((root.response as Record<string, unknown>).usage);
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const promptTokens = numberOrNull(record.input_tokens) ?? 0;
    const completionTokens = numberOrNull(record.output_tokens) ?? 0;
    const totalTokens =
      numberOrNull(record.total_tokens) ?? promptTokens + completionTokens;
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0)
      continue;
    return { promptTokens, completionTokens, totalTokens };
  }
  return null;
}

/**
 * Any OpenAI-shaped usage block, regardless of endpoint: chat (`prompt_tokens`),
 * responses (`input_tokens`), or embeddings. Quota accounting must not depend on
 * which path the client used.
 */
export function usageFromAnyJson(obj: unknown): TokenUsage | null {
  return (
    usageFromChatJson(obj) ??
    usageFromResponsesJson(obj) ??
    usageFromEmbeddingsJson(obj)
  );
}

export function usageFromEmbeddingsJson(obj: unknown): TokenUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const usage = (obj as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = numberOrNull(record.prompt_tokens) ?? 0;
  const totalTokens = numberOrNull(record.total_tokens) ?? promptTokens;
  if (promptTokens === 0 && totalTokens === 0) return null;
  return { promptTokens, completionTokens: 0, totalTokens };
}

export function extractCompletionText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const choices = (obj as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return "";
  const parts: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const record = choice as Record<string, unknown>;
    const message = record.message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") parts.push(content);
      else parts.push(partText(content));
    }
    const text = record.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("");
}

export function extractDeltaText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const choices = (obj as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return "";
  const parts: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object") continue;
    const record = delta as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") parts.push(content);
    else parts.push(partText(content));
    // Tool-call argument deltas are model output too; counting them keeps
    // token estimates sane when the stream ends without a usage chunk.
    const toolCalls = record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        const fn = (call as Record<string, unknown>).function;
        if (fn && typeof fn === "object") {
          const args = (fn as Record<string, unknown>).arguments;
          if (typeof args === "string") parts.push(args);
        }
      }
    }
  }
  return parts.join("");
}

export function extractResponsesOutputText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const output = (obj as Record<string, unknown>).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

export function extractResponsesDeltaText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const record = obj as Record<string, unknown>;
  if (
    record.type === "response.output_text.delta" &&
    typeof record.delta === "string"
  ) {
    return record.delta;
  }
  return "";
}

export function hasUsageChunkOnly(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const record = obj as Record<string, unknown>;
  const choices = record.choices;
  const hasEmptyChoices = Array.isArray(choices) && choices.length === 0;
  return hasEmptyChoices && record.usage !== undefined && record.usage !== null;
}

/**
 * The token counts the proxy recorded for one request. A streamed response can
 * omit its usage chunk when the client did not ask for one (the proxy injects
 * and then strips it), so the log row is the only place the real totals exist.
 */
export function loggedUsage(db: AppDb, requestId: string): TokenUsage | null {
  const row = db
    .select({
      prompt: usageLogs.promptTokens,
      completion: usageLogs.completionTokens,
    })
    .from(usageLogs)
    .where(eq(usageLogs.requestId, requestId))
    .orderBy(desc(usageLogs.id))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    promptTokens: row.prompt,
    completionTokens: row.completion,
    totalTokens: row.prompt + row.completion,
  };
}
