import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import {
  type ClientKeyRow,
  clientKeys,
  type ModelRow,
  models,
  type ProviderRow,
  providers,
  type UsageLogInsert,
  usageLogs,
} from "../schema.ts";
import { authenticateClient } from "../auth.ts";
import type { LimitWindow } from "../../shared/types.ts";
import {
  classifyHttpFailure,
  markKeyUsed,
  networkFailure,
  recordKeyFailure,
  recordKeySuccess,
  redactSecret,
  selectCandidates,
  upstreamUrl,
} from "./keys.ts";
import {
  isValidHeaderName,
  isValidHeaderValue,
  RESERVED_EXTRA_HEADERS,
} from "../headers.ts";
import {
  checkLimits,
  remainingHeaders,
  requestSlot,
  type RequestSlot,
  usageForWindow,
} from "./limits.ts";
import { isEventStream, parseEventJson, SseSplitter } from "./streaming.ts";
import {
  EMPTY_USAGE,
  estimateChatPromptTokens,
  estimateResponsesPromptTokens,
  estimateTokens,
  extractCompletionText,
  extractDeltaText,
  extractResponsesDeltaText,
  extractResponsesOutputText,
  hasUsageChunkOnly,
  type TokenUsage,
  usageFromAnyJson,
  usageFromChatJson,
} from "./usage.ts";

export type ProxyCtx = { db: AppDb };

const HEADER_TIMEOUT_MS = 120_000;
const NON_STREAM_TIMEOUT_MS = 120_000;

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const DROP_REQUEST_HEADERS = [
  "host",
  "authorization",
  "content-length",
  "accept-encoding",
  // The proxy's own cookies belong to brokey's origin, never to the provider.
  "cookie",
];
const DROP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
];
const STRICT_JSON_PREFIXES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/images/",
];

/** Provider keys currently handling a request; used only to de-prioritise them. */
const busyKeys = new Set<number>();

type EndpointKind = "chat" | "responses" | "embeddings" | "other";

type ProxyErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error";

type AttemptContext = {
  db: AppDb;
  requestId: string;
  clientKey: ClientKeyRow;
  provider: ProviderRow;
  providerKeyId: number;
  model: ModelRow | null;
  pathname: string;
  method: string;
  kind: EndpointKind;
  startedAt: number;
  upstreamLatencyMs: number | null;
  limitHeaders: Record<string, string>;
  estimatedPromptTokens: number;
};

function endpointKind(pathname: string): EndpointKind {
  if (pathname.startsWith("/v1/chat/completions")) return "chat";
  if (pathname.startsWith("/v1/responses")) return "responses";
  if (pathname.startsWith("/v1/embeddings")) return "embeddings";
  return "other";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return record;
}

/** `application/json` or a structured `+json` suffix. */
function isJsonContentType(contentType: string): boolean {
  return /application\/(json|[a-z0-9.+-]+\+json)/i.test(contentType);
}

function jsonError(
  status: number,
  message: string,
  type: ProxyErrorType,
  code: string | null = null,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { message, type, param: null, code } },
    { status, headers },
  );
}

function modelNotFound(publicId: string): Response {
  return jsonError(
    404,
    `The model '${publicId}' does not exist or you do not have access to it.`,
    "invalid_request_error",
    "model_not_found",
  );
}

/**
 * Content types a proxied response may carry. Anything else (notably
 * `text/html` and `image/svg+xml`) is rewritten to octet-stream, so a hostile
 * upstream cannot get script running on brokey's origin where the admin token
 * lives in localStorage.
 */
const SAFE_RESPONSE_TYPE =
  /^(application\/json|application\/[a-z0-9.+-]+\+json|text\/event-stream|text\/plain|application\/octet-stream|image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|multipart\/[a-z0-9.+-]+)/i;

/** Upstream headers that would redirect or re-authenticate the browser. */
const DROPPED_UPSTREAM_HEADERS = ["location", "refresh", "www-authenticate"];

