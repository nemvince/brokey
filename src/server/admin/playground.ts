import { and, asc, eq } from "drizzle-orm";
import { HttpError, json, readJson } from "../errors.ts";
import { clientKeys, models, providers } from "../schema.ts";
import { hashClientToken } from "../auth.ts";
import {
  asBool,
  asEnum,
  asOptionalInt,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
} from "../validate.ts";
import type {
  PlaygroundMessageRole,
  PlaygroundModelDTO,
  PlaygroundResult,
  ProviderKind,
} from "../../shared/types.ts";
import type { AdminCtx } from "./context.ts";
import { handleProxy } from "../proxy/handler.ts";
import {
  type TokenUsage,
  EMPTY_USAGE,
  extractCompletionText,
  extractDeltaText,
  loggedUsage,
  usageFromAnyJson,
  usageFromChatJson,
} from "../proxy/usage.ts";
import {
  isEventStream,
  parseEventJson,
  SseSplitter,
} from "../proxy/streaming.ts";

/**
 * A playground run goes through the real proxy, so it picks a key, retries a
 * failed one, honors cooldowns, and lands in the usage log exactly like a
 * client request. Its client key row exists only for the run and is deleted
 * once the proxy has authenticated it: the usage row written afterwards then
 * references no key, so testing cannot spend a real key's quota or appear in
 * that key's usage.
 */
const INTERNAL_TOKEN_PREFIX = "sk-brokey-playground-";
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100_000;

const MESSAGE_ROLES: readonly PlaygroundMessageRole[] = [
  "system",
  "user",
  "assistant",
];

export function listPlaygroundModels(ctx: AdminCtx): Response {
  const rows = ctx.db
    .select({
      model: models,
      providerName: providers.name,
      kind: providers.kind,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(
      and(
        eq(models.enabled, true),
        eq(models.upstreamAvailable, true),
        eq(providers.enabled, true),
      ),
    )
    .orderBy(asc(models.publicId))
    .all();
  const catalog: PlaygroundModelDTO[] = rows.map((row) => ({
    publicId: row.model.publicId,
    providerName: row.providerName,
    displayName: row.model.displayName,
    contextWindow: row.model.contextWindow,
    maxOutputTokens: row.model.maxOutputTokens,
    providerKind: row.kind as ProviderKind,
  }));
  return json({ models: catalog });
}

type ParsedMessage = { role: PlaygroundMessageRole; content: string };

/** Text parts are joined, so an OpenAI-style `content` array is accepted. */
function contentText(value: unknown, field: string): string {
  if (typeof value === "string") {
    if (value.length > MAX_MESSAGE_CHARS) {
      throw new HttpError(
        400,
        `\`${field}\` exceeds ${MAX_MESSAGE_CHARS} characters.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    let text = "";
    for (const part of value) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      const record = asRecord(part);
      const type = record.type;
      if (type !== undefined && type !== "text") continue;
      text += contentText(record.text, field);
    }
    return text;
  }
  throw new HttpError(400, `\`${field}\` must be a string.`);
}

function parseMessage(value: unknown, index: number): ParsedMessage {
  const record = asRecord(value);
  const role = asEnum(record.role, `messages[${index}].role`, MESSAGE_ROLES);
  const content = contentText(record.content, `messages[${index}].content`);
  return { role, content };
}

function cleanErrorText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "The request failed with an empty error body.";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const head = (parsed as Record<string, unknown>).error ?? parsed;
      if (head && typeof head === "object") {
        const message = (head as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim() !== "")
          return message.trim();
      }
    }
  } catch {
    // Not JSON: the body itself is the message.
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

function resultResponse(result: PlaygroundResult): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(result.requestId === null
        ? {}
        : { "x-brokey-request-id": result.requestId }),
    },
  });
}

type FrameSink = {
  /** Text so far, which also decides whether a failure is still pre-stream. */
  text: string;
  error: string | null;
  usage: TokenUsage | null;
};

/**
 * Consumes one upstream SSE frame, appending brokey's own event vocabulary
 * (`delta`) to `queued`. The page never parses a provider dialect: the proxy has
 * already normalized the stream to chat chunks on every path, including the
 * OpenCode lane's `reasoning` and tool-name rewrites.
 */
