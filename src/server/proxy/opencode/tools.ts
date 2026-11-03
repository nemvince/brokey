/**
 * The tool definitions the OpenCode free-tier gate fingerprints.
 *
 * Derived from `azrinaldi/opencode-free-bridge` (`identity.js`, `DEFAULT_TOOLS`):
 * https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/identity.js
 * Copyright (c) 2026 azrinaldi — MIT. See THIRD_PARTY_NOTICES.md.
 *
 * Upstream rejects a request whose `tools` array lacks a tool named `read`,
 * and a client tool that reuses that name with a different schema has to be
 * renamed so the canonical definition can be injected next to it.
 */

export type ToolDefinition = {
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

export type MergeResult = {
  tools: ChatTool[];
  /** Tool names brokey added because the client did not send them verbatim. */
  appended: string[];
  /** Set when placeholders were appended: tells the model not to call them. */
  placeholderNote: string;
  /** alias → client's original tool name; used to rewrite responses. */
  aliasToOriginal: Map<string, string>;
  /** client's original tool name → alias; used to rewrite follow-up turns. */
  originalToAlias: Map<string, string>;
};

const READ: ToolDefinition = {
  description:
    "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to read" },
      offset: {
        type: "integer",
        minimum: 0,
        description:
          "The line or directory entry to start reading from (1-based)",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description:
          "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const SHELL: ToolDefinition = {
  description:
    "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command string to execute",
      },
      workdir: {
        type: "string",
        description:
          "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        description:
          "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/** Shipped profile, in the order the gate expects to see it. */
const DEFAULT_TOOLS: Record<string, ToolDefinition> = {
  read: READ,
  shell: SHELL,
};

/** Only names present in the shipped profile survive. */
export const CORE_TOOL_NAMES = ["read", "shell"];

/** The gate checks these names, not their schemas. */
export const GATE_ANCHOR_TOOL_NAMES = ["read"];

/**
 * Stable JSON for schema comparison: key order must not affect equality, since
 * two definitions that differ only in property order are the same schema.
 */
export function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function getToolName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const record = tool as Record<string, unknown>;
  if (typeof record.name === "string") return record.name.trim();
  const fn = record.function;
  if (fn && typeof fn === "object") {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string") return name.trim();
  }
  return "";
}

/** The profile as nested chat-completions tools, with the anchor pinned. */
export function getCanonicalTools(): ChatTool[] {
  return CORE_TOOL_NAMES.flatMap((name) => {
    const def = DEFAULT_TOOLS[name];
    if (!def) return [];
    return [
      {
        type: "function" as const,
        function: {
          name,
          description: def.description,
          parameters: def.parameters,
          strict: false,
        },
      },
    ];
  });
}

function isExactFingerprintDef(tool: unknown, name: string): boolean {
  const want = DEFAULT_TOOLS[name];
  if (!want || !tool || typeof tool !== "object") return false;
  const record = tool as Record<string, unknown>;
  const def =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : record;
  return (
    def.description === want.description &&
    stableStringify(def.parameters) === stableStringify(want.parameters)
  );
}

function buildPlaceholderNote(appended: string[]): string {
  if (appended.length === 0) return "";
  const list = appended.map((name) => `\`${name}\``).join(" or ");
  return appended.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

/**
 * Merge the client's tools with the definitions the gate requires.
 *
 * Per required tool: the client already sends it verbatim (keep its copy), the
 * client reuses the name with a different schema (rename the client's copy so
 * both survive), or the client does not send it at all (append the definition).
 */
export function mergeTools(clientTools: unknown): MergeResult {
  const canonical = getCanonicalTools();
  const canonicalByName = new Map(
    canonical.map((tool) => [tool.function.name, tool]),
  );
  const fingerprintNames = CORE_TOOL_NAMES.filter((name) =>
    canonicalByName.has(name),
  );
  const list = Array.isArray(clientTools) ? clientTools : [];

  if (list.length === 0) {
    return {
      tools: canonical,
      appended: fingerprintNames,
      placeholderNote: buildPlaceholderNote(fingerprintNames),
      aliasToOriginal: new Map(),
      originalToAlias: new Map(),
    };
  }

  const aliasToOriginal = new Map<string, string>();
  const originalToAlias = new Map<string, string>();
  const normalized: ChatTool[] = [];
  const takenNames = new Set(list.map(getToolName).filter(Boolean));
  const presentExact = new Set<string>();

  for (const tool of list) {
    const name = getToolName(tool);
    if (!name) continue;
    const record = tool as Record<string, unknown>;
    const def =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : record;
    const description =
      typeof def.description === "string" ? def.description : "";
    const parameters =
      def.parameters && typeof def.parameters === "object"
        ? (def.parameters as Record<string, unknown>)
        : { type: "object", properties: {} };

    if (fingerprintNames.includes(name)) {
      if (presentExact.has(name)) continue;
      if (isExactFingerprintDef(tool, name)) {
        presentExact.add(name);
        normalized.push({
          type: "function",
          function: { name, description, parameters },
        });
        continue;
      }
      // The client defined its own tool under a fingerprinted name: alias it so
      // the exact definition can still be injected alongside.
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let suffix = 2; takenNames.has(alias); suffix++)
        alias = `${name}_client${suffix}`;
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push({
        type: "function",
        function: { name: alias, description, parameters },
      });
      continue;
    }

    normalized.push({
      type: "function",
      function: { name, description, parameters },
    });
  }

  const appended: string[] = [];
  for (const name of fingerprintNames) {
    if (presentExact.has(name)) continue;
    const def = canonicalByName.get(name);
    if (!def) continue;
    normalized.push(def);
    appended.push(name);
  }

  return {
    tools: normalized,
    appended,
    placeholderNote: buildPlaceholderNote(
      appended.length === fingerprintNames.length ? fingerprintNames : appended,
    ),
    aliasToOriginal,
    originalToAlias,
  };
}