function forwardHeaders(upstream: HeadersInit): Headers {
  const headers = new Headers();
  new Headers(upstream).forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.includes(lower)) return;
    if (DROPPED_UPSTREAM_HEADERS.includes(lower)) return;
    if (lower === "content-type") {
      headers.set(
        "content-type",
        SAFE_RESPONSE_TYPE.test(value.trim())
          ? value
          : "application/octet-stream",
      );
      return;
    }
    headers.set(name, value);
  });
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  return headers;
}

function decorate(
  headers: Headers,
  requestId: string,
  limitHeaders: Record<string, string>,
): Headers {
  headers.set("x-brokey-request-id", requestId);
  for (const [name, value] of Object.entries(limitHeaders))
    headers.set(name, value);
  return headers;
}

function buildUpstreamHeaders(
  req: Request,
  secret: string,
  extra: Record<string, string> | null,
): Headers {
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.includes(lower) || DROP_REQUEST_HEADERS.includes(lower))
      return;
    if (lower.startsWith("proxy-") || lower.startsWith("x-brokey-")) return;
    headers.set(name, value);
  });
  if (extra) {
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  }
  // Applied last so a stored `extraHeaders.authorization` cannot replace the
  // provider credential this attempt is using.
  headers.set("authorization", `Bearer ${secret}`);
  return headers;
}

function parseExtraHeaders(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = objectValue(parsed);
    if (!record) return null;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(record)) {
      if (typeof value !== "string") continue;
      if (!isValidHeaderName(name) || !isValidHeaderValue(value)) continue;
      if (RESERVED_EXTRA_HEADERS.includes(name.toLowerCase())) continue;
      out[name] = value;
    }
    return out;
  } catch {
    return null;
  }
}

function estimatePromptTokens(
  kind: EndpointKind,
  payload: Record<string, unknown> | null,
): number {
  if (!payload) return 0;
  if (kind === "chat") return estimateChatPromptTokens(payload.messages);
  if (kind === "responses") return estimateResponsesPromptTokens(payload.input);
  return 0;
}

export type CatalogModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  context_length?: number;
  max_output_tokens?: number;
};

/**
 * The effective catalog entry for a model: local overrides when set, otherwise
 * the values last synced from the provider.
 */
export function catalogModel(
  model: ModelRow,
  providerName: string,
): CatalogModel {
  const entry: CatalogModel = {
    id: model.publicId,
    object: "model",
    created: Math.floor((model.upstreamCreatedAt ?? model.createdAt) / 1000),
    owned_by: providerName,
    name: model.displayName,
  };
  if (model.contextWindow !== null) entry.context_length = model.contextWindow;
  if (model.maxOutputTokens !== null)
    entry.max_output_tokens = model.maxOutputTokens;
  return entry;
}

function listModelCatalog(db: AppDb): Response {
  const rows = db
    .select({ model: models, providerName: providers.name })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(
      and(
        eq(models.enabled, true),
        eq(models.upstreamAvailable, true),
        eq(providers.enabled, true),
      ),
    )
    .all();
  const data = rows.map(({ model, providerName }) =>
    catalogModel(model, providerName),
  );
  return Response.json({ object: "list", data });
}

function getModelCatalog(db: AppDb, publicId: string): Response {
  const rows = db
    .select({ model: models, providerName: providers.name })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(
      and(
        eq(models.publicId, publicId),
        eq(models.enabled, true),
        eq(models.upstreamAvailable, true),
        eq(providers.enabled, true),
      ),
    )
    .all();
  const row = rows[0];
  if (!row) return modelNotFound(publicId);
  return Response.json(catalogModel(row.model, row.providerName));
}

function writeUsageLog(
  db: AppDb,
  values: UsageLogInsert,
  slot?: RequestSlot,
): void {
  db.insert(usageLogs).values(values).run();
  // The row now counts towards the client key's window, so the in-flight
  // reservation can be dropped.
  slot?.release();
}

