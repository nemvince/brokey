/**
 * The OpenCode CLI identity the free-tier gate fingerprints, and the sync that
 * keeps it current.
 *
 * Derived from `azrinaldi/opencode-free-bridge` (`identity.js`):
 * https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/identity.js
 * Copyright (c) 2026 azrinaldi — MIT. See THIRD_PARTY_NOTICES.md.
 *
 * Upstream mints its allowance per egress IP and refuses a request whose shape
 * does not look like its own CLI: an `opencode/<channel>/<version>/cli`
 * User-Agent, a session header, and a reasoning-token floor. The shape moves
 * with CLI releases, so the version is read from the same update endpoint the
 * CLI polls and the session-id recipe from that release's source.
 */

import { randomBytes } from "node:crypto";
import type { OpenCodeConfig } from "../../config.ts";

const IDENTITY_TTL_MS = 900_000;
const HANDSHAKE_TIMEOUT_MS = 6_000;
const SOURCE_TIMEOUT_MS = 8_000;
const MAX_COUNTER_PER_MS = 16;

export type IdentitySource = "static" | "update-api" | "atom-feed";

export type Recipe = {
  version: string;
  channel: string;
  client: string;
  sessionPrefix: string;
  sessionCharset: string;
  sessionLength: number;
  sessionMultiplier: bigint;
  userAgentTemplate: string;
  /** Header names upstream's own request builder sets, in its order. */
  headers: string[];
};

export type IdentityState = {
  recipe: Recipe;
  sha: string | null;
  source: IdentitySource;
  lastCheck: number;
  fetchedAt: number | null;
  availableVersion: string | null;
  lastError: string | null;
  versionFloor: string | null;
  /** The release ref whose source files produced the current recipe. */
  appliedRef: string | null;
  /** Bumped whenever the wire shape changes; gate cooldowns are epoch-scoped. */
  epoch: number;
};

export type RefreshOutcome =
  | "pinned"
  | "fresh"
  | "up-to-date"
  | "available-not-adopted"
  | "newer-local"
  | "adopted"
  | "failed";

/** The endpoint the catalog and the CLI agree on, until a release says otherwise. */
export const STATIC_CHAT_BASE = "https://opencode.ai/inference/openai/v1";

const SOURCE_FILES = {
  identifier: "packages/schema/src/identifier.ts",
  sessionId: "packages/schema/src/session-id.ts",
  app: "packages/core/src/app.ts",
  modelRequest: "packages/core/src/session/model-request.ts",
};

export function staticRecipe(config: OpenCodeConfig): Recipe {
  return {
    version: "2.2.5",
    channel: config.channel,
    client: "cli",
    sessionPrefix: "ses_",
    sessionCharset:
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    sessionLength: 26,
    sessionMultiplier: 0x1000n,
    userAgentTemplate: "opencode/${channel}/${version}/cli",
    headers: [
      "x-opencode-session-id",
      "x-session-affinity",
      "X-Session-Id",
      "User-Agent",
      "x-opencode-project",
      "x-opencode-session",
      "x-opencode-client",
    ],
  };
}

export function createIdentityState(config: OpenCodeConfig): IdentityState {
  return {
    recipe: staticRecipe(config),
    sha: null,
    source: "static",
    lastCheck: 0,
    fetchedAt: null,
    availableVersion: null,
    lastError: null,
    versionFloor: null,
    appliedRef: null,
    epoch: 0,
  };
}

export function renderUserAgent(recipe: Recipe, pinned: string | null): string {
  if (pinned !== null) return pinned;
  return recipe.userAgentTemplate
    .replaceAll("${channel}", recipe.channel)
    .replaceAll("${version}", recipe.version)
    .replaceAll("${client}", recipe.client)
    .replaceAll("${app.channel}", recipe.channel)
    .replaceAll("${app.version}", recipe.version)
    .replaceAll("${app.name}", recipe.client)
    .replaceAll("${app.client}", recipe.client);
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** `"OpenCode 2.3.0 or newer is required"` → `"2.3.0"`. */
export function parseVersionFloor(message: string): string | null {
  return /(\d+\.\d+\.\d+)\s+or newer/i.exec(message)?.[1] ?? null;
}

type Release = {
  version: string;
  sha: string | null;
  minimum: boolean;
  source: IdentitySource;
};

async function releaseFromUpdateApi(
  config: OpenCodeConfig,
  currentVersion: string,
): Promise<Release> {
  const url = `${config.updateApiBase}/${encodeURIComponent(config.channel)}/cli/npm?current=${encodeURIComponent(currentVersion)}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`update API returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const version = payload.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("update API returned no usable version");
  if (payload.active === false) throw new Error("release is not active");
  const github = payload.metadata;
  const sha =
    github && typeof github === "object"
      ? (github as Record<string, unknown>).sha
      : null;
  const metadata =
    github && typeof github === "object"
      ? (github as Record<string, unknown>).github
      : null;
  const commit =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).sha
      : null;
  return {
    version,
    sha:
      typeof (commit ?? sha) === "string" &&
      /^[0-9a-f]{7,40}$/i.test(String(commit ?? sha))
        ? String(commit ?? sha)
        : null,
    minimum: payload.minimum === true,
    source: "update-api",
  };
}

