import type { AppDb } from "../../db.ts";
import type { ClientKeyRow, ModelRow, ProviderRow } from "../../schema.ts";
import { parseStoredExtraHeaders } from "../../headers.ts";
import { requestSlot } from "../limits.ts";
import {
  EMPTY_USAGE,
  hasUsageChunkOnly,
  type TokenUsage,
  usageFromAnyJson,
  usageFromChatJson,
} from "../usage.ts";
import {
  logFor,
  type AttemptContext,
  type EndpointKind,
  resolveUsage,
  writeUsageLog,
} from "../log.ts";
import { decorate, forwardHeaders, jsonError } from "../response.ts";
import {
  isAbort,
  isEventStream,
  parseEventJson,
  parseJsonBytes,
  readBodyCapped,
  SseSplitter,
  streamErrorEvent,
} from "../streaming.ts";
import type { OpenCodeRuntime } from "./runtime.ts";
import { auditGateShape } from "./shape.ts";
import type { RequestSlot } from "../limits.ts";

/**
 * The OpenCode free-tier lane.
 *
 * Upstream is always called with `stream: true` and the response is reshaped
 * for both kinds of client. The retry ladder is ordered by cause: a protocol
 * mismatch, a moved endpoint, a spent allowance, a transient failure, and
 * finally the shape gate — which a newer CLI identity can sometimes clear.
 */

const MAX_ERROR_BODY_BYTES = 65_536;
const MAX_UPSTREAM_BODY_BYTES = 33_554_432;
const UPSTREAM_TIMEOUT_MS = 120_000;
const GATE_RETRY_AFTER_SECONDS = 30;
/** A spent free-tier allowance is minutes, not seconds. */
const ALLOWANCE_COOLDOWN_MS = 4 * 1_200_000;

const UNSUPPORTED_PROTOCOL =
  /ModelProtocolUnsupported|does not support this protocol/i;
const MODEL_LEVEL_404 = /model(deprecated|unavailable|protocolunsupported)/i;
const IP_ABUSE = /abusive traffic|abuse traffic|abuse of traffic/i;
const GATE_MESSAGE =
  /freetiererror|free tier|free models|opencode cli|only available in opencode|upgrade required|or newer is required/i;

export type OpenCodeRequest = {
  db: AppDb;
  opencode: OpenCodeRuntime;
  requestId: string;
  clientKey: ClientKeyRow;
  provider: ProviderRow;
  model: ModelRow | null;
  pathname: string;
  method: string;
  kind: EndpointKind;
  startedAt: number;
  limitHeaders: Record<string, string>;
  estimatedPromptTokens: number;
  payload: Record<string, unknown> | null;
};

type Logged = {
  streamed: boolean;
  status: number;
  errorCode: string | null;
  usage: TokenUsage;
  estimated: boolean;
};

type UpstreamFailure = {
  status: number;
  text: string;
  type: string;
  message: string;
};

function upstreamFailure(status: number, text: string): UpstreamFailure {
  const parsed = parseJsonBytes(new TextEncoder().encode(text));
  const error =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).error
      : undefined;
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : typeof error === "string"
        ? { message: error }
        : {};
  return {
    status,
    text,
    type: typeof record.type === "string" ? record.type : "",
    message: typeof record.message === "string" ? record.message : "",
  };
}

function isGateError(failure: UpstreamFailure): boolean {
  const { status, type, message } = failure;
  if (status === 426) return true;
  if (type === "FreeTierError" || type === "UpgradeRequired") return true;
  return (status === 403 || status === 401) && GATE_MESSAGE.test(message);
}

function markGate(
  headers: Headers,
  gate: "ip-abuse" | "ip-throttled" | "shape-rejected",
  logId: string | null,
): void {
  headers.set("x-brokey-gate", gate);
  if (gate !== "ip-abuse")
    headers.set("retry-after", String(GATE_RETRY_AFTER_SECONDS));
  if (logId !== null) headers.set("x-opencode-log-id", logId);
}

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type Collected = {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: TokenUsage | null;
};

function emptyCollected(): Collected {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
}

/** Restore the client's own tool name after brokey renamed it on the way out. */
function restoreToolName(
  name: unknown,
  aliasToOriginal: Map<string, string>,
): string {
  if (typeof name !== "string" || aliasToOriginal.size === 0) return "";
  return aliasToOriginal.get(name) ?? name;
}

