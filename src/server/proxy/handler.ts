import { and, asc, eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import {
  type ClientKeyRow,
  clientKeys,
  type ModelRow,
  models,
  type ProviderRow,
  providers,
  type UsageLogInsert,
} from "../schema.ts";
import { authenticateClient } from "../auth.ts";
import type { LimitWindow } from "../../shared/types.ts";
import {
  classifyHttpFailure,
  failureReasonLabel,
  markKeyUsed,
  networkFailure,
  recordKeyFailure,
  recordKeySuccess,
  redactSecret,
  selectCandidates,
  upstreamUrl,
} from "./keys.ts";
import { HOP_BY_HOP, parseStoredExtraHeaders } from "../headers.ts";
import {
  checkLimits,
  remainingHeaders,
  requestSlot,
  type RequestSlot,
  usageForWindow,
} from "./limits.ts";
import {
  isAbort,
  isEventStream,
  parseEventJson,
  parseJsonBytes,
  readBodyCapped,
  SseSplitter,
  streamErrorEvent,
} from "./streaming.ts";
import {
  type AttemptContext,
  type EndpointKind,
  logFor,
  resolveUsage,
  writeUsageLog,
} from "./log.ts";
import { decorate, forwardHeaders, jsonError } from "./response.ts";
import { handleOpenCodeRequest } from "./opencode/handler.ts";
import type { OpenCodeRuntime } from "./opencode/runtime.ts";
import {
  EMPTY_USAGE,
  estimateChatPromptTokens,
  estimateResponsesPromptTokens,
  extractCompletionText,
  extractDeltaText,
  extractResponsesDeltaText,
  extractResponsesOutputText,
  hasUsageChunkOnly,
  type TokenUsage,
  usageFromAnyJson,
  usageFromChatJson,
} from "./usage.ts";

export type ProxyCtx = { db: AppDb; opencode: OpenCodeRuntime };

const HEADER_TIMEOUT_MS = 120_000;
const NON_STREAM_TIMEOUT_MS = 120_000;

const DROP_REQUEST_HEADERS = [
  "host",
  "authorization",
  "content-length",
  "accept-encoding",
  // The proxy's own cookies belong to brokey's origin, never to the provider.
  "cookie",
];
const STRICT_JSON_PREFIXES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/images/",
];

/** Provider keys currently handling a request; used only to de-prioritise them. */
const busyKeys = new Set<number>();

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