function consumeFrame(frame: string, state: FrameSink, queued: string[]): void {
  const chunk = parseEventJson(frame);
  if (chunk === null) return;
  const record = chunk as Record<string, unknown>;

  // A stream has already sent `200`, so a provider failure can only arrive as
  // an event; it ends the run even though the status line said success.
  const failure = record.error;
  if (failure && typeof failure === "object") {
    const message = (failure as Record<string, unknown>).message;
    state.error = cleanErrorText(typeof message === "string" ? message : frame);
    return;
  }
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== "object") continue;
      const finish = (choice as Record<string, unknown>).finish_reason;
      if (finish === "content_filter") {
        state.error = "The provider filtered this completion.";
        return;
      }
    }
  }
  const observed = usageFromChatJson(chunk);
  if (observed) state.usage = observed;
  const delta = extractDeltaText(chunk);
  if (delta === "") return;
  state.text += delta;
  queued.push(`data: ${JSON.stringify({ delta })}\n\n`);
}

export async function runPlayground(ctx: AdminCtx): Promise<Response> {
  const body = asRecord(await readJson(ctx.req));
  const requested = asString(body.model, "model", {
    min: 1,
    max: 200,
    trim: true,
  });
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array.");
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new HttpError(
      400,
      `\`messages\` may hold at most ${MAX_MESSAGES} entries.`,
    );
  }
  const messages = body.messages.map(parseMessage);
  if (!messages.some((message) => message.role === "user")) {
    throw new HttpError(400, "At least one message must have role `user`.");
  }

  // A model is named by its catalog id; the row supplies the upstream id the
  // provider expects and the kind that decides the routing path.
  const routed = ctx.db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.publicId, requested))
    .get();
  const upstreamId = routed?.model.upstreamId ?? requested;

  let route: "proxy" | "direct";
  if (body.route === undefined) {
    route = routed?.provider.kind === "opencode" ? "proxy" : "direct";
  } else {
    route = asEnum(body.route, "route", ["proxy", "direct"] as const);
  }
  if (route === "direct" && !routed) {
    throw new HttpError(
      400,
      `Unknown model "${requested}".`,
      "model_unavailable",
    );
  }
  if (routed && (!routed.model.enabled || !routed.model.upstreamAvailable)) {
    throw new HttpError(
      400,
      `Model "${requested}" is not enabled for requests.`,
      "model_unavailable",
    );
  }
  if (routed && !routed.provider.enabled) {
    throw new HttpError(
      400,
      `Provider "${routed.provider.name}" is disabled.`,
      "provider_unavailable",
    );
  }

  const stream =
    body.stream === undefined ? true : asBool(body.stream, "stream");
  const temperature = asOptionalNumber(body.temperature, "temperature", {
    min: 0,
    max: 2,
  });
  const maxTokens = asOptionalInt(body.maxTokens, "maxTokens", { min: 1 });
  const systemPrompt =
    asOptionalString(body.systemPrompt, "systemPrompt", {
      max: MAX_MESSAGE_CHARS,
    }) ?? "";

  const payload: Record<string, unknown> = {
    messages: [
      ...(systemPrompt.trim() === ""
        ? []
        : [{ role: "system", content: systemPrompt }]),
      ...messages,
    ],
    stream,
  };
  if (temperature !== null && temperature !== undefined) {
    payload.temperature = temperature;
  }
  if (maxTokens !== null && maxTokens !== undefined) {
    payload.max_completion_tokens = maxTokens;
  }

  const startedAt = Date.now();
  const token = `${INTERNAL_TOKEN_PREFIX}${crypto.randomUUID()}`;
  const internal = ctx.db
    .insert(clientKeys)
    .values({
      name: "playground",
      keyHash: hashClientToken(token),
      keyPrefix: token.slice(0, 14),
      enabled: true,
      limitWindow: "total",
      limitTokens: null,
      limitRequests: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      lastUsedAt: null,
    })
    .returning()
    .get();
  if (!internal)
    throw new HttpError(500, "Failed to start the playground run.");

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (route === "direct" && routed)
    headers["x-brokey-provider"] = routed.provider.name;

  let response: Response;
  // The proxy writes its usage row when its stream reaches the end, and that row
  // references this key. Deleting the key earlier breaks the foreign key, so
  // every exit path below releases it only once the proxy body is consumed.
  const releaseKey = () =>
    ctx.db.delete(clientKeys).where(eq(clientKeys.id, internal.id)).run();
  try {
    response = await handleProxy(
      new Request(new URL("/v1/chat/completions", ctx.url).toString(), {
        method: "POST",
        headers,
        // The OpenCode lane resolves a free model by its upstream id (a family
        // shorthand such as `mimo`), while the key-pool path resolves the
        // public id and rewrites it for the provider itself.
        body: JSON.stringify({
          ...payload,
          model: route === "proxy" ? upstreamId : requested,
        }),
        signal: ctx.req.signal,
      }),
      { db: ctx.db, opencode: ctx.opencode },
    );
  } catch (error) {
    releaseKey();
    throw error;
  }

  const requestId = response.headers.get("x-brokey-request-id");
  const contentType = response.headers.get("content-type");

  if (!isEventStream(contentType) || response.body === null) {
    const raw = await response.text();
    releaseKey();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const result: PlaygroundResult = {
      status: response.status,
      content: response.ok && parsed ? extractCompletionText(parsed) : "",
      error: response.ok ? null : cleanErrorText(raw),
      streamed: false,
      usage:
        (parsed ? usageFromAnyJson(parsed) : null) ??
        (requestId === null ? null : loggedUsage(ctx.db, requestId)) ??
        EMPTY_USAGE,
      requestId,
      latencyMs: Date.now() - startedAt,
    };
    return resultResponse(result);
  }

  const reader = response.body.getReader();
  const splitter = new SseSplitter();
  const encoder = new TextEncoder();
  const state: FrameSink = { text: "", error: null, usage: null };
  const queued: string[] = [];
  let live = true;

  /** Reads one upstream chunk into `queued`; false once the body is done. */
  const pull = async (): Promise<boolean> => {
    const next = await reader.read();
    if (next.done) {
      for (const frame of splitter.flush()) {
        consumeFrame(frame.raw, state, queued);
      }
      return false;
    }
    for (const frame of splitter.push(next.value)) {
      consumeFrame(frame.raw, state, queued);
    }
    return state.error === null;
  };

  /** Consumes the rest of the proxy stream so it can finish its usage row. */
  const drain = async () => {
    try {
      while (live) live = await pull();
    } catch {
      // A broken upstream body is already a failed run.
    }
    releaseKey();
  };

  // A stream opens with status 200, so a provider failure arrives as an early
  // event. Hold until the first text: a run that fails before it is answered
  // as one JSON result, not an empty stream plus an error.
  while (live && state.text === "" && state.error === null) live = await pull();

  if (state.error !== null && queued.length === 0) {
    await drain();
    return resultResponse({
      status: response.status,
      content: "",
      error: state.error,
      streamed: false,
      usage: EMPTY_USAGE,
      requestId,
      latencyMs: Date.now() - startedAt,
    });
  }

  const streamHeaders = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  if (requestId !== null) streamHeaders.set("x-brokey-request-id", requestId);

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const flush = () => {
        for (const event of queued.splice(0)) send(event);
      };
      flush();
      try {
        while (live && state.error === null) {
          live = await pull();
          flush();
        }
      } catch {
        state.error ??= "The stream was interrupted.";
      }
      // The proxy sees a stop mid-stream and records what it delivered, so the
      // remainder is drained even after a failure: its usage row needs the key.
      await drain();
      if (state.error !== null) {
        send(`data: ${JSON.stringify({ error: state.error })}\n\n`);
        // A failed stream is complete; the usage row the proxy wrote records
        // the failure, so no usage event is sent for it.
        send("data: [DONE]\n\n");
        controller.close();
        return;
      }
      // Its own usage chunk is stripped when the client did not request one, so
      // the row it just wrote is the authority on what the run cost.
      const usage =
        state.usage ??
        (requestId === null ? null : loggedUsage(ctx.db, requestId)) ??
        EMPTY_USAGE;
      send(`data: ${JSON.stringify({ usage })}\n\n`);
      send("data: [DONE]\n\n");
      controller.close();
    },
    async cancel() {
      await drain();
    },
  });

  return new Response(out, { status: 200, headers: streamHeaders });
}