function recordDelta(
  collected: Collected,
  chunk: unknown,
  aliasToOriginal: Map<string, string>,
): void {
  if (!chunk || typeof chunk !== "object") return;
  const record = chunk as Record<string, unknown>;
  collected.usage ??= usageFromAnyJson(chunk);
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return;
  const entry = choice as Record<string, unknown>;
  if (typeof entry.finish_reason === "string")
    collected.finishReason = entry.finish_reason;
  const delta = entry.delta;
  if (!delta || typeof delta !== "object") return;
  const fields = delta as Record<string, unknown>;
  if (typeof fields.content === "string") collected.content += fields.content;
  if (typeof fields.reasoning_content === "string")
    collected.reasoning += fields.reasoning_content;
  else if (typeof fields.reasoning === "string")
    collected.reasoning += fields.reasoning;
  const calls = fields.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const piece = call as Record<string, unknown>;
    const index = typeof piece.index === "number" ? piece.index : 0;
    const existing = collected.toolCalls[index] ?? {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (typeof piece.id === "string" && existing.id === "")
      existing.id = piece.id;
    const fn = piece.function;
    if (fn && typeof fn === "object") {
      const callFields = fn as Record<string, unknown>;
      if (typeof callFields.name === "string" && callFields.name !== "")
        existing.function.name = restoreToolName(
          callFields.name,
          aliasToOriginal,
        );
      if (typeof callFields.arguments === "string")
        existing.function.arguments += callFields.arguments;
    }
    collected.toolCalls[index] = existing;
  }
}

function streamError(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const error = (chunk as Record<string, unknown>).error;
  if (!error) return null;
  if (typeof error === "string") return error;
  const record = error as Record<string, unknown>;
  const message = record.message ?? record.type;
  return typeof message === "string" ? message : JSON.stringify(error);
}

/**
 * Rewrite one upstream chunk for the client: `reasoning` becomes
 * `reasoning_content`, and aliased tool names become the client's own. Returns
 * null when the chunk needs no change, so the frame can be forwarded verbatim.
 */
function rewriteChunk(
  chunk: unknown,
  aliasToOriginal: Map<string, string>,
): Record<string, unknown> | null {
  const record = chunk as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  let changed = false;
  const nextChoices = choices.map((choice) => {
    if (!choice || typeof choice !== "object") return choice;
    const entry = choice as Record<string, unknown>;
    const delta = entry.delta;
    if (!delta || typeof delta !== "object") return choice;
    const fields = delta as Record<string, unknown>;
    const next: Record<string, unknown> = { ...fields };
    let touched = false;
    if (
      typeof next.reasoning === "string" &&
      next.reasoning_content === undefined
    ) {
      next.reasoning_content = next.reasoning;
      delete next.reasoning;
      touched = true;
    }
    if (Array.isArray(fields.tool_calls)) {
      let renamed = false;
      const calls = fields.tool_calls.map((call) => {
        if (!call || typeof call !== "object") return call;
        const piece = call as Record<string, unknown>;
        const fn = piece.function;
        if (!fn || typeof fn !== "object") return call;
        const name = (fn as Record<string, unknown>).name;
        if (typeof name !== "string" || aliasToOriginal.size === 0) return call;
        const restored = aliasToOriginal.get(name);
        if (restored === undefined) return call;
        renamed = true;
        return { ...piece, function: { ...fn, name: restored } };
      });
      if (renamed) {
        next.tool_calls = calls;
        touched = true;
      }
    }
    if (!touched) return choice;
    changed = true;
    return { ...entry, delta: next };
  });
  return changed ? { ...record, choices: nextChoices } : null;
}

