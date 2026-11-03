import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { egressHealth, usageLogs } from "../src/server/schema.ts";
import {
  adminJson,
  adminRequest,
  proxyRequest,
  readJson,
  seedClientKey,
  seedOpenCodeProvider,
  startMockUpstream,
  startTestApp,
  type MockUpstream,
  type TestApp,
} from "./helpers.ts";

type PreviewBody = {
  added: { upstreamId: string; suggestedPublicId: string }[];
};
type ModelsBody = { data: { id: string }[] };
type ChatCompletion = {
  model: string;
  choices: {
    message: {
      content: string | null;
      reasoning_content?: string;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
type DetailBody = {
  kind: string;
  baseUrl: string;
  opencode?: {
    identity: { version: string; userAgent: string; chatUrl: string };
    gate: { status: string; lastRejection: unknown };
    egress: { active: boolean; entries: unknown[] };
  };
};

/** Catalog fixture: one free chat model, plus the entries a sync must exclude. */
const CATALOG = {
  opencode: {
    api: "https://opencode.ai/inference/openai/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "big-pickle": {
        name: "Big Pickle",
        cost: { input: 0, output: 0 },
        limit: { context: 200_000, output: 64_000 },
        reasoning: true,
        tool_call: true,
        family: "pickle",
      },
      "mimo-v2.6-flash-free": {
        name: "MiMo Flash",
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 32_000 },
        reasoning: true,
        tool_call: true,
        family: "mimo",
      },
      "paid-model": {
        name: "Paid Model",
        cost: { input: 3, output: 15 },
        limit: { context: 128_000, output: 8_000 },
      },
      "retired-model": {
        name: "Retired",
        cost: { input: 0, output: 0 },
        status: "deprecated",
      },
      "no-tools-model": {
        name: "No Tools",
        cost: { input: 0, output: 0 },
        tool_call: false,
      },
    },
  },
};