function modelNotFound(publicId: string): Response {
  return jsonError(
    404,
    `The model '${publicId}' does not exist or you do not have access to it.`,
    "invalid_request_error",
    "model_not_found",
  );
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

/**
 * The enabled OpenCode model that answers to an upstream id, lowest id first:
 * aliases resolve to one row, so two providers cannot both claim a shorthand.
 */
function findOpenCodeModel(
  db: AppDb,
  upstreamId: string,
): { model: ModelRow; provider: ProviderRow } | null {
  const rows = db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(
      and(
        eq(models.upstreamId, upstreamId),
        eq(models.enabled, true),
        eq(models.upstreamAvailable, true),
        eq(providers.kind, "opencode"),
        eq(providers.enabled, true),
      ),
    )
    .orderBy(asc(models.id))
    .all();
  return rows[0] ?? null;
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
    let row = db
      .select()
      .from(models)
      .where(eq(models.publicId, requestedModel))
      .get();
    let providerRow =
      row && row.enabled && row.upstreamAvailable
        ? db
            .select()
            .from(providers)
            .where(eq(providers.id, row.providerId))
            .get()
        : undefined;
    if (!row || !row.enabled || !row.upstreamAvailable || !providerRow) {
      // A family shorthand (`mimo`, `deepseek`) selects the synced free model
      // of that family, so a client can name a provider family, not an id.
      let alias = ctx.opencode.resolveModelAlias(requestedModel);
      if (alias === null) {
        // A cold start has no catalog yet; one cached load makes the shorthand
        // work on the first request instead of after the first sync.
        await ctx.opencode.loadCatalog();
        alias = ctx.opencode.resolveModelAlias(requestedModel);
      }
      const match = alias === null ? null : findOpenCodeModel(db, alias);
      if (!match) return modelNotFound(requestedModel);
      row = match.model;
      providerRow = match.provider;
    }
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

  // An OpenCode free provider has no key pool: it reproduces the CLI's request
  // shape instead, and the rest of this function stays the openai path.
  if (provider.kind === "opencode")
    return handleOpenCodeRequest(req, {
      db,
      opencode: ctx.opencode,
      requestId,
      clientKey,
      provider,
      model,
      pathname,
      method: req.method,
      kind,
      startedAt,
      limitHeaders,
      estimatedPromptTokens,
      payload,
    });

  const pool = selectCandidates(db, provider.id, startedAt, busyKeys);
  if (!pool.hasEnabledKeys) {
    return jsonError(
      503,
      `No API keys are configured for provider "${provider.name}".`,
      "api_error",
      "provider_unavailable",
    );
  }
  if (pool.candidates.length === 0) {
    // Every key is cooling down. That is brokey's own capacity, so it is said
    // plainly and in brokey's words: the provider's rate-limit or quota text is
    // never passed on to a client.
    const waitSeconds = pool.earliestCooldown
      ? Math.max(1, Math.ceil((pool.earliestCooldown - startedAt) / 1000))
      : 60;
    const count = pool.coolingCount;
    return jsonError(
      503,
      `No usable API keys left for provider "${provider.name}": ${count === 1 ? "its only key is" : `all ${count} keys are`} cooling down after upstream failures. Retry in ${waitSeconds}s.`,
      "api_error",
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
  const extraHeaders = parseStoredExtraHeaders(provider.extraHeaders);

  let upstreamLatencyMs: number | null = null;
  // What each rejected key said, in aggregate: the client's final error names
  // the reasons, never any single provider body.
  const attemptedReasons = new Set<string>();
  let attemptedKeys = 0;
  let exhaustedUntil: number | null = null;

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
              errorMessage: "Client closed request.",
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
        recordKeyFailure(
          db,
          key.id,
          networkFailure(),
          `Upstream request failed: ${message}`,
        );
        attemptedKeys += 1;
        attemptedReasons.add("network_error");
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
          recordKeyFailure(
            db,
            key.id,
            networkFailure(),
            redactSecret(`Upstream request failed: ${message}`, key.secret),
          );
          attemptedKeys += 1;
          attemptedReasons.add("network_error");
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
          const until = recordKeyFailure(
            db,
            key.id,
            failure,
            `HTTP ${response.status}: ${text.slice(0, 400)}`,
          );
          attemptedKeys += 1;
          attemptedReasons.add(failure.errorCode);
          exhaustedUntil =
            exhaustedUntil === null ? until : Math.min(exhaustedUntil, until);
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
            errorMessage: text.trim(),
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
            errorMessage: aborted
              ? "Client closed request."
              : `Upstream response failed: ${message}`,
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
            errorMessage: `Upstream response exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes.`,
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
    attemptedKeys,
    reasons: attemptedReasons,
    exhaustedUntil,
    slot,
  });
}

/** Error bodies only need the head; completions can be large but not infinite. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 32 * 1024 * 1024;

type StreamOptions = {
  injectedUsage: boolean;
  clientWantedUsage: boolean;
  streaming: boolean;
  clientSignal: AbortSignal;
  onLogged: () => void;
};

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

  const record = (
    status: number,
    errorCode: string | null,
    errorMessage?: string | null,
  ) => {
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
        errorMessage,
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
          const message =
            error instanceof Error ? error.message : String(error);
          record(502, "stream_error", `Upstream stream failed: ${message}`);
          // The key delivered headers but broke the body, so it deserves the
          // same cooldown as a failed connection.
          if (ctx.providerKeyId !== null)
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
  attemptedKeys: number;
  reasons: ReadonlySet<string>;
  /** Earliest moment a rejected key may serve again. */
  exhaustedUntil: number | null;
  slot: RequestSlot;
};

/**
 * Every candidate key was rejected. The client gets brokey's own verdict — how
 * many keys existed, that none of them served, and the distinct reasons — never
 * the provider's quota or rate-limit body. That body stays on each key's row,
 * where the provider page shows it to the admin.
 */
function allKeysFailed(db: AppDb, summary: FailedAttemptSummary): Response {
  const waitSeconds =
    summary.exhaustedUntil === null
      ? 60
      : Math.max(1, Math.ceil((summary.exhaustedUntil - Date.now()) / 1000));
  const reasons = [...summary.reasons].map(failureReasonLabel).join(", ");
  const count = summary.attemptedKeys;
  const subject = count === 1 ? "its only key was" : `all ${count} keys were`;
  const message =
    `No usable API keys left for provider "${summary.provider.name}": ` +
    `${count === 0 ? "every key is unavailable" : `${subject} rejected`}` +
    `${reasons === "" ? "" : ` (${reasons})`}. Retry in ${waitSeconds}s.`;

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
      status: 503,
      errorCode: "all_keys_exhausted",
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
  db.update(clientKeys)
    .set({
      lastErrorStatus: 503,
      lastErrorMessage: message.slice(0, 500),
      lastErrorAt: Date.now(),
    })
    .where(eq(clientKeys.id, summary.clientKey.id))
    .run();

  return jsonError(503, message, "api_error", "all_keys_exhausted", {
    "retry-after": String(waitSeconds),
    ...summary.limitHeaders,
    "x-brokey-request-id": summary.requestId,
  });
}
