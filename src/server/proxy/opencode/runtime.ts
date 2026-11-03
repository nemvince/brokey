import { createHash, randomBytes } from "node:crypto";
import type { OpenCodeConfig } from "../../config.ts";
import type { AppDb } from "../../db.ts";
import type { ModelRow } from "../../schema.ts";
import type {
  EgressPoolDTO,
  EgressPoolUpdate,
  EgressTestResult,
  OpenCodeGateDTO,
  OpenCodeIdentityDTO,
} from "../../../shared/types.ts";
import type { UpstreamModel } from "../models-sync.ts";
import { effectiveMaxTokens } from "./budget.ts";
import {
  type Catalog,
  catalogBase,
  catalogFacts,
  catalogFreeModels,
  catalogModelBase,
  catalogVerdict,
  createCatalogStore,
  resolveFamilyAlias,
} from "./catalog.ts";
import {
  createEgressState,
  egressPool,
  fetchThroughEgress,
  forgetEgress,
  markEgressFailure,
  markEgressSuccess,
  pickEgress,
  saveEgressPool,
  testEgress,
  type EgressSelection,
  type EgressState,
} from "./egress.ts";
import {
  type IdentityState,
  buildGateHeaders,
  createIdentityState,
  createSessionId,
  adoptVersionFloor,
  parseVersionFloor,
  refreshRelease,
  renderUserAgent,
  STATIC_CHAT_BASE,
} from "./identity.ts";
import {
  buildChatBody,
  buildHeaders,
  createShapeContext,
  type ShapeContext,
} from "./shape.ts";
import { mergeTools } from "./tools.ts";

/**
 * Everything an `opencode` provider needs, owned per app rather than per
 * module: tests create several apps in one process with different pins, and a
 * module singleton would leak one app's identity into another's.
 */

const GATE_RETRY_COOLDOWN_MS = 30_000;
const SESSION_CACHE_MAX = 500;
const SESSION_TTL_MS = 10_800_000;
const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-id",
  "session-id",
  "x-conversation-id",
  "x-9r-session-id",
];

export type GateRejection = {
  at: number;
  kind: "free-tier-gate" | "ip-abuse";
  status: number;
  logId: string | null;
  shapeOk: boolean;
  missing: string[];
  model: string;
};

export type RefreshResult = {
  updated: boolean;
  version: string;
  reason: string;
  error: string | null;
};

export type BuiltBody = {
  body: Record<string, unknown>;
  aliasToOriginal: Map<string, string>;
  originalToAlias: Map<string, string>;
  appendedTools: string[];
};

type GateState = {
  lastRejection: GateRejection | null;
  lastAbuseAt: number;
  throttledUntil: number;
};

export type OpenCodeRuntime = {
  ensureFresh(): void;
  refresh(force?: boolean): Promise<RefreshResult>;
  identity(): OpenCodeIdentityDTO;
  gate(providerId: number): OpenCodeGateDTO;
  noteGateRejection(providerId: number, rejection: GateRejection): void;
  noteIpAbuse(providerId: number, rejection: GateRejection): void;
  shouldSkipGateRetry(): boolean;
  startGateCooldown(): void;
  clearGateCooldown(): void;
  forgetProvider(providerId: number): void;

  chatUrl(modelUpstreamId: string, fallbackBaseUrl: string): string;
  verdict(modelUpstreamId: string): "free" | "paid" | "deprecated" | null;
  facts(modelUpstreamId: string): {
    reasoning: boolean;
    maxOutput: number | null;
  };
  freeModels(force?: boolean): Promise<UpstreamModel[]>;
  /** Ensure the catalog is loaded (optionally forcing a refresh). */
  loadCatalog(force?: boolean): Promise<void>;
  resolveModelAlias(name: string): string | null;
  versionFloorOf(message: string): string | null;
  adoptFloor(floor: string): boolean;

  sessionId(
    req: Request,
    payload: Record<string, unknown>,
    clientKeyId: number,
  ): string;
  regenerateSession(
    req: Request,
    payload: Record<string, unknown>,
    stale: string,
    clientKeyId: number,
  ): string;
  buildBody(payload: Record<string, unknown>, model: ModelRow): BuiltBody;
  buildHeaders(
    req: Request,
    sessionId: string,
    extra: Record<string, string> | null,
  ): Headers;

  egress(
    db: AppDb,
    providerId: number,
    options?: { exclude?: string | null; now?: number },
  ): EgressSelection;
  egressPool(db: AppDb, providerId: number, now?: number): EgressPoolDTO;
  saveEgressPool(
    db: AppDb,
    providerId: number,
    update: EgressPoolUpdate,
  ): EgressPoolDTO;
  testEgress(db: AppDb, providerId: number): Promise<EgressTestResult[]>;
  markEgressFailure(
    db: AppDb,
    providerId: number,
    key: string,
    reason: string,
    cooldownMs?: number | null,
  ): void;
  markEgressSuccess(db: AppDb, providerId: number, key: string): void;
  fetchThroughEgress(
    url: string,
    init: RequestInit,
    providerId: number,
    selection: EgressSelection,
  ): Promise<Response>;
};

