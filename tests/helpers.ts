import { createApp } from "../src/server/app.ts";
import type { OpenCodeConfig } from "../src/server/config.ts";
import type { AppDb } from "../src/server/db.ts";
import { usageLogs } from "../src/server/schema.ts";

export const ADMIN_TOKEN = "test-admin-token";

export type TestApp = {
  db: AppDb;
  baseUrl: string;
  stop: () => void;
};

export function startTestApp(
  options: {
    adminToken?: string;
    dbPath?: string;
    opencode?: Partial<OpenCodeConfig>;
  } = {},
): TestApp {
  const app = createApp({
    port: 0,
    dbPath: options.dbPath ?? ":memory:",
    adminToken: options.adminToken ?? ADMIN_TOKEN,
    development: false,
    opencode: options.opencode,
  });
  return {
    db: app.db,
    baseUrl: `http://127.0.0.1:${app.server.port}`,
    stop: () => app.stop(),
  };
}

export type MockCall = {
  path: string;
  method: string;
  auth: string;
  headers: Record<string, string>;
  body: unknown;
};

export type MockUpstream = {
  baseUrl: string;
  calls: MockCall[];
  models: unknown[];
  /** Override `/chat/completions`: return a Response or undefined to use the default. */
  chatHandler:
    ((call: MockCall) => Response | Promise<Response> | undefined) | null;
  modelsHandler: ((call: MockCall) => Response | undefined) | null;
  /** Handle any other path (legacy completions, images, hostile responses). */
  anyHandler:
    ((call: MockCall) => Response | Promise<Response> | undefined) | null;
  stop: () => void;
};

export function startMockUpstream(
  options: { models?: unknown[]; quiet?: boolean } = {},
): MockUpstream {
  const state: MockUpstream = {
    baseUrl: "",
    calls: [],
    models: options.models ?? [
      {
        id: "upstream-mock-chat",
        name: "Mock Chat",
        context_length: 128000,
        owned_by: "mock",
      },
      { id: "gpt-x", name: "GPT X", context_length: 32000 },
    ],
    chatHandler: null,
    modelsHandler: null,
    anyHandler: null,
    stop: () => undefined,
  };

  const defaultChat = (call: MockCall): Response => {
    const body = call.body as { model?: string; stream?: boolean } | null;
    if (body?.stream === true) {
      const lines = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
        "",
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ];
      return new Response(lines.join("\n"), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "cmpl-1",
      model: body?.model ?? null,
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      const raw = await req.text();
      let body: unknown = null;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const call: MockCall = {
        path: url.pathname,
        method: req.method,
        auth,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      state.calls.push(call);

      if (url.pathname === "/v1/models") {
        const custom = state.modelsHandler?.(call);
        if (custom) return custom;
        return Response.json({ data: state.models });
      }
      if (url.pathname === "/v1/chat/completions") {
        const custom = await state.chatHandler?.(call);
        if (custom) return custom;
        return defaultChat(call);
      }
      const any = await state.anyHandler?.(call);
      if (any) return any;
      if (url.pathname === "/v1/completions") {
        return Response.json({
          choices: [{ text: "legacy completion" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        });
      }
      return Response.json(
        { error: { message: "not found" } },
        { status: 404 },
      );
    },
  });

  state.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  state.stop = () => server.stop(true);
  return state;
}

type RequestOptions = {
  token?: string;
  body?: unknown;
  method?: string;
  raw?: string;
  headers?: Record<string, string>;
};

function init(options: RequestOptions, auth: string | null): RequestInit {
  const headers = new Headers(options.headers);
  if (auth) headers.set("authorization", auth);
  if (options.raw !== undefined) {
    headers.set("content-type", "application/json");
    return { method: options.method ?? "POST", headers, body: options.raw };
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    return {
      method: options.method ?? "POST",
      headers,
      body: JSON.stringify(options.body),
    };
  }
  return { method: options.method ?? "GET", headers };
}

export async function adminRequest(
  app: TestApp,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const token = options.token ?? ADMIN_TOKEN;
  return fetch(
    `${app.baseUrl}${path}`,
    init(options, token === "" ? null : `Bearer ${token}`),
  );
}

export async function adminJson<T = Record<string, unknown>>(
  app: TestApp,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await adminRequest(app, path, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`admin ${path} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

export async function proxyRequest(
  app: TestApp,
  path: string,
  token: string,
  options: RequestOptions = {},
): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, init(options, `Bearer ${token}`));
}

export type SeededProvider = {
  providerId: number;
  keyIds: number[];
  name: string;
};

export async function seedProvider(
  app: TestApp,
  options: {
    name?: string;
    baseUrl: string;
    secrets?: string[];
    enabled?: boolean;
  },
): Promise<SeededProvider> {
  const name =
    options.name ?? `provider-${Math.random().toString(36).slice(2, 8)}`;
  const provider = await adminJson<{ id: number }>(
    app,
    "/api/admin/providers",
    {
      body: {
        name,
        baseUrl: options.baseUrl,
        enabled: options.enabled ?? true,
      },
    },
  );
  const keyIds: number[] = [];
  for (const [index, secret] of (
    options.secrets ?? ["sk-test-key-a"]
  ).entries()) {
    const key = await adminJson<{ id: number }>(
      app,
      `/api/admin/providers/${provider.id}/keys`,
      {
        body: { label: `key-${index + 1}`, secret },
      },
    );
    keyIds.push(key.id);
  }
  return { providerId: provider.id, keyIds, name };
}

/** An OpenCode free provider: no base URL, no API key. */
export async function seedOpenCodeProvider(
  app: TestApp,
  options: {
    name?: string;
    baseUrl?: string;
    enabled?: boolean;
  } = {},
): Promise<SeededProvider> {
  const name =
    options.name ?? `opencode-${Math.random().toString(36).slice(2, 8)}`;
  const provider = await adminJson<{ id: number }>(
    app,
    "/api/admin/providers",
    {
      body: {
        name,
        kind: "opencode",
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        enabled: options.enabled ?? true,
      },
    },
  );
  return { providerId: provider.id, keyIds: [], name };
}

export async function seedModel(
  app: TestApp,
  providerId: number,
  model: {
    upstreamId: string;
    publicId: string;
    displayName?: string;
    enabled?: boolean;
  },
): Promise<{ id: number; publicId: string }> {
  return adminJson<{ id: number; publicId: string }>(app, "/api/admin/models", {
    body: { providerId, ...model },
  });
}

export async function seedClientKey(
  app: TestApp,
  body: {
    name?: string;
    limitWindow?: "total" | "day" | "month";
    limitRequests?: number | null;
    limitTokens?: number | null;
  } = {},
): Promise<{ id: number; token: string }> {
  const created = await adminJson<{ id: number; key: string }>(
    app,
    "/api/admin/client-keys",
    {
      body: { name: body.name ?? "test-key", ...body },
    },
  );
  return { id: created.id, token: created.key };
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function insertUsageLog(
  app: TestApp,
  overrides: Partial<typeof usageLogs.$inferInsert> = {},
): void {
  app.db
    .insert(usageLogs)
    .values({
      requestId: `req_${Math.random().toString(36).slice(2)}`,
      clientKeyId: null,
      clientKeyLabel: "seed",
      providerId: null,
      providerName: "seed-provider",
      providerKeyId: null,
      modelId: null,
      modelPublicId: "",
      endpoint: "/v1/chat/completions",
      method: "POST",
      streamed: false,
      status: 200,
      errorCode: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
      latencyMs: 1,
      upstreamLatencyMs: 1,
      createdAt: Date.now(),
      ...overrides,
    })
    .run();
}