export async function handleOpenCodeRequest(
  req: Request,
  request: OpenCodeRequest,
): Promise<Response> {
  const { db, opencode, provider, clientKey, requestId, limitHeaders } =
    request;
  const pathname = request.pathname.replace(/\/+$/, "");
  if (pathname !== "/v1/chat/completions" || req.method !== "POST") {
    return jsonError(
      400,
      "OpenCode free providers only support POST /v1/chat/completions.",
      "invalid_request_error",
      "unsupported_endpoint",
    );
  }
  const payload = request.payload;
  if (!payload || !Array.isArray(payload.messages)) {
    return jsonError(
      400,
      "We could not understand the request: a `messages` array is required.",
      "invalid_request_error",
      "messages_required",
    );
  }
  const model = request.model;
  if (!model) {
    return jsonError(
      400,
      "Select a model: an OpenCode free provider cannot infer one.",
      "invalid_request_error",
      "model_required",
    );
  }

  opencode.ensureFresh();
  // Catalog verdicts never block on a fetch: an unknown model is allowed.
  const verdict = opencode.verdict(model.upstreamId);
  if (verdict === "deprecated")
    return jsonError(
      404,
      `Model '${model.publicId}' has been retired upstream. Free models are listed at /v1/models.`,
      "invalid_request_error",
      "model_deprecated",
    );
  if (verdict === "paid")
    return jsonError(
      404,
      `Model '${model.publicId}' is not on the OpenCode free tier. Free models are listed at /v1/models.`,
      "invalid_request_error",
      "model_not_free",
    );

  const slot: RequestSlot = requestSlot(clientKey.id);
  const streaming = payload.stream === true;
  const options = payload.stream_options;
  const clientWantedUsage =
    options !== null &&
    typeof options === "object" &&
    (options as Record<string, unknown>).include_usage === true;

  const attempt: AttemptContext = {
    db,
    requestId,
    clientKey,
    provider,
    providerKeyId: null,
    model,
    pathname: request.pathname,
    method: request.method,
    kind: request.kind,
    startedAt: request.startedAt,
    upstreamLatencyMs: null,
    limitHeaders,
    estimatedPromptTokens: request.estimatedPromptTokens,
  };
  // The reservation is released when this request's usage row is written.
  const log = (values: Logged) =>
    writeUsageLog(db, logFor(attempt, values), slot);

  const built = opencode.buildBody(payload, model);
  const upstreamBody = JSON.stringify(built.body);
  const extraHeaders = parseStoredExtraHeaders(provider.extraHeaders);
  let sessionId = opencode.sessionId(req, payload, clientKey.id);
  let chatUrl = opencode.chatUrl(model.upstreamId, provider.baseUrl);
  let egress = opencode.egress(db, provider.id);

  let transportRetried = false;
  let endpointRetried = false;
  let allowanceRetried = false;
  let transientRetried = false;
  let gateRetried = false;

  for (;;) {
    const headers = opencode.buildHeaders(req, sessionId, extraHeaders);
    let response: Response;
    const attemptStarted = Date.now();
    try {
      response = await opencode.fetchThroughEgress(
        chatUrl,
        {
          method: "POST",
          headers,
          body: upstreamBody,
          signal: AbortSignal.any([
            AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            req.signal,
          ]),
        },
        provider.id,
        egress,
      );
    } catch (error) {
      if (req.signal.aborted) {
        log({
          streamed: streaming,
          status: 499,
          errorCode: "client_aborted",
          usage: {
            ...EMPTY_USAGE,
            promptTokens: request.estimatedPromptTokens,
            totalTokens: request.estimatedPromptTokens,
          },
          estimated: true,
        });
        return jsonError(
          499,
          "Client closed request.",
          "api_error",
          "client_aborted",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      opencode.markEgressFailure(
        db,
        provider.id,
        egress.key,
        `transport: ${message}`,
      );
      if (!transportRetried) {
        transportRetried = true;
        const next = opencode.egress(db, provider.id, { exclude: egress.key });
        if (next.key !== egress.key) {
          egress = next;
          continue;
        }
      }
      log({
        streamed: streaming,
        status: 502,
        errorCode: "upstream_unavailable",
        usage: EMPTY_USAGE,
        estimated: false,
      });
      return jsonError(
        502,
        `No configured egress for provider "${provider.name}" could reach upstream.`,
        "api_error",
        "all_egress_unreachable",
      );
    }
    attempt.upstreamLatencyMs ??= Date.now() - attemptStarted;

    if (response.ok) {
      opencode.markEgressSuccess(db, provider.id, egress.key);
      opencode.clearGateCooldown();
      const shape = {
        attempt,
        aliasToOriginal: built.aliasToOriginal,
        log,
        onBrokenStream: () =>
          opencode.markEgressFailure(
            db,
            provider.id,
            egress.key,
            "upstream stream failed",
          ),
      };
      return streaming
        ? shapeStream(response, {
            ...shape,
            clientWantedUsage,
            clientSignal: req.signal,
          })
        : await shapeCompletion(response, {
            ...shape,
            publicId: model.publicId,
          });
    }

    const body = await readBodyCapped(response, MAX_ERROR_BODY_BYTES);
    const failure = upstreamFailure(
      response.status,
      new TextDecoder().decode(body.bytes),
    );
    const headersOut = () =>
      decorate(forwardHeaders(response.headers), requestId, limitHeaders);

    // 1. The model speaks a protocol this proxy does not implement.
    if (
      failure.status === 400 &&
      UNSUPPORTED_PROTOCOL.test(`${failure.type} ${failure.message}`)
    ) {
      opencode.markEgressSuccess(db, provider.id, egress.key);
      log({
        streamed: streaming,
        status: 400,
        errorCode: "model_protocol_unsupported",
        usage: EMPTY_USAGE,
        estimated: false,
      });
      return jsonError(
        400,
        `Model '${model.publicId}' requires the Responses API lane, which brokey does not support for OpenCode providers.`,
        "invalid_request_error",
        "model_protocol_unsupported",
      );
    }

    // 2. The endpoint moved: only the release knows where it went.
    if (
      (failure.status === 404 || failure.status === 410) &&
      !MODEL_LEVEL_404.test(failure.type)
    ) {
      await opencode.refresh(true).catch(() => undefined);
      const moved = opencode.chatUrl(model.upstreamId, provider.baseUrl);
      if (!endpointRetried && moved !== chatUrl) {
        endpointRetried = true;
        chatUrl = moved;
        continue;
      }
    }

    // 3. This egress's allowance is spent: rotate.
    if (failure.status === 429) {
      opencode.markEgressFailure(
        db,
        provider.id,
        egress.key,
        `upstream 429: ${failure.message.slice(0, 120)}`,
        ALLOWANCE_COOLDOWN_MS,
      );
      opencode.clearGateCooldown();
      const next = opencode.egress(db, provider.id, { exclude: egress.key });
      if (!allowanceRetried && next.key !== egress.key) {
        allowanceRetried = true;
        egress = next;
        continue;
      }
    }

    // 4. A transient upstream failure: the session may be the stale part.
    if (failure.status >= 500 && !transientRetried) {
      transientRetried = true;
      sessionId = opencode.regenerateSession(
        req,
        payload,
        sessionId,
        clientKey.id,
      );
      continue;
    }

    // 5. The free-tier gate: this egress is flagged, or the shape needs the
    // current release.
    if (isGateError(failure)) {
      const logId = response.headers.get("x-opencode-log-id");
      const at = Date.now();
      const audit = auditGateShape(built.body, headers);
      if (failure.status === 403 && IP_ABUSE.test(failure.message)) {
        opencode.markEgressFailure(
          db,
          provider.id,
          egress.key,
          `ip abuse: ${failure.message.slice(0, 120)}`,
        );
        opencode.noteIpAbuse(provider.id, {
          at,
          kind: "ip-abuse",
          status: failure.status,
          logId,
          shapeOk: audit.shapeOk,
          missing: audit.missing,
          model: model.publicId,
        });
        log({
          streamed: streaming,
          status: failure.status,
          errorCode: "gate_ip_abuse",
          usage: EMPTY_USAGE,
          estimated: false,
        });
        const responseHeaders = headersOut();
        markGate(responseHeaders, "ip-abuse", logId);
        return new Response(failure.text, {
          status: failure.status,
          headers: responseHeaders,
        });
      }

      if (!gateRetried && !opencode.shouldSkipGateRetry()) {
        gateRetried = true;
        const floor = opencode.versionFloorOf(failure.message);
        if (floor !== null) opencode.adoptFloor(floor);
        await opencode.refresh(true).catch(() => undefined);
        sessionId = opencode.regenerateSession(
          req,
          payload,
          sessionId,
          clientKey.id,
        );
        opencode.markEgressFailure(
          db,
          provider.id,
          egress.key,
          `gate ${failure.status}: ${failure.message.slice(0, 120)}`,
        );
        const next = opencode.egress(db, provider.id, { exclude: egress.key });
        if (next.key !== egress.key) egress = next;
        chatUrl = opencode.chatUrl(model.upstreamId, provider.baseUrl);
        continue;
      }

      opencode.noteGateRejection(provider.id, {
        at,
        kind: "free-tier-gate",
        status: failure.status,
        logId,
        shapeOk: audit.shapeOk,
        missing: audit.missing,
        model: model.publicId,
      });
      if (failure.status !== 429) opencode.startGateCooldown();
      opencode.markEgressFailure(
        db,
        provider.id,
        egress.key,
        `gate ${failure.status}: ${failure.message.slice(0, 120)}`,
        failure.status === 429 ? ALLOWANCE_COOLDOWN_MS : null,
      );
      log({
        streamed: streaming,
        status: failure.status,
        errorCode: "gate_free_tier",
        usage: EMPTY_USAGE,
        estimated: false,
      });
      const responseHeaders = headersOut();
      markGate(
        responseHeaders,
        audit.shapeOk ? "ip-throttled" : "shape-rejected",
        logId,
      );
      return new Response(failure.text, {
        status: failure.status,
        headers: responseHeaders,
      });
    }

    // 6. Anything else is the client's request, not this egress's problem.
    opencode.markEgressSuccess(db, provider.id, egress.key);
    log({
      streamed: streaming,
      status: failure.status,
      errorCode: `http_${failure.status}`,
      usage: EMPTY_USAGE,
      estimated: false,
    });
    return new Response(failure.text, {
      status: failure.status,
      statusText: response.statusText,
      headers: headersOut(),
    });
  }
}

type ShapeBase = {
  attempt: AttemptContext;
  aliasToOriginal: Map<string, string>;
  log: (values: Logged) => void;
  /** Called when upstream delivered headers but broke the body. */
  onBrokenStream: () => void;
};

function streamResponseHeaders(attempt: AttemptContext): Headers {
  const headers = decorate(
    new Headers(),
    attempt.requestId,
    attempt.limitHeaders,
  );
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function shapeStream(
  response: Response,
  shape: ShapeBase & {
    clientWantedUsage: boolean;
    clientSignal: AbortSignal;
  },
): Response {
  const reader = response.body!.getReader();
  const splitter = new SseSplitter();
  const encoder = new TextEncoder();
  const collected = emptyCollected();
  let logged = false;
  let cancelled = false;

  const record = (status: number, errorCode: string | null) => {
    if (logged) return;
    logged = true;
    const resolved = resolveUsage(
      "chat",
      collected.usage,
      shape.attempt.estimatedPromptTokens,
      collected.content,
    );
    shape.log({
      streamed: true,
      status,
      errorCode,
      usage: resolved.usage,
      estimated: resolved.estimated,
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let done = false;
      const emit = (frame: { raw: string; separator: string }) => {
        controller.enqueue(encoder.encode(frame.raw + frame.separator));
      };
      const handle = (frame: { raw: string; separator: string }): boolean => {
        const chunk = parseEventJson(frame.raw);
        if (chunk === null) {
          // A non-data frame, or the terminal `[DONE]`.
          emit(frame);
          return frame.raw.includes("[DONE]");
        }
        const failure = streamError(chunk);
        if (failure !== null) {
          controller.enqueue(encoder.encode(streamErrorEvent(failure)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          record(502, "stream_error");
          return true;
        }
        recordDelta(collected, chunk, shape.aliasToOriginal);
        if (!shape.clientWantedUsage && hasUsageChunkOnly(chunk)) return false;
        const rewritten = rewriteChunk(chunk, shape.aliasToOriginal);
        if (rewritten === null) {
          emit(frame);
          return false;
        }
        const separator = frame.separator === "" ? "\n\n" : frame.separator;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(rewritten)}${separator}`),
        );
        return false;
      };

      try {
        while (!done) {
          const { done: ended, value } = await reader.read();
          if (ended) break;
          for (const frame of splitter.push(value)) {
            done = handle(frame);
            if (done) break;
          }
        }
        if (!done) {
          for (const frame of splitter.flush()) {
            done = handle(frame);
            if (done) break;
          }
        }
        if (!done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          record(response.status, null);
        } else {
          record(response.status, null);
        }
        controller.close();
      } catch (error) {
        // A client that stops reading has not failed anything: agents hang up
        // the moment they have the tool call. Only a broken body with a live
        // client is an upstream failure.
        const abandoned =
          cancelled || shape.clientSignal.aborted || isAbort(error);
        record(
          abandoned ? response.status : 502,
          abandoned ? null : "stream_error",
        );
        if (!abandoned) {
          const message =
            error instanceof Error ? error.message : String(error);
          try {
            // Ending with a reset makes clients report ECONNRESET; an in-band
            // error event tells them what actually failed.
            controller.enqueue(encoder.encode(streamErrorEvent(message)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          } catch {
            // the consumer is already gone
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
      cancelled = true;
      reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: streamResponseHeaders(shape.attempt),
  });
}

function normalizeJsonCompletion(
  collected: Collected,
  parsed: unknown,
  aliasToOriginal: Map<string, string>,
): void {
  const choices =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).choices
      : null;
  const first = Array.isArray(choices) ? choices[0] : null;
  const choice =
    first && typeof first === "object"
      ? (first as Record<string, unknown>)
      : {};
  if (typeof choice.finish_reason === "string")
    collected.finishReason = choice.finish_reason;
  const message = choice.message;
  if (message && typeof message === "object") {
    const fields = message as Record<string, unknown>;
    if (typeof fields.content === "string") collected.content += fields.content;
    if (typeof fields.reasoning_content === "string")
      collected.reasoning += fields.reasoning_content;
    const calls = fields.tool_calls;
    if (Array.isArray(calls)) {
      for (const [index, call] of calls.entries()) {
        if (!call || typeof call !== "object") continue;
        const piece = call as Record<string, unknown>;
        const fn = piece.function;
        const callFields =
          fn && typeof fn === "object" ? (fn as Record<string, unknown>) : {};
        collected.toolCalls[index] = {
          id: typeof piece.id === "string" ? piece.id : "",
          type: "function",
          function: {
            name: restoreToolName(callFields.name, aliasToOriginal),
            arguments:
              typeof callFields.arguments === "string"
                ? callFields.arguments
                : "",
          },
        };
      }
    }
  }
  collected.usage = usageFromChatJson(parsed);
}

async function shapeCompletion(
  response: Response,
  shape: ShapeBase & { publicId: string },
): Promise<Response> {
  const collected = emptyCollected();
  let error: string | null = null;
  let oversized = false;

  if (isEventStream(response.headers.get("content-type"))) {
    const reader = response.body!.getReader();
    const splitter = new SseSplitter();
    let total = 0;
    const consume = (frame: { raw: string; separator: string }) => {
      const chunk = parseEventJson(frame.raw);
      if (chunk === null) return;
      const failure = streamError(chunk);
      if (failure !== null && error === null) error = failure;
      recordDelta(collected, chunk, shape.aliasToOriginal);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_UPSTREAM_BODY_BYTES) {
          oversized = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        for (const frame of splitter.push(value)) consume(frame);
      }
      if (!oversized && error === null)
        for (const frame of splitter.flush()) consume(frame);
    } finally {
      reader.releaseLock();
    }
  } else {
    const body = await readBodyCapped(response, MAX_UPSTREAM_BODY_BYTES);
    if (body.truncated) oversized = true;
    else
      normalizeJsonCompletion(
        collected,
        parseJsonBytes(body.bytes),
        shape.aliasToOriginal,
      );
  }

  const resolved = resolveUsage(
    "chat",
    collected.usage,
    shape.attempt.estimatedPromptTokens,
    collected.content,
  );
  const logOnce = (status: number, errorCode: string | null) =>
    shape.log({
      streamed: false,
      status,
      errorCode,
      usage: resolved.usage,
      estimated: resolved.estimated,
    });

  if (oversized) {
    logOnce(502, "response_too_large");
    return jsonError(
      502,
      `Upstream response exceeded ${MAX_UPSTREAM_BODY_BYTES} bytes.`,
      "api_error",
      "response_too_large",
    );
  }
  if (error !== null) {
    logOnce(502, "stream_error");
    return jsonError(502, error, "api_error", "stream_error");
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: collected.content === "" ? null : collected.content,
  };
  if (collected.reasoning !== "")
    message.reasoning_content = collected.reasoning;
  if (collected.toolCalls.length > 0) message.tool_calls = collected.toolCalls;
  const finishReason =
    collected.toolCalls.length > 0 &&
    collected.finishReason !== "length" &&
    collected.finishReason !== "content_filter"
      ? "tool_calls"
      : (collected.finishReason ?? "stop");

  logOnce(200, null);
  return Response.json(
    {
      id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: shape.publicId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: resolved.usage.promptTokens,
        completion_tokens: resolved.usage.completionTokens,
        total_tokens: resolved.usage.totalTokens,
      },
    },
    {
      headers: decorate(
        new Headers(),
        shape.attempt.requestId,
        shape.attempt.limitHeaders,
      ),
    },
  );
}