async function releaseFromAtomFeed(config: OpenCodeConfig): Promise<Release> {
  const response = await fetch(config.atomUrl, {
    signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`release feed returned HTTP ${response.status}`);
  }
  const text = await response.text();
  const versions = [...text.matchAll(/\/v(\d+\.\d+\.\d+)\//g)].map(
    (match) => match[1] as string,
  );
  if (versions.length === 0) throw new Error("release feed listed no versions");
  const version = versions.reduce((best, candidate) =>
    compareVersions(candidate, best) > 0 ? candidate : best,
  );
  return { version, sha: null, minimum: false, source: "atom-feed" };
}

async function resolveRelease(
  config: OpenCodeConfig,
  currentVersion: string,
): Promise<{ release: Release | null; error: string | null }> {
  try {
    return {
      release: await releaseFromUpdateApi(config, currentVersion),
      error: null,
    };
  } catch (first) {
    try {
      return { release: await releaseFromAtomFeed(config), error: null };
    } catch (second) {
      const message = (failure: unknown) =>
        failure instanceof Error ? failure.message : String(failure);
      return {
        release: null,
        error: `${message(first)}; ${message(second)}`,
      };
    }
  }
}

type SourceFiles = Record<keyof typeof SOURCE_FILES, string | null>;

async function fetchSourceFiles(
  config: OpenCodeConfig,
  ref: string,
): Promise<SourceFiles> {
  const names = Object.keys(SOURCE_FILES) as (keyof typeof SOURCE_FILES)[];
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const response = await fetch(
        `${config.sourceBase}/${ref}/${SOURCE_FILES[name]}`,
        { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text();
    }),
  );
  const files = {} as SourceFiles;
  names.forEach((name, index) => {
    const result = results[index] as PromiseSettledResult<string>;
    files[name] = result.status === "fulfilled" ? result.value : null;
  });
  return files;
}

/**
 * Apply whatever the release source validates. Each failed extraction leaves
 * the previous value in place, so a partial read degrades to the last known
 * good shape instead of an empty one.
 */