/** A bounded sample of a message's content: never stringify the whole body. */
function contentSample(content: unknown, limit = 1000): string {
  if (typeof content === "string") {
    if (content.length <= limit) return `${content.length}:${content}`;
    const half = Math.floor(limit / 2);
    return `${content.length}:${content.slice(0, half)}..${content.slice(-half)}`;
  }
  if (Array.isArray(content)) {
    const text = (parts: unknown[]) =>
      parts
        .map((part) =>
          typeof part === "string"
            ? part
            : part && typeof part === "object"
              ? String((part as Record<string, unknown>).text ?? "")
              : "",
        )
        .join("");
    const head = text(content.slice(0, 1)).slice(0, Math.floor(limit / 2));
    const tail = text(content.slice(-1)).slice(-Math.floor(limit / 2));
    return `${content.length}:${head}..${tail}`;
  }
  return "";
}

export function createOpenCodeRuntime(config: OpenCodeConfig): OpenCodeRuntime {
  const identityState: IdentityState = createIdentityState(config);
  const catalogStore = createCatalogStore(config);
  const shape: ShapeContext = createShapeContext();
  const egressState: EgressState = createEgressState();
  const gates = new Map<number, GateState>();
  const sessions = new Map<string, { sessionId: string; lastSeen: number }>();
  let lastFailedGateRetryAt = 0;
  let lastFailedGateRetryEpoch = -1;
  let refreshTask: Promise<RefreshResult> | null = null;

  const catalog = (): Catalog | null => catalogStore.current();

  const gateState = (providerId: number): GateState => {
    const existing = gates.get(providerId);
    if (existing) return existing;
    const created: GateState = {
      lastRejection: null,
      lastAbuseAt: 0,
      throttledUntil: 0,
    };
    gates.set(providerId, created);
    return created;
  };

  /** The inference root every URL hangs off: pinned, catalog, or shipped. */
  const inferenceBase = (): string =>
    (config.chatUrl ?? catalogBase(catalog()) ?? STATIC_CHAT_BASE).replace(
      /\/+$/,
      "",
    );

  const mintSession = (): string => createSessionId(identityState.recipe);

  const lookupKeyFor = (
    req: Request,
    payload: Record<string, unknown>,
    clientKeyId: number,
  ): string | null => {
    for (const name of SESSION_HEADER_NAMES) {
      const value = req.headers.get(name);
      if (value !== null && value !== "")
        return `${clientKeyId}:hdr:${value.slice(0, 256)}`;
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.length === 0) return null;
    const sample = (index: number): unknown => {
      const message = messages[index];
      return message && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : undefined;
    };
    const signature = `${contentSample(sample(0))}::${contentSample(sample(1))}`;
    if (signature === "::") return null;
    return `${clientKeyId}:conv:${createHash("sha256")
      .update(signature)
      .digest("hex")
      .slice(0, 20)}`;
  };

  const evictSessions = (now: number): void => {
    for (const [key, entry] of sessions) {
      if (now - entry.lastSeen >= SESSION_TTL_MS) sessions.delete(key);
    }
    while (sessions.size >= SESSION_CACHE_MAX) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  const sessionFor = (key: string | null, now: number): string => {
    if (key === null) return mintSession();
    const cached = sessions.get(key);
    if (cached) {
      sessions.delete(key);
      if (now - cached.lastSeen < SESSION_TTL_MS) {
        // Re-inserting refreshes the LRU order.
        sessions.set(key, { sessionId: cached.sessionId, lastSeen: now });
        return cached.sessionId;
      }
    }
    const sessionId = mintSession();
    evictSessions(now);
    sessions.set(key, { sessionId, lastSeen: now });
    return sessionId;
  };

  const runRefresh = async (force: boolean): Promise<RefreshResult> => {
    const { outcome, error } = await refreshRelease(
      config,
      identityState,
      force,
    );
    let catalogError: string | null = null;
    try {
      await catalogStore.load(force);
    } catch (failure) {
      catalogError =
        failure instanceof Error ? failure.message : String(failure);
    }
    return {
      updated: outcome === "adopted",
      version: identityState.recipe.version,
      reason: outcome,
      error: error ?? catalogError,
    };
  };

  /** Serialize refreshes: a forced one waits, so the recipe cannot be raced. */
  const startRefresh = (force: boolean): Promise<RefreshResult> => {
    const queued = (refreshTask ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => runRefresh(force));
    refreshTask = queued;
    return queued.finally(() => {
      if (refreshTask === queued) refreshTask = null;
    });
  };

  return {
    ensureFresh() {
      if (refreshTask) return;
      void startRefresh(false).catch(() => undefined);
    },

    refresh(force = false) {
      return startRefresh(force);
    },

    identity(): OpenCodeIdentityDTO {
      return {
        version: identityState.recipe.version,
        channel: identityState.recipe.channel,
        source: identityState.source,
        sha: identityState.sha,
        userAgent: renderUserAgent(identityState.recipe, config.userAgent),
        sessionPrefix: identityState.recipe.sessionPrefix,
        sessionLength: identityState.recipe.sessionLength,
        chatUrl: `${inferenceBase()}/chat/completions`,
        fetchedAt: identityState.fetchedAt,
        catalogFetchedAt: catalogStore.fetchedAt(),
        availableVersion: identityState.availableVersion,
        lastError: identityState.lastError,
        catalogError: catalogStore.lastError(),
        refreshInFlight: refreshTask !== null,
      };
    },

    gate(providerId: number): OpenCodeGateDTO {
      const state = gateState(providerId);
      const now = Date.now();
      const status =
        state.lastAbuseAt > 0
          ? "ip-blocked"
          : state.throttledUntil > now
            ? "throttled"
            : "open";
      return {
        status,
        throttledUntil: status === "throttled" ? state.throttledUntil : null,
        lastRejection: state.lastRejection,
      };
    },

    noteGateRejection(providerId, rejection) {
      const state = gateState(providerId);
      state.lastRejection = rejection;
      state.throttledUntil = rejection.at + GATE_RETRY_COOLDOWN_MS;
      if (rejection.kind === "ip-abuse") state.lastAbuseAt = rejection.at;
    },

    noteIpAbuse(providerId, rejection) {
      const state = gateState(providerId);
      state.lastRejection = rejection;
      state.lastAbuseAt = rejection.at;
    },

    shouldSkipGateRetry() {
      return (
        lastFailedGateRetryAt > 0 &&
        Date.now() - lastFailedGateRetryAt < GATE_RETRY_COOLDOWN_MS &&
        lastFailedGateRetryEpoch === identityState.epoch
      );
    },

    startGateCooldown() {
      lastFailedGateRetryAt = Date.now();
      lastFailedGateRetryEpoch = identityState.epoch;
    },

    clearGateCooldown() {
      lastFailedGateRetryAt = 0;
      lastFailedGateRetryEpoch = -1;
    },

    forgetProvider(providerId) {
      gates.delete(providerId);
      forgetEgress(egressState, providerId);
    },

    chatUrl(modelUpstreamId, fallbackBaseUrl) {
      const base =
        config.chatUrl ??
        catalogModelBase(catalog(), modelUpstreamId) ??
        fallbackBaseUrl ??
        STATIC_CHAT_BASE;
      return `${base.replace(/\/+$/, "")}/chat/completions`;
    },

    verdict: (modelUpstreamId) => catalogVerdict(catalog(), modelUpstreamId),

    facts: (modelUpstreamId) => catalogFacts(catalog(), modelUpstreamId),

    async freeModels(force = false) {
      return catalogFreeModels(await catalogStore.load(force));
    },

    async loadCatalog(force = false) {
      // A failed fetch leaves the previous catalog in place; callers decide
      // whether an unknown model is acceptable.
      await catalogStore.load(force).catch(() => undefined);
    },

    resolveModelAlias: (name) => resolveFamilyAlias(catalog(), name),

    versionFloorOf: (message) => parseVersionFloor(message),

    adoptFloor: (floor) => adoptVersionFloor(identityState, floor),

    sessionId(req, payload, clientKeyId) {
      return sessionFor(lookupKeyFor(req, payload, clientKeyId), Date.now());
    },

    regenerateSession(req, payload, stale, clientKeyId) {
      // An id minted before a refresh encodes the shape the gate just rejected,
      // so replaying it would fail the same way.
      for (const [key, entry] of sessions) {
        if (entry.sessionId === stale) sessions.delete(key);
      }
      return sessionFor(lookupKeyFor(req, payload, clientKeyId), Date.now());
    },

    buildBody(payload, model) {
      const merged = mergeTools(payload.tools);
      const facts = catalogFacts(catalog(), model.upstreamId);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      return {
        body: buildChatBody({
          payload,
          model: model.upstreamId,
          tools: merged.tools,
          placeholderNote: merged.placeholderNote,
          originalToAlias: merged.originalToAlias,
          envBlock: shape.envBlock,
          maxCompletionTokens: effectiveMaxTokens(
            payload,
            facts,
            model.maxOutputTokens,
          ),
          messages,
        }),
        aliasToOriginal: merged.aliasToOriginal,
        originalToAlias: merged.originalToAlias,
        appendedTools: merged.appended,
      };
    },

    buildHeaders(req, sessionId, extra) {
      return buildHeaders(
        req,
        identityState.recipe,
        config,
        shape,
        sessionId,
        extra,
      );
    },

    egress(db, providerId, options = {}) {
      return pickEgress(db, egressState, providerId, options);
    },

    egressPool(db, providerId, now = Date.now()) {
      return egressPool(db, egressState, providerId, now);
    },

    saveEgressPool(db, providerId, update) {
      return saveEgressPool(db, egressState, providerId, update);
    },

    testEgress(db, providerId) {
      const base = inferenceBase();
      const sessionId = mintSession();
      return testEgress(db, egressState, providerId, base, (id) => {
        const gate = buildGateHeaders(identityState.recipe, {
          userAgent: renderUserAgent(identityState.recipe, config.userAgent),
          project: shape.projectId,
          sessionId: id,
        });
        const headers = new Headers({
          authorization: "Bearer public",
          accept: "application/json",
        });
        for (const [name, value] of Object.entries(gate.headers))
          headers.set(name, value);
        return headers;
      });
    },

    markEgressFailure(db, providerId, key, reason, cooldownMs = null) {
      markEgressFailure(db, egressState, providerId, key, reason, cooldownMs);
    },

    markEgressSuccess(db, providerId, key) {
      markEgressSuccess(db, egressState, providerId, key);
    },

    fetchThroughEgress(url, init, providerId, selection) {
      return fetchThroughEgress(url, init, {
        ...selection,
        providerId,
      });
    },
  };
}
