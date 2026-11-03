import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeConfig } from "../../config.ts";
import { HOP_BY_HOP } from "../../headers.ts";
import { buildGateHeaders, type Recipe, renderUserAgent } from "./identity.ts";

/**
 * The request shape the OpenCode free-tier gate fingerprints: a harness `<env>`
 * block in the system prompt, a session project id, the identity headers, and
 * the CLI's own field order in the body. See `identity.ts` for the origin.
 */

export type ShapeContext = {
  envBlock: string;
  projectId: string;
};

/** The CLI's system-prompt block: honest equivalents of its own session values. */
function buildEnvBlock(): string {
  const cwd = process.cwd();
  let isRepo = "no";
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    isRepo = "yes";
  } catch {
    // not a checkout, or git is unavailable
  }
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${isRepo}`,
    "  Platform: " + process.platform,
    "</env>",
  ].join("\n");
}

/**
 * `sha1("git-remote:<host>/<path>")` for a checkout, `sha1("directory:<path>")`
 * otherwise, or the contents of an `opencode` file in the directory — exactly
 * how the CLI derives it. Sending the literal "global" is a shape the CLI never
 * emits.
 */
function deriveProjectId(): string {
  const cwd = process.cwd();
  try {
    const marker = join(cwd, "opencode");
    if (existsSync(marker)) {
      const value = readFileSync(marker, "utf8").trim();
      if (value !== "") return value;
    }
    let remote = "";
    try {
      remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {
      remote = "";
    }
    if (remote !== "") {
      const normalized = remote
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/^git@([^:]+):/i, "$1/")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
      if (normalized !== "")
        return createHash("sha1")
          .update(`git-remote:${normalized}`)
          .digest("hex");
    }
    return createHash("sha1").update(`directory:${cwd}`).digest("hex");
  } catch {
    return "global";
  }
}

/** Built once per runtime: probing git on every request costs a subprocess. */
export function createShapeContext(): ShapeContext {
  return { envBlock: buildEnvBlock(), projectId: deriveProjectId() };
}

const ENV_BLOCK_PRESENT = /<env>[\s\S]*?Working directory:/;

export function withEnvBlock(text: string, envBlock: string): string {
  if (ENV_BLOCK_PRESENT.test(text)) return text;
  const trimmed = text.replace(/\s+$/, "");
  return trimmed === "" ? envBlock : `${trimmed}\n\n${envBlock}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part === "object"
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
    )
    .join("");
}

/**
 * Rename aliased client tools back for replay, add the placeholder note, and
 * make sure the system prompt carries the harness block.
 */
export function transformChatMessages(
  messages: unknown[],
  originalToAlias: Map<string, string>,
  placeholderNote: string,
  envBlock: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const entry = message as Record<string, unknown>;
    const toolCalls = entry.tool_calls;
    if (
      originalToAlias.size > 0 &&
      entry.role === "assistant" &&
      Array.isArray(toolCalls)
    ) {
      out.push({
        ...entry,
        tool_calls: toolCalls.map((call) => {
          if (!call || typeof call !== "object") return call;
          const record = call as Record<string, unknown>;
          const fn = record.function;
          if (!fn || typeof fn !== "object") return call;
          const name = (fn as Record<string, unknown>).name;
          const alias =
            typeof name === "string" ? originalToAlias.get(name) : undefined;
          return alias ? { ...record, function: { ...fn, name: alias } } : call;
        }),
      });
      continue;
    }
    out.push({ ...entry });
  }

  if (placeholderNote !== "") {
    const first = out[0];
    if (first && (first.role === "system" || first.role === "developer")) {
      if (typeof first.content === "string") {
        out[0] = {
          ...first,
          content: `${first.content}\n\n${placeholderNote}`,
        };
      } else if (Array.isArray(first.content)) {
        out[0] = {
          ...first,
          content: [
            ...first.content,
            { type: "text", text: `\n\n${placeholderNote}` },
          ],
        };
      } else {
        out.unshift({ role: "system", content: placeholderNote });
      }
    } else {
      out.unshift({ role: "system", content: placeholderNote });
    }
  }

  const systemIndex = out.findIndex(
    (message) => message.role === "system" || message.role === "developer",
  );
  if (systemIndex === -1) {
    out.unshift({ role: "system", content: envBlock });
    return out;
  }
  const system = out[systemIndex] as Record<string, unknown>;
  if (typeof system.content === "string") {
    out[systemIndex] = {
      ...system,
      content: withEnvBlock(system.content, envBlock),
    };
  } else if (Array.isArray(system.content)) {
    if (!ENV_BLOCK_PRESENT.test(contentText(system.content))) {
      out[systemIndex] = {
        ...system,
        content: [...system.content, { type: "text", text: `\n\n${envBlock}` }],
      };
    }
  } else {
    out[systemIndex] = { ...system, content: envBlock };
  }
  return out;
}