function sse(lines: unknown[]): Response {
  const text = lines
    .map((line) =>
      typeof line === "string"
        ? `data: ${line}`
        : `data: ${JSON.stringify(line)}`,
    )
    .join("\n\n");
  return new Response(`${text}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

const STREAM_LINES = [
  {
    choices: [
      { delta: { role: "assistant", reasoning: "thinking" }, index: 0 },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_client", arguments: '{"path":"a"}' },
            },
          ],
        },
        index: 0,
      },
    ],
  },
  { choices: [{ delta: { content: "hel" }, index: 0 }] },
  { choices: [{ delta: { content: "lo" }, index: 0 }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
  {
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  },
  "[DONE]",
];

describe("opencode free provider", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;
  /** Completions only: a forced refresh also fetches the catalog from the mock. */
  const chatCalls = () =>
    mock.calls.filter((call) => call.path.endsWith("/chat/completions"));

  beforeAll(async () => {
    mock = startMockUpstream();
    mock.anyHandler = (call) =>
      call.path.endsWith("/catalog.json") ? Response.json(CATALOG) : undefined;
    // The mock advertises `/v1/chat/completions`, so pointing the pinned chat
    // base at the mock's `/v1` root is the whole override.
    app = startTestApp({
      opencode: {
        userAgent: "opencode/latest/2.2.5/cli",
        chatUrl: mock.baseUrl,
        catalogUrl: `${mock.baseUrl}/catalog.json`,
      },
    });
    const provider = await seedOpenCodeProvider(app, { name: "free" });
    providerId = provider.providerId;
    token = (await seedClientKey(app, { name: "oc-client" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("created without a base URL and no API key", async () => {
    const detail = await adminJson<DetailBody>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    expect(detail.kind).toBe("opencode");
    expect(detail.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
    expect(detail.opencode?.identity.userAgent).toBe(
      "opencode/latest/2.2.5/cli",
    );
    expect(detail.opencode?.egress.active).toBe(false);

    const keyAttempt = await adminRequest(
      app,
      `/api/admin/providers/${providerId}/keys`,
      { body: { label: "nope", secret: "sk-x" } },
    );
    expect(keyAttempt.status).toBe(400);

    const models = await readJson<ModelsBody>(
      await proxyRequest(app, "/v1/models", token),
    );
    expect(models.data).toEqual([]);
  });

  test("sync lists only free, non-deprecated models", async () => {
    const preview = await adminJson<PreviewBody>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      { body: {} },
    );
    const ids = preview.added.map((entry) => entry.upstreamId).sort();
    expect(ids).toEqual(["big-pickle", "mimo-v2.6-flash-free"]);

    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {
        added: preview.added.map((entry) => ({
          upstreamId: entry.upstreamId,
          publicId: entry.suggestedPublicId,
        })),
      },
    });

    const models = await readJson<ModelsBody>(
      await proxyRequest(app, "/v1/models", token),
    );
    expect(models.data.map((model) => model.id).sort()).toEqual([
      "big-pickle",
      "mimo-v2.6-flash-free",
    ]);
  });

  test("non-streaming client gets a shaped completion", async () => {
    mock.calls.length = 0;
    mock.chatHandler = () => sse(STREAM_LINES);

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "read a file" }],
        max_tokens: 100,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client's own read",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "none",
      },
    });
    expect(response.status).toBe(200);
    const body = await readJson<ChatCompletion>(response);
    expect(body.choices[0]?.message.content).toBe("hello");
    expect(body.choices[0]?.message.reasoning_content).toBe("thinking");
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "read",
    );
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.usage.total_tokens).toBe(16);

    const call = chatCalls()[0];
    expect(call?.path).toBe("/v1/chat/completions");
    expect(call?.headers["authorization"]).toBe("Bearer public");
    expect(call?.headers["user-agent"]).toBe("opencode/latest/2.2.5/cli");
    expect(call?.headers["x-opencode-session"]).toMatch(
      /^ses_[0-9a-zA-Z]{26}$/,
    );
    expect(call?.headers["x-session-affinity"]).toBe(
      call?.headers["x-opencode-session"],
    );
    expect(call?.headers["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);
    expect(call?.headers["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );

    const upstream = call?.body as Record<string, unknown>;
    expect(upstream.stream).toBe(true);
    expect(upstream.stream_options).toEqual({ include_usage: true });
    expect(upstream.store).toBe(false);
    // 100 requested, floored to the reasoning minimum and lifted by the budget.
    expect(upstream.max_completion_tokens).toBe(1024 + 4096);
    expect(upstream.tool_choice).toBeUndefined();
    const messages = upstream.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("<env>\n  Working directory:");
    const tools = (upstream.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    expect(tools).toContain("read");
    expect(tools).toContain("shell");
    expect(tools).toContain("read_client");
  });

  test("streaming client sees reasoning_content and restored tool names", async () => {
    mock.calls.length = 0;
    mock.chatHandler = () => sse(STREAM_LINES);

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client's own read",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"reasoning_content":"thinking"');
    expect(text).not.toContain('"reasoning":"thinking"');
    expect(text).toContain('"name":"read"');
    expect(text).not.toContain("read_client");
    // The usage chunk is dropped because the client never asked for it.
    expect(text).not.toContain('"usage"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const logged = app.db
      .select()
      .from(usageLogs)
      .orderBy(desc(usageLogs.id))
      .limit(1)
      .all()[0];
    expect(logged?.providerKeyId).toBeNull();
    expect(logged?.totalTokens).toBe(16);
    expect(logged?.status).toBe(200);
  });

  test("a gate rejection re-mints the session and retries once", async () => {
    mock.calls.length = 0;
    let attempt = 0;
    mock.chatHandler = () => {
      attempt += 1;
      if (attempt === 1)
        return Response.json(
          {
            error: {
              type: "FreeTierError",
              message:
                "OpenCode's free tier can only be used from within OpenCode",
            },
          },
          { status: 403 },
        );
      return sse(STREAM_LINES);
    };

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "heal me" }],
      },
    });
    expect(response.status).toBe(200);
    expect(chatCalls().length).toBe(2);
    const first = chatCalls()[0]?.headers["x-opencode-session"];
    const second = chatCalls()[1]?.headers["x-opencode-session"];
    expect(first).toMatch(/^ses_/);
    expect(second).toMatch(/^ses_/);
    expect(second).not.toBe(first);
  });

  test("an IP-abuse block is terminal", async () => {
    mock.calls.length = 0;
    mock.chatHandler = () =>
      Response.json(
        {
          error: {
            type: "FreeTierError",
            message: "Your IP has been flagged for abusive traffic",
          },
        },
        { status: 403 },
      );

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "blocked" }],
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-brokey-gate")).toBe("ip-abuse");
    expect(chatCalls().length).toBe(1);
    const detail = await adminJson<DetailBody>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    expect(detail.opencode?.gate.status).toBe("ip-blocked");
  });

  test("a non-chat endpoint is refused before any upstream call", async () => {
    mock.calls.length = 0;
    const response = await proxyRequest(app, "/v1/responses", token, {
      body: { model: "big-pickle", input: "hi" },
    });
    expect(response.status).toBe(400);
    const body = await readJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("unsupported_endpoint");
    expect(mock.calls.length).toBe(0);
  });

  test("an in-stream error becomes an error event, not a silent success", async () => {
    mock.chatHandler = () =>
      sse([
        { choices: [{ delta: { content: "partial" } }] },
        { error: { message: "upstream exploded", type: "api_error" } },
        "[DONE]",
      ]);
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "break" }],
        stream: true,
      },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"code":"stream_error"');
    expect(text).toContain("upstream exploded");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const logged = app.db
      .select()
      .from(usageLogs)
      .orderBy(desc(usageLogs.id))
      .limit(1)
      .all()[0];
    expect(logged?.status).toBe(502);
    expect(logged?.errorCode).toBe("stream_error");
  });

  test("a non-streaming client sees an in-stream error as a 502", async () => {
    mock.chatHandler = () =>
      sse([
        { choices: [{ delta: { content: "partial" } }] },
        { error: { message: "upstream exploded", type: "api_error" } },
      ]);
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "break" }],
      },
    });
    expect(response.status).toBe(502);
    const body = await readJson<{ error: { code: string; message: string } }>(
      response,
    );
    expect(body.error.code).toBe("stream_error");
    expect(body.error.message).toBe("upstream exploded");
  });

  test("a spent free-tier allowance is reported as brokey capacity", async () => {
    // With no egress to rotate to, a 429 is the tenant's allowance, not the
    // client's rate limit. The provider's body must not reach the client.
    mock.chatHandler = () =>
      Response.json(
        {
          error: {
            type: "FreeUsageLimitError",
            message: "service failure: tenant tn-8c7lyrdwe1 quota exceeded",
          },
        },
        { status: 429 },
      );
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "quota" }],
      },
    });
    expect(response.status).toBe(503);
    const body = await readJson<{ error: { code: string; message: string } }>(
      response,
    );
    expect(body.error.code).toBe("free_usage_exhausted");
    expect(body.error.message).toBe(
      'No free-tier capacity left for provider "free": the upstream allowance is spent. Retry in 4800s.',
    );
    expect(body.error.message).not.toContain("tenant");
    expect(Number(response.headers.get("retry-after"))).toBe(4800);

    const logged = app.db
      .select()
      .from(usageLogs)
      .orderBy(desc(usageLogs.id))
      .limit(1)
      .all()[0];
    expect(logged?.status).toBe(503);
    expect(logged?.errorCode).toBe("free_usage_exhausted");

    // The provider's words stay available to the admin on the egress health row.
    const health = app.db
      .select()
      .from(egressHealth)
      .where(eq(egressHealth.providerId, providerId))
      .all();
    expect(health.some((row) => row.lastError?.includes("tenant"))).toBe(true);
    mock.chatHandler = () => sse(STREAM_LINES);
  });

  test("a family alias routes to the synced free model", async () => {
    mock.calls.length = 0;
    mock.chatHandler = () => sse(STREAM_LINES);
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "mimo",
        messages: [{ role: "user", content: "alias" }],
      },
    });
    expect(response.status).toBe(200);
    const sent = chatCalls()[0]?.body;
    if (!sent || typeof sent !== "object" || !("model" in sent))
      throw new Error("the alias request never reached upstream");
    expect(sent.model).toBe("mimo-v2.6-flash-free");
  });
});