function logFor(
  ctx: AttemptContext,
  extra: {
    streamed: boolean;
    status: number;
    errorCode: string | null;
    usage: TokenUsage;
    estimated: boolean;
  },
): UsageLogInsert {
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

function resolveUsage(
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

export async function handleProxy(
  req: Request,
  ctx: ProxyCtx,
): Promise<Response> {
  const db = ctx.db;
  const startedAt = Date.now();
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(req.url);
  const pathname = url.pathname;

  const auth = authenticateClient(req, db);
  if (!auth.ok) return auth.response;
  const clientKey = auth.key;
  db.update(clientKeys)
    .set({ lastUsedAt: startedAt })
    .where(eq(clientKeys.id, clientKey.id))
    .run();

  if (req.method === "GET" && pathname === "/v1/models")
    return listModelCatalog(db);
  if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
    let publicId: string;
    try {
      publicId = decodeURIComponent(pathname.slice("/v1/models/".length));
    } catch {
      return modelNotFound(pathname.slice("/v1/models/".length));
    }
    return getModelCatalog(db, publicId);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const rawBody = hasBody ? new Uint8Array(await req.arrayBuffer()) : null;
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  const jsonEndpoint = STRICT_JSON_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
  // Model authorisation runs on the parsed body, so a JSON endpoint must not be
  // forwardable unparsed with a non-JSON content type.
  if (rawBody && jsonEndpoint && !isJsonContentType(contentType)) {
    return jsonError(
      415,
      "This endpoint requires `content-type: application/json`.",
      "invalid_request_error",
      "unsupported_media_type",
    );
  }

  let payload: Record<string, unknown> | null = null;
  if (rawBody && (jsonEndpoint || isJsonContentType(contentType))) {
    try {
      payload = objectValue(JSON.parse(new TextDecoder().decode(rawBody)));
    } catch {
      if (jsonEndpoint) {
        return jsonError(
          400,
          "We could not parse the JSON body of your request.",
          "invalid_request_error",
        );
      }
    }
  }

  let model: ModelRow | null = null;
  let provider: ProviderRow | null = null;
  const requestedModel =
    payload && typeof payload.model === "string" ? payload.model : null;

  if (requestedModel) {
    const row = db
      .select()
      .from(models)
      .where(eq(models.publicId, requestedModel))
      .get();
    if (!row || !row.enabled || !row.upstreamAvailable)
      return modelNotFound(requestedModel);
    const providerRow = db
      .select()
      .from(providers)
      .where(eq(providers.id, row.providerId))
      .get();
    if (!providerRow) return modelNotFound(requestedModel);
    if (!providerRow.enabled) {
      return jsonError(
        503,
        `Provider "${providerRow.name}" is disabled.`,
        "api_error",
        "provider_unavailable",
      );
    }
    model = row;
    provider = providerRow;
  } else {
    const selector = (
      req.headers.get("x-brokey-provider") ??
      url.searchParams.get("provider") ??
      ""
    ).trim();
    if (selector !== "") {
      const providerRow = db
        .select()
        .from(providers)
        .where(eq(providers.name, selector))
        .get();
      if (!providerRow) {
        return jsonError(
          400,
          `Unknown provider "${selector}".`,
          "invalid_request_error",
          "invalid_provider",
        );
      }
      if (!providerRow.enabled) {
        return jsonError(
          503,
          `Provider "${providerRow.name}" is disabled.`,
          "api_error",
          "provider_unavailable",
        );
      }
      provider = providerRow;
    } else {
      const enabledProviders = db
        .select()
        .from(providers)
        .where(eq(providers.enabled, true))
        .all();
      if (enabledProviders.length !== 1) {
        return jsonError(
          400,
          "Select a provider with the `x-brokey-provider` header or the `?provider=` query parameter, or send a request whose model routes to a provider.",
          "invalid_request_error",
          "missing_provider",
        );
      }
      provider = enabledProviders[0] as ProviderRow;
    }
  }

  const kind = endpointKind(pathname);
  const estimatedPromptTokens = estimatePromptTokens(kind, payload);

  const windowUsage = usageForWindow(
    db,
    clientKey.id,
    clientKey.limitWindow as LimitWindow,
    startedAt,
  );
  const violation = checkLimits(clientKey, windowUsage);
  if (violation) {
    return jsonError(
      429,
      violation.message,
      "insufficient_quota",
      "usage_limit_exceeded",
    );
  }
  const limitHeaders = remainingHeaders(
    clientKey,
    windowUsage,
    estimatedPromptTokens,
  );

  const pool = selectCandidates(db, provider.id, startedAt, busyKeys);
  if (!pool.hasEnabledKeys) {
    return jsonError(
      503,
      `No enabled API keys for provider "${provider.name}".`,
      "api_error",
      "provider_unavailable",
    );
  }
  if (pool.candidates.length === 0) {
    const waitSeconds = pool.earliestCooldown
      ? Math.max(1, Math.ceil((pool.earliestCooldown - startedAt) / 1000))
      : 60;
    return jsonError(
      429,
      "All API keys for this provider are temporarily unavailable.",
      "rate_limit_error",
      "all_keys_exhausted",
      { "retry-after": String(waitSeconds) },
    );
  }

  // Body after optional model rewriting; the version without `stream_options` is
  // kept for the fallback retry when an upstream rejects the injected option.
  const bodyBase =
    payload && model
      ? new TextEncoder().encode(
          JSON.stringify({ ...payload, model: model.upstreamId }),
        )
      : rawBody;
  const requestPayload =
    payload && model ? { ...payload, model: model.upstreamId } : payload;
  const streamingRequest =
    kind === "chat" && req.method === "POST" && requestPayload?.stream === true;

  let injectedUsage = false;
  let clientWantedUsage = false;
  if (streamingRequest && requestPayload) {
    const options = objectValue(requestPayload.stream_options);
    if (options?.include_usage === true) {
      clientWantedUsage = true;
    } else {
      requestPayload.stream_options = {
        ...(options ?? {}),
        include_usage: true,
      };
      injectedUsage = true;
    }
  }
  const bodyWithInjection = injectedUsage
    ? new TextEncoder().encode(JSON.stringify(requestPayload))
    : bodyBase;

  const upstream = upstreamUrl(provider.baseUrl, pathname, url.search);
  const extraHeaders = parseExtraHeaders(provider.extraHeaders);

  let lastFailure: {
    status: number;
    body: string;
    code: string;
    headers: Headers;
  } | null = null;
  let lastMessage = "";
  let cooledAny = false;
  let upstreamLatencyMs: number | null = null;

  // Reservations make the request cap exact under concurrency; the slot is
  // released when this request's usage row is written.
  const slot = requestSlot(clientKey.id);
  const log = (values: UsageLogInsert) => writeUsageLog(db, values, slot);

  for (const key of pool.candidates) {
    busyKeys.add(key.id);
    const attemptCtx: AttemptContext = {
      db,
      requestId,
      clientKey,
      provider,
      providerKeyId: key.id,
      model,
      pathname,
      method: req.method,
      kind,
      startedAt,
      upstreamLatencyMs: null,
      limitHeaders,
      estimatedPromptTokens,
    };
    try {
      markKeyUsed(db, key.id, Date.now());
      const headers = buildUpstreamHeaders(req, key.secret, extraHeaders);
      const controller = new AbortController();
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      const signal = streamingRequest
        ? AbortSignal.any([controller.signal, req.signal])
        : AbortSignal.any([
            AbortSignal.timeout(NON_STREAM_TIMEOUT_MS),
            req.signal,
          ]);
      if (streamingRequest)
        headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);

      const attemptStarted = Date.now();
      let response: Response;
      try {
        response = await fetch(upstream, {
          method: req.method,
          headers,
          body: bodyWithInjection ?? undefined,
          signal,
          redirect: "manual",
        });
      } catch (error) {
        clearTimeout(headerTimer);
        if (req.signal.aborted) {
          log(
            logFor(attemptCtx, {
              streamed: streamingRequest,
              status: 499,
              errorCode: "client_aborted",
              usage: {
                ...EMPTY_USAGE,
                promptTokens: estimatedPromptTokens,
                totalTokens: estimatedPromptTokens,
              },
              estimated: true,
            }),
          );
          return jsonError(
            499,
            "Client closed request.",
            "api_error",
            "client_aborted",
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        lastMessage = `Upstream request failed: ${message}`;
        recordKeyFailure(db, key.id, networkFailure(), lastMessage);
        cooledAny = true;
        continue;
      }
      clearTimeout(headerTimer);
      if (upstreamLatencyMs === null)
        upstreamLatencyMs = Date.now() - attemptStarted;

      attemptCtx.upstreamLatencyMs = upstreamLatencyMs;

      // Some upstreams reject `stream_options`; retry once with the original body.
      if (!response.ok && injectedUsage && response.status === 400) {
        await response.body?.cancel().catch(() => undefined);
        try {
          response = await fetch(upstream, {
            method: req.method,
            headers,
            body: bodyBase ?? undefined,
            signal: AbortSignal.any([
              AbortSignal.timeout(HEADER_TIMEOUT_MS),
              req.signal,
            ]),
            redirect: "manual",
          });
          injectedUsage = false;
          clientWantedUsage = false;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          lastMessage = redactSecret(
            `Upstream request failed: ${message}`,
            key.secret,
          );
          recordKeyFailure(db, key.id, networkFailure(), lastMessage);
          cooledAny = true;
          continue;
        }
      }

      if (!response.ok) {
        // Upstream error bodies can echo the credential back; scrub it before
        // it reaches a log row or the client.
        const text = redactSecret(
          await response
            .clone()
            .text()
            .catch(() => ""),
          key.secret,
        );
        const failure = classifyHttpFailure(
          response.status,
          text,
          response.headers.get("retry-after"),
        );
        if (failure.retryable) {
          recordKeyFailure(
            db,
            key.id,
            failure,
            `HTTP ${response.status}: ${text.slice(0, 400)}`,
          );
          cooledAny = true;
          lastFailure = {
            status: response.status,
            body: text,
            code: failure.errorCode,
            headers: response.headers,
          };
          continue;
        }
        recordKeySuccess(db, key.id);
        const textual =
          /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(
            response.headers.get("content-type") ?? "",
          );
        const errorBytes = textual
          ? new TextEncoder().encode(text)
          : (await readBodyCapped(response, MAX_ERROR_BODY_BYTES)).bytes;
        log(
          logFor(attemptCtx, {
            streamed: streamingRequest,
            status: response.status,
            errorCode: `http_${response.status}`,
            usage: EMPTY_USAGE,
            estimated: false,
          }),
        );
        return new Response(errorBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: decorate(
            forwardHeaders(response.headers),
            requestId,
            limitHeaders,
          ),
        });
      }

      recordKeySuccess(db, key.id);

      if (streamingRequest && response.body) {
        return streamResponse(response, attemptCtx, {
          injectedUsage,
          clientWantedUsage,
          streaming: true,
          clientSignal: req.signal,
          onLogged: () => slot.release(),
        });
      }

      let body: { bytes: Uint8Array<ArrayBuffer>; truncated: boolean };
      try {
        body = await readBodyCapped(response, MAX_UPSTREAM_BODY_BYTES);
      } catch (error) {
        const aborted = req.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        log(
          logFor(attemptCtx, {
            streamed: false,
            status: aborted ? 499 : 504,
            errorCode: aborted ? "client_aborted" : "timeout",
            usage: {
              ...EMPTY_USAGE,
              promptTokens: estimatedPromptTokens,
              totalTokens: estimatedPromptTokens,
            },
            estimated: true,
          }),
        );
        if (aborted)
          return jsonError(
            499,
            "Client closed request.",
            "api_error",
            "client_aborted",
          );
        return jsonError(
          504,
          `Upstream response failed: ${message}`,
          "api_error",
          "timeout",
        );
      }

      if (body.truncated) {
        log(
          logFor(attemptCtx, {
            streamed: false,
            status: 502,
            errorCode: "response_too_large",
            usage: EMPTY_USAGE,
            estimated: false,
          }),
        );
        return jsonError(
          502,
          `Upstream response exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes.`,
          "api_error",
          "response_too_large",
        );
      }

      const parsed = parseJsonBytes(body.bytes);
      const observed = usageFromAnyJson(parsed);
      const completionText =
        kind === "chat"
          ? extractCompletionText(parsed)
          : kind === "responses"
            ? extractResponsesOutputText(parsed)
            : "";
      const resolved = resolveUsage(
        kind,
        observed,
        estimatedPromptTokens,
        completionText,
      );
      log(
        logFor(attemptCtx, {
          streamed: false,
          status: response.status,
          errorCode: null,
          usage: resolved.usage,
          estimated: resolved.estimated,
        }),
      );
      return new Response(body.bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: decorate(
          forwardHeaders(response.headers),
          requestId,
          limitHeaders,
        ),
      });
    } finally {
      busyKeys.delete(key.id);
    }
  }

  return allKeysFailed(db, {
    requestId,
    clientKey,
    provider,
    model,
    pathname,
    method: req.method,
    streaming: streamingRequest,
    startedAt,
    upstreamLatencyMs,
    limitHeaders,
    lastFailure,
    lastMessage,
    cooledAny,
    slot,
  });
}

/** Error bodies only need the head; completions can be large but not infinite. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 32 * 1024 * 1024;

function concatChunks(
  chunks: Uint8Array[],
  total: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a response body while enforcing a byte cap, so a hostile or broken
 * upstream cannot make the proxy buffer without bound.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: new Uint8Array(0), truncated: true };
  }
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return {
          bytes: concatChunks(chunks, total - value.byteLength),
          truncated: true,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: concatChunks(chunks, total), truncated: false };
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

type StreamOptions = {
  injectedUsage: boolean;
  clientWantedUsage: boolean;
  streaming: boolean;
  clientSignal: AbortSignal;
  onLogged: () => void;
};

function streamErrorEvent(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: "api_error",
      param: null,
      code: "stream_error",
    },
  })}\n\n`;
}

function streamResponse(
  response: Response,
  ctx: AttemptContext,
  options: StreamOptions,
): Response {
  const sse = isEventStream(response.headers.get("content-type"));
  const reader = response.body!.getReader();
  const splitter = new SseSplitter();
  const encoder = new TextEncoder();
  let observed: TokenUsage | null = null;
  let text = "";
  let logged = false;
  let cancelled = false;

  const record = (status: number, errorCode: string | null) => {
    if (logged) return;
    logged = true;
    const resolved = resolveUsage(
      ctx.kind,
      observed,
      ctx.estimatedPromptTokens,
      text,
    );
    writeUsageLog(
      ctx.db,
      logFor(ctx, {
        streamed: true,
        status,
        errorCode,
        usage: resolved.usage,
        estimated: resolved.estimated,
      }),
    );
    options.onLogged();
  };

  const collect = (chunk: unknown) => {
    if (!chunk) return;
    // Quota accounting must not depend on the endpoint: completions, images and
    // anything else that reports usage counts the same way as chat.
    observed ??= usageFromAnyJson(chunk);
    if (ctx.kind === "chat") {
      text += extractDeltaText(chunk);
      return;
    }
    if (ctx.kind === "responses") text += extractResponsesDeltaText(chunk);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!sse) {
            controller.enqueue(value);
            continue;
          }
          for (const frame of splitter.push(value)) {
            const chunk = parseEventJson(frame.raw);
            collect(chunk);
            const drop =
              options.injectedUsage &&
              !options.clientWantedUsage &&
              hasUsageChunkOnly(chunk);
            if (!drop)
              controller.enqueue(encoder.encode(frame.raw + frame.separator));
          }
        }
        if (sse) {
          for (const frame of splitter.flush()) {
            const chunk = parseEventJson(frame.raw);
            collect(chunk);
            const drop =
              options.injectedUsage &&
              !options.clientWantedUsage &&
              hasUsageChunkOnly(chunk);
            if (!drop)
              controller.enqueue(encoder.encode(frame.raw + frame.separator));
          }
        }
        controller.close();
        record(response.status, null);
      } catch (error) {
        // A client that stops reading mid-stream has not failed anything:
        // tool-calling agents typically hang up the moment they have the tool
        // call. Only a broken body with a client still waiting is an upstream
        // failure (502 + cooldown); abandonment records the delivered result.
        const abandoned =
          cancelled || options.clientSignal.aborted || isAbort(error);
        if (abandoned) {
          record(response.status, null);
        } else {
          record(502, "stream_error");
          const message =
            error instanceof Error ? error.message : String(error);
          // The key delivered headers but broke the body, so it deserves the
          // same cooldown as a failed connection.
          recordKeyFailure(
            ctx.db,
            ctx.providerKeyId,
            networkFailure(),
            `Upstream stream failed: ${message}`,
          );
          if (sse) {
            // Ending the response with a reset makes clients report a
            // transport-level ECONNRESET. An in-band error event tells them
            // what actually failed while keeping the response well-formed.
            try {
              controller.enqueue(encoder.encode(streamErrorEvent(message)));
              controller.close();
              return;
            } catch {
              // the consumer is already gone
            }
          }
        }
        try {
          controller.error(error);
        } catch {
          // the consumer is already gone
        }
      }
    },
    cancel() {
      // Flagged before the reader is torn down, so the rejection our own
      // cancel injects into the pending read classifies as abandonment.
      cancelled = true;
      reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: decorate(
      forwardHeaders(response.headers),
      ctx.requestId,
      ctx.limitHeaders,
    ),
  });
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // Match the abort type, never substrings of the message: Bun reports an
  // upstream reset as `ECONNRESET: The socket connection was closed
  // unexpectedly`, which is a network failure, not a client abort.
  if ("name" in error && error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

type FailedAttemptSummary = {
  requestId: string;
  clientKey: ClientKeyRow;
  provider: ProviderRow;
  model: ModelRow | null;
  pathname: string;
  method: string;
  streaming: boolean;
  startedAt: number;
  upstreamLatencyMs: number | null;
  limitHeaders: Record<string, string>;
  lastFailure: {
    status: number;
    body: string;
    code: string;
    headers: Headers;
  } | null;
  slot: RequestSlot;
  lastMessage: string;
  cooledAny: boolean;
};

function allKeysFailed(db: AppDb, summary: FailedAttemptSummary): Response {
  const fallbackStatus = summary.cooledAny ? 429 : 502;
  const status = summary.lastFailure?.status ?? fallbackStatus;
  const errorCode =
    summary.lastFailure?.code ??
    (summary.cooledAny ? "all_keys_exhausted" : "upstream_unavailable");

  writeUsageLog(
    db,
    {
      requestId: summary.requestId,
      clientKeyId: summary.clientKey.id,
      clientKeyLabel: summary.clientKey.name,
      providerId: summary.provider.id,
      providerName: summary.provider.name,
      providerKeyId: null,
      modelId: summary.model?.id ?? null,
      modelPublicId: summary.model?.publicId ?? "",
      endpoint: summary.pathname,
      method: summary.method,
      streamed: summary.streaming,
      status,
      errorCode,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: Date.now() - summary.startedAt,
      upstreamLatencyMs: summary.upstreamLatencyMs,
      createdAt: Date.now(),
    },
    summary.slot,
  );

  if (summary.lastFailure) {
    return new Response(summary.lastFailure.body, {
      status: summary.lastFailure.status,
      headers: decorate(
        forwardHeaders(summary.lastFailure.headers),
        summary.requestId,
        summary.limitHeaders,
      ),
    });
  }
  if (summary.cooledAny) {
    return jsonError(
      429,
      "All API keys for this provider are temporarily unavailable.",
      "rate_limit_error",
      "all_keys_exhausted",
      {
        "retry-after": "60",
        ...summary.limitHeaders,
        "x-brokey-request-id": summary.requestId,
      },
    );
  }
  return jsonError(
    502,
    summary.lastMessage || "Upstream is unreachable.",
    "api_error",
    "upstream_unavailable",
    { ...summary.limitHeaders, "x-brokey-request-id": summary.requestId },
  );
}