export type ChatBodyInput = {
  payload: Record<string, unknown>;
  /** The upstream model id sent in the body. */
  model: string;
  tools: unknown[];
  placeholderNote: string;
  originalToAlias: Map<string, string>;
  envBlock: string;
  maxCompletionTokens: number;
  messages: unknown[];
};

/**
 * Field names and order match the CLI's own request: `max_completion_tokens`
 * (not the legacy `max_tokens`), `store: false`, `tools` before `stream`.
 */
export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
  const { payload } = input;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: transformChatMessages(
      input.messages,
      input.originalToAlias,
      input.placeholderNote,
      input.envBlock,
    ),
    tools: input.tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: input.maxCompletionTokens,
    store: false,
  };
  if (typeof payload.temperature === "number")
    body.temperature = payload.temperature;
  if (typeof payload.top_p === "number") body.top_p = payload.top_p;
  if (payload.stop !== undefined) body.stop = payload.stop;
  if (payload.response_format !== undefined)
    body.response_format = payload.response_format;
  if (payload.reasoning_effort !== undefined)
    body.reasoning_effort = payload.reasoning_effort;
  // Upstream rejects `tool_choice: "none"` with a FreeTierError.
  const choice = payload.tool_choice;
  if (choice && choice !== "none") {
    let renamed: Record<string, unknown> | null = null;
    if (typeof choice === "object" && choice !== null) {
      const record = choice as Record<string, unknown>;
      const fn = record.function;
      if (fn && typeof fn === "object") {
        const call = fn as Record<string, unknown>;
        const name = call.name;
        const alias =
          typeof name === "string"
            ? input.originalToAlias.get(name)
            : undefined;
        if (alias) renamed = { ...record, function: { ...call, name: alias } };
      }
    }
    body.tool_choice = renamed ?? choice;
  }
  return body;
}

/** Trace context the CLI emits on every request; values are random per request. */
function traceHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const parentSpanId = randomBytes(8).toString("hex");
  return {
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

const DROP_REQUEST_HEADERS = [
  "host",
  "authorization",
  "content-length",
  "accept-encoding",
  "cookie",
];

/** Client headers that describe something other than the request body. */
function isDroppedHeader(lower: string): boolean {
  if (HOP_BY_HOP.includes(lower) || DROP_REQUEST_HEADERS.includes(lower))
    return true;
  if (lower.startsWith("proxy-") || lower.startsWith("x-brokey-")) return true;
  // Identity headers are brokey's to set: forwarding a client's own would let
  // two conversations share a session id, or replace the derived User-Agent.
  return (
    lower.startsWith("x-opencode-") ||
    lower.startsWith("x-session-") ||
    lower === "b3" ||
    lower === "traceparent"
  );
}

export function buildHeaders(
  req: Request,
  recipe: Recipe,
  config: OpenCodeConfig,
  shape: ShapeContext,
  sessionId: string,
  extra: Record<string, string> | null,
): Headers {
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (isDroppedHeader(name.toLowerCase())) return;
    headers.set(name, value);
  });
  if (extra) {
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  // The CLI sends `*/*` here: it always streams via the body, not the Accept
  // header.
  headers.set("accept", "*/*");
  headers.set("authorization", "Bearer public");
  for (const [name, value] of Object.entries(traceHeaders()))
    headers.set(name, value);
  const gate = buildGateHeaders(recipe, {
    userAgent: renderUserAgent(recipe, config.userAgent),
    project: shape.projectId,
    sessionId,
  });
  for (const [name, value] of Object.entries(gate.headers))
    headers.set(name, value);
  return headers;
}

/** Which gate anchors the request that upstream refused actually carried. */
export function auditGateShape(
  body: Record<string, unknown>,
  headers: Headers,
): { shapeOk: boolean; missing: string[] } {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return "";
    const record = tool as Record<string, unknown>;
    const fn = record.function;
    if (fn && typeof fn === "object")
      return String((fn as Record<string, unknown>).name ?? "");
    return String(record.name ?? "");
  });
  const sessionHeaders = [
    "x-opencode-session",
    "x-session-affinity",
    "x-session-id",
  ].filter((name) => headers.has(name));
  const missing: string[] = [];
  if (!names.includes("read")) missing.push("tool `read`");
  if (
    !/^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/i.test(
      headers.get("user-agent") ?? "",
    )
  )
    missing.push("an `opencode/*` User-Agent");
  if (sessionHeaders.length === 0) missing.push("a session header");
  return { shapeOk: missing.length === 0, missing };
}