function applySource(recipe: Recipe, files: SourceFiles): Recipe {
  const next: Recipe = { ...recipe, headers: [...recipe.headers] };
  const identifier = files.identifier ?? "";
  const sessionId = files.sessionId ?? "";
  const app = files.app ?? "";
  const modelRequest = files.modelRequest ?? "";

  const charset = /const\s+chars\s*=\s*"([^"]+)"/.exec(identifier)?.[1];
  if (charset && charset.length >= 2 && charset.length <= 128)
    next.sessionCharset = charset;

  const length = Number(/const\s+length\s*=\s*(\d+)/.exec(sessionId)?.[1]);
  if (Number.isInteger(length) && length >= 16 && length <= 64)
    next.sessionLength = length;

  const multiplier = /BigInt\(timestamp\)\s*\*\s*0x([0-9a-fA-F]+)n/.exec(
    sessionId,
  )?.[1];
  if (multiplier) {
    const parsed = Number.parseInt(multiplier, 16);
    if (Number.isSafeInteger(parsed) && parsed > 0)
      next.sessionMultiplier = BigInt(parsed);
  }

  const prefix = /make\(\s*"([a-z]+_)"\s*\+\s*descending/.exec(sessionId)?.[1];
  if (prefix && prefix.length <= 16) next.sessionPrefix = prefix;

  const template = /return\s+`(opencode\/[^`]+)`/.exec(app)?.[1];
  if (template) {
    const candidate = { ...next, userAgentTemplate: template };
    if (
      /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/.test(
        renderUserAgent(candidate, null),
      )
    )
      next.userAgentTemplate = template;
  }

  const headerBlock = /headers:\s*\{([\s\S]{0,2000}?)\n\s{8}\}/.exec(
    modelRequest,
  )?.[1];
  if (headerBlock) {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const match of headerBlock.matchAll(
      /^\s*"([A-Za-z][A-Za-z0-9-]*)":/gm,
    )) {
      const name = match[1] as string;
      const lower = name.toLowerCase();
      if (lower === "..." || seen.has(lower)) continue;
      seen.add(lower);
      names.push(name);
    }
    if (names.length > 0) next.headers = names;
  }

  return next;
}

/**
 * Move the identity to whatever the handshake points at.
 *
 * `reactive` (default) only adopts a release when upstream flags it as
 * mandatory or when a gate rejection asked for it; `always` follows every
 * release. The caller refreshes the catalog afterwards.
 */
export async function refreshRelease(
  config: OpenCodeConfig,
  state: IdentityState,
  force: boolean,
): Promise<{ outcome: RefreshOutcome; error: string | null }> {
  if (config.userAgent !== null) return { outcome: "pinned", error: null };
  const now = Date.now();
  if (!force && now - state.lastCheck < IDENTITY_TTL_MS)
    return { outcome: "fresh", error: null };
  state.lastCheck = now;

  const { release, error } = await resolveRelease(config, state.recipe.version);
  if (!release) {
    state.lastError = `identity refresh failed: ${error}`;
    return { outcome: "failed", error: state.lastError };
  }
  if (release.source === "update-api") state.source = release.source;

  const comparison = compareVersions(release.version, state.recipe.version);
  const shouldAdopt =
    force ||
    config.updateMode === "always" ||
    release.minimum ||
    state.versionFloor !== null;

  if (comparison === 0 && !force) {
    state.availableVersion = null;
    state.lastError = null;
    return { outcome: "up-to-date", error: null };
  }
  if (comparison > 0 && !shouldAdopt) {
    state.availableVersion = release.version;
    state.lastError = null;
    return { outcome: "available-not-adopted", error: null };
  }
  if (comparison < 0) {
    state.availableVersion = null;
    state.lastError = null;
    return { outcome: "newer-local", error: null };
  }

  const ref = release.sha ?? `v${release.version}`;
  const before = state.recipe;
  const next: Recipe = { ...state.recipe, version: release.version };
  if (ref !== state.appliedRef || force) {
    const files = await fetchSourceFiles(config, ref);
    const applied = applySource(next, files);
    next.sessionCharset = applied.sessionCharset;
    next.sessionLength = applied.sessionLength;
    next.sessionMultiplier = applied.sessionMultiplier;
    next.sessionPrefix = applied.sessionPrefix;
    next.userAgentTemplate = applied.userAgentTemplate;
    next.headers = applied.headers;
    state.appliedRef = ref;
  }

  const shapeChanged =
    next.version !== before.version ||
    next.sessionPrefix !== before.sessionPrefix ||
    next.sessionCharset !== before.sessionCharset ||
    next.sessionLength !== before.sessionLength ||
    next.sessionMultiplier !== before.sessionMultiplier ||
    next.userAgentTemplate !== before.userAgentTemplate ||
    next.headers.join(",") !== before.headers.join(",");

  state.recipe = next;
  state.sha = release.sha;
  state.fetchedAt = now;
  state.availableVersion = null;
  state.versionFloor = null;
  state.lastError = null;
  if (shapeChanged) state.epoch += 1;
  return { outcome: "adopted", error: null };
}

/** Adopt a version upstream said is mandatory, without re-running the sync. */
export function adoptVersionFloor(
  state: IdentityState,
  floor: string,
): boolean {
  if (compareVersions(floor, state.recipe.version) <= 0) return false;
  state.versionFloor = floor;
  state.recipe = { ...state.recipe, version: floor };
  state.epoch += 1;
  return true;
}

let lastTimestamp = 0;
let counter = 0;

/** Port of the CLI's `Identifier` generator (monotonic, descending by default). */
export function createId(
  recipe: Recipe,
  descending = true,
  timestamp = Date.now(),
): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;
  const current =
    BigInt(timestamp + extraMs) * recipe.sessionMultiplier +
    BigInt(effectiveCounter);
  const value = descending ? ~current : current;
  const hex = (value & ((1n << 48n) - 1n)).toString(16).padStart(12, "0");
  const randomChars = Math.max(0, recipe.sessionLength - 12);
  const bytes = randomBytes(randomChars);
  let suffix = "";
  for (const byte of bytes)
    suffix += recipe.sessionCharset[byte % recipe.sessionCharset.length];
  return hex + suffix;
}

export function createSessionId(recipe: Recipe): string {
  return recipe.sessionPrefix + createId(recipe, true);
}

/** The header names the gate requires by name, whatever the recipe lists. */
export const GATE_ANCHOR_HEADERS = [
  "user-agent",
  "x-opencode-session",
  "x-session-affinity",
];

/**
 * The identity headers, one spelling per name: `User-Agent` keeps its
 * conventional form, everything else stays lowercase so a case change upstream
 * cannot produce a duplicate key. Names the recipe lists but this proxy cannot
 * fill are skipped, never sent empty.
 */
export function buildGateHeaders(
  recipe: Recipe,
  values: {
    userAgent: string;
    project: string;
    sessionId: string;
  },
): { headers: Record<string, string>; unsent: string[] } {
  const byName: Record<string, string> = {
    "user-agent": values.userAgent,
    "x-opencode-client": recipe.client,
    "x-opencode-project": values.project,
    "x-opencode-session": values.sessionId,
    "x-opencode-session-id": values.sessionId,
    "x-session-affinity": values.sessionId,
    "x-session-id": values.sessionId,
  };
  const names = [...recipe.headers];
  for (const anchor of GATE_ANCHOR_HEADERS) {
    if (!names.some((name) => name.toLowerCase() === anchor))
      names.push(anchor);
  }
  const headers: Record<string, string> = {};
  const unsent: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const value = byName[lower];
    if (value === undefined) {
      unsent.push(name);
      continue;
    }
    headers[lower === "user-agent" ? "User-Agent" : lower] = value;
  }
  return { headers, unsent };
}
