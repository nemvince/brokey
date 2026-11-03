import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { eq } from "drizzle-orm";
import { providerKeys, usageLogs } from "../src/server/schema.ts";
import {
  adminJson,
  adminRequest,
  proxyRequest,
  readJson,
  seedClientKey,
  seedModel,
  seedProvider,
  startMockUpstream,
  startTestApp,
  type MockUpstream,
  type TestApp,
} from "./helpers.ts";

type ErrorBody = { error: { message: string; code: string | null } };
type ChatBody = {
  choices: { message: { content: string } }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
};
type StatsBody = {
  totals: { requests: number; totalTokens: number };
};
type CatalogModelBody = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name: string;
  context_length?: number;
  max_output_tokens?: number;
};

describe("proxy data path", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "primary",
      baseUrl: mock.baseUrl,
      secrets: ["sk-primary-a"],
    });
    providerId = provider.providerId;

    const preview = await adminJson<{
      added: { upstreamId: string; suggestedPublicId: string }[];
    }>(app, `/api/admin/providers/${providerId}/models/fetch`, {
      method: "POST",
    });
    const addition = preview.added.find(
      (row) => row.upstreamId === "upstream-mock-chat",
    );
    expect(addition).toBeDefined();
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: {
        added: [{ upstreamId: "upstream-mock-chat", publicId: "mock-chat" }],
      },
    });

    const key = await seedClientKey(app, { name: "demo" });
    token = key.token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("chat completion is proxied with usage", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-brokey-request-id")).toMatch(/^req_/);
    const body = await readJson<ChatBody>(response);
    expect(body.choices[0]?.message.content).toBe("hello");
    expect(body.usage?.total_tokens).toBe(10);

    const stats = await readJson<StatsBody>(
      await fetch(`${app.baseUrl}/api/stats?range=24h`),
    );
    expect(stats.totals.requests).toBe(1);
    expect(stats.totals.totalTokens).toBe(10);
  });

  test("public model ID is rewritten to the upstream ID", async () => {
    await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "mock-chat",
        messages: [{ role: "user", content: "rewrite" }],
      },
    });
    const chatCalls = mock.calls.filter(
      (call) => call.path === "/v1/chat/completions",
    );
    const last = chatCalls[chatCalls.length - 1];
    expect((last?.body as { model?: string } | null)?.model).toBe(
      "upstream-mock-chat",
    );
    expect(last?.auth).toBe("Bearer sk-primary-a");
  });

  test("/v1/models requires a client key and serves the local catalog", async () => {
    const unauthorised = await fetch(`${app.baseUrl}/v1/models`);
    expect(unauthorised.status).toBe(401);

    const response = await proxyRequest(app, "/v1/models", token);
    expect(response.status).toBe(200);
    const body = await readJson<{ object: string; data: CatalogModelBody[] }>(
      response,
    );
    expect(body.object).toBe("list");
    const entry = body.data.find((row) => row.id === "mock-chat");
    expect(entry).toEqual({
      id: "mock-chat",
      object: "model",
      created: expect.any(Number),
      owned_by: "primary",
      name: "Mock Chat",
      context_length: 128000,
    });

    const single = await readJson<CatalogModelBody>(
      await proxyRequest(app, "/v1/models/mock-chat", token),
    );
    expect(single.id).toBe("mock-chat");
    expect(single.name).toBe("Mock Chat");
    expect(single.owned_by).toBe("primary");
    expect(single.context_length).toBe(128000);
  });

  test("/v1/models serves admin overrides of the synced metadata", async () => {
    const models = await adminJson<{
      models: { id: number; publicId: string }[];
    }>(app, "/api/admin/models");
    const modelId = models.models.find(
      (row) => row.publicId === "mock-chat",
    )?.id;
    expect(modelId).toBeDefined();

    const patch = (body: Record<string, unknown>) =>
      adminJson(app, `/api/admin/models/${modelId}`, { method: "PATCH", body });

    await patch({ contextWindow: 64000, maxOutputTokens: 4096 });
    const overridden = await readJson<CatalogModelBody>(
      await proxyRequest(app, "/v1/models/mock-chat", token),
    );
    expect(overridden.context_length).toBe(64000);
    expect(overridden.max_output_tokens).toBe(4096);

    await patch({ contextWindow: 128000, maxOutputTokens: null });
    const restored = await readJson<CatalogModelBody>(
      await proxyRequest(app, "/v1/models/mock-chat", token),
    );
    expect(restored.context_length).toBe(128000);
    expect(restored).not.toHaveProperty("max_output_tokens");
  });

  test("streaming forwards content, hides the injected usage chunk and logs tokens", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "mock-chat",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();

    expect(text).toContain("hel");
    expect(text).toContain("lo");
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"usage"');

    const upstreamBody = mock.calls
      .filter((call) => call.path === "/v1/chat/completions")
      .map(
        (call) =>
          call.body as { stream_options?: { include_usage?: boolean } } | null,
      )
      .filter((body) => body?.stream_options !== undefined)
      .pop();
    expect(upstreamBody?.stream_options?.include_usage).toBe(true);

    const usage = await readJson<{
      rows: { streamed: boolean; totalTokens: number }[];
    }>(await adminRequest(app, "/api/admin/usage?pageSize=1"));
    expect(usage.rows[0]?.streamed).toBe(true);
    expect(usage.rows[0]?.totalTokens).toBe(10);
  });

  test("client usage limit headers are returned", async () => {
    const limited = await seedClientKey(app, {
      name: "limited",
      limitWindow: "day",
      limitRequests: 5,
      limitTokens: 1000,
    });
    const response = await proxyRequest(
      app,
      "/v1/chat/completions",
      limited.token,
      {
        body: {
          model: "mock-chat",
          messages: [{ role: "user", content: "abc" }],
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-brokey-requests-remaining")).toBe("4");
    expect(
      Number(response.headers.get("x-brokey-tokens-remaining")),
    ).toBeLessThan(1000);
  });
});

describe("provider key failover", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "failover",
      baseUrl: mock.baseUrl,
      secrets: ["sk-bad-a", "sk-good-b"],
    });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "failover-key" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("a rate-limited key is cooled down and the next key serves the request", async () => {
    mock.chatHandler = (call) =>
      call.auth === "Bearer sk-bad-a"
        ? Response.json(
            { error: { message: "rate limited", code: "rate_limited" } },
            { status: 429, headers: { "retry-after": "120" } },
          )
        : undefined;

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.status).toBe(200);
    expect(
      (await readJson<ChatBody>(response)).choices[0]?.message.content,
    ).toBe("hello");

    const detail = await adminJson<{
      keys: {
        label: string;
        status: string;
        cooldownUntil: number | null;
        lastError: string | null;
      }[];
    }>(app, `/api/admin/providers/${providerId}`);
    const bad = detail.keys.find((key) => key.label === "key-1");
    const good = detail.keys.find((key) => key.label === "key-2");
    expect(bad?.status).toBe("cooling");
    expect(bad?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(bad?.lastError).toContain("429");
    expect(good?.status).toBe("active");

    const providers = await adminJson<{
      providers: { keyStatusCounts: { cooling: number } }[];
    }>(app, "/api/admin/providers");
    expect(providers.providers[0]?.keyStatusCounts.cooling).toBe(1);
  });
});

/** The body a provider actually sent when this was reported. */
const TENANT_QUOTA = "service failure: tenant tn-8c7lyrdwe1 quota exceeded";

describe("all provider keys exhausted", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    mock.chatHandler = () =>
      Response.json(
        { error: { message: TENANT_QUOTA } },
        { status: 429, headers: { "retry-after": "45" } },
      );
    const provider = await seedProvider(app, {
      name: "exhausted",
      baseUrl: mock.baseUrl,
      secrets: ["sk-exhausted-a"],
    });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "exhausted-key" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("the provider's quota text never reaches the client", async () => {
    const first = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(first.status).toBe(503);
    const firstBody = await readJson<ErrorBody>(first);
    expect(firstBody.error.code).toBe("all_keys_exhausted");
    // The provider's words are not passed on, in status or in text.
    expect(firstBody.error.message).not.toContain("tenant");
    expect(firstBody.error.message).toContain(
      'No usable API keys left for provider "exhausted"',
    );
    expect(firstBody.error.message).toContain("rejected (quota exhausted)");
    expect(Number(first.headers.get("retry-after"))).toBeGreaterThan(0);

    // The same key is now cooling, so the next request never reaches upstream.
    const second = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(second.status).toBe(503);
    const body = await readJson<ErrorBody>(second);
    expect(body.error.code).toBe("all_keys_exhausted");
    expect(body.error.message).toContain(
      "cooling down after upstream failures",
    );
    const retryAfter = Number(second.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  test("the rejected key keeps the provider's text for the admin", async () => {
    const providers = await adminJson<{
      providers: { id: number }[];
    }>(app, "/api/admin/providers");
    const detail = await adminJson<{ keys: { lastError: string | null }[] }>(
      app,
      `/api/admin/providers/${providers.providers[0]?.id}`,
    );
    expect(detail.keys[0]?.lastError).toContain(TENANT_QUOTA);
  });

  test("a tenant quota error on a non-429 status fails over", async () => {
    // The reported case: the provider reports a spent tenant quota with 403 and
    // a body no classifier would call a rate limit. The next key must serve it.
    const provider = await seedProvider(app, {
      name: "tenant",
      baseUrl: mock.baseUrl,
      secrets: ["sk-tenant-a", "sk-tenant-b"],
    });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "tenant-model",
    });
    let attempt = 0;
    mock.chatHandler = () => {
      attempt += 1;
      if (attempt === 1)
        return Response.json(
          { error: { message: TENANT_QUOTA } },
          { status: 403 },
        );
      return Response.json({
        choices: [{ message: { role: "assistant", content: "served" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "tenant-model", messages: [] },
    });
    expect(response.status).toBe(200);
    const body = await readJson<ChatBody>(response);
    expect(body.choices[0]?.message.content).toBe("served");
    expect(attempt).toBe(2);
  });
});

describe("routing errors", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;
  let providerId: number;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "routing",
      baseUrl: mock.baseUrl,
      secrets: ["sk-routing"],
    });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    await seedModel(app, providerId, {
      upstreamId: "gpt-x",
      publicId: "disabled-model",
      enabled: false,
    });
    token = (await seedClientKey(app, { name: "routing-key" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("unknown model returns 404 model_not_found without contacting the upstream", async () => {
    const before = mock.calls.length;
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "nope", messages: [] },
    });
    expect(response.status).toBe(404);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toBe(
      "The model 'nope' does not exist or you do not have access to it.",
    );
    expect(mock.calls.length).toBe(before);

    const disabled = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "disabled-model", messages: [] },
    });
    expect(disabled.status).toBe(404);
  });

  test("a disabled provider returns 503", async () => {
    await adminJson(app, `/api/admin/providers/${providerId}`, {
      method: "PATCH",
      body: { enabled: false },
    });
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(response.status).toBe(503);
    expect((await readJson<ErrorBody>(response)).error.code).toBe(
      "provider_unavailable",
    );

    const catalog = await proxyRequest(app, "/v1/models", token);
    const body = await readJson<{ data: { id: string }[] }>(catalog);
    expect(body.data.map((row) => row.id)).not.toContain("mock-chat");

    await adminJson(app, `/api/admin/providers/${providerId}`, {
      method: "PATCH",
      body: { enabled: true },
    });
  });

  test("non-JSON bodies forward unchanged and need an explicit provider", async () => {
    const response = await fetch(`${app.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-brokey-provider": "routing",
        "content-type": "multipart/form-data; boundary=xyz",
      },
      body: "--xyz--\r\n",
    });
    // Mock upstream answers 404 for unknown paths; the proxy forwards it verbatim.
    expect(response.status).toBe(404);
    const last = mock.calls[mock.calls.length - 1];
    expect(last?.path).toBe("/v1/audio/transcriptions");
  });

  test("a provider without enabled keys returns 503 provider_unavailable", async () => {
    const detail = await adminJson<{ keys: { id: number }[] }>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    for (const key of detail.keys) {
      await adminJson(app, `/api/admin/provider-keys/${key.id}`, {
        method: "PATCH",
        body: { enabled: false },
      });
    }
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(response.status).toBe(503);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.message).toBe(
      'No API keys are configured for provider "routing".',
    );
  });

  test("invalid JSON for a strict endpoint returns 400 without an upstream call", async () => {
    const before = mock.calls.length;
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      raw: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toContain(
      "parse the JSON body",
    );
    expect(mock.calls.length).toBe(before);
  });
});

describe("streaming fallback when the upstream rejects stream_options", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "strict",
      baseUrl: mock.baseUrl,
      secrets: ["sk-strict"],
    });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "strict-key" })).token;

    mock.chatHandler = (call) => {
      const body = call.body as {
        stream_options?: unknown;
        stream?: boolean;
      } | null;
      if (body?.stream_options !== undefined) {
        return Response.json(
          { error: { message: "stream_options is not supported" } },
          { status: 400 },
        );
      }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ];
      return new Response(frames.join("\n"), {
        headers: { "content-type": "text/event-stream" },
      });
    };
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("retries once without the injected option and records estimated tokens", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "mock-chat",
        stream: true,
        messages: [{ role: "user", content: "hi there" }],
      },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("hel");
    expect(text).toContain("lo");

    const streamCalls = mock.calls.filter(
      (call) => call.path === "/v1/chat/completions",
    );
    expect(streamCalls.length).toBe(2);
    expect(
      (streamCalls[0]?.body as { stream_options?: unknown } | null)
        ?.stream_options,
    ).toBeDefined();
    expect(
      (streamCalls[1]?.body as { stream_options?: unknown } | null)
        ?.stream_options,
    ).toBeUndefined();

    const usage = await readJson<{
      rows: {
        estimated: boolean;
        promptTokens: number;
        completionTokens: number;
        status: number;
      }[];
    }>(await adminRequest(app, "/api/admin/usage?pageSize=1"));
    const row = usage.rows[0];
    expect(row?.status).toBe(200);
    expect(row?.estimated).toBe(true);
    expect(row?.promptTokens).toBeGreaterThan(0);
    expect(row?.completionTokens).toBeGreaterThan(0);
  });
});

describe("upstream stream failure after headers", () => {
  let app: TestApp;
  let token: string;
  let keyId: number;
  let server: Server;

  beforeAll(async () => {
    app = startTestApp();
    // A raw TCP upstream: a Response body cannot die once fetch() has its
    // headers, so the reset has to come from the socket. Headers plus one
    // tool-call frame, then the connection is destroyed — exactly the shape
    // inferx produced, and the only shape Bun reports as ECONNRESET.
    server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (!buffered.includes("\r\n\r\n")) return;
        const frame = `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] } }],
        })}\n\n`;
        socket.write(
          "HTTP/1.1 200 OK\r\n" +
            "content-type: text/event-stream\r\n" +
            "transfer-encoding: chunked\r\n\r\n" +
            `${frame.length.toString(16)}\r\n${frame}\r\n`,
        );
        // No terminating zero-length chunk: the connection dies outright.
        socket.resetAndDestroy();
      });
      socket.on("error", () => {});
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    const provider = await seedProvider(app, {
      name: "flaky",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      secrets: ["sk-flaky"],
    });
    keyId = provider.keyIds[0] as number;
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "flaky-chat",
    });
    token = (await seedClientKey(app, { name: "flaky-key" })).token;
  });

  afterAll(() => {
    app.stop();
    server.close();
  });

  test("reports the failure in-band instead of resetting the client", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "flaky-chat",
        stream: true,
        messages: [{ role: "user", content: "use a tool" }],
      },
    });
    expect(response.status).toBe(200);

    // The body must read to completion: the client gets the proxy's in-band
    // error event, never a transport-level ECONNRESET from a reset socket.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(
        `client body read threw: ${(error as Error).name} ${(error as Error).message}`,
      );
    }
    expect(text).toContain('"code":"stream_error"');
    // The upstream message is relayed so the failure is diagnosable.
    expect(text).toContain("socket connection was closed unexpectedly");
    // Whether the first frame reached the client before the reset, the body
    // still ends with the proxy's error event rather than a broken chunk.
    expect(text.startsWith("data: ")).toBe(true);

    const requestId = response.headers.get("x-brokey-request-id");
    const row = app.db
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.requestId, requestId ?? ""))
      .get();
    expect(row?.status).toBe(502);
    expect(row?.errorCode).toBe("stream_error");
    expect(row?.streamed).toBe(true);

    const key = app.db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.id, keyId))
      .get();
    expect(key?.lastError).toContain(
      "socket connection was closed unexpectedly",
    );
    expect(key?.cooldownUntil ?? 0).toBeGreaterThan(Date.now());
  });
});

describe("client abandons a stream mid-way", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;
  let providerId: number;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "abandon",
      baseUrl: mock.baseUrl,
      secrets: ["sk-abandon"],
    });
    providerId = provider.providerId;
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "abandon-chat",
    });
    token = (await seedClientKey(app, { name: "abandon-key" })).token;

    // Slow downstream frames so the client can hang up while the upstream
    // stream is still running: the shape every tool-calling agent produces.
    mock.chatHandler = () => {
      const frames = [
        `data: ${JSON.stringify({
          choices: [{ delta: { role: "assistant", content: "checking" } }],
        })}`,
        "",
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":"Oslo"}',
                    },
                  },
                ],
              },
            },
          ],
        })}`,
        "",
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ];
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
              controller.enqueue(encoder.encode(frame + "\n"));
              await Bun.sleep(30);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("abandoning after the tool call is logged as a success, not 499", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "abandon-chat",
        stream: true,
        messages: [{ role: "user", content: "weather in Oslo?" }],
      },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let abandoned = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('"finish_reason":"tool_calls"')) {
        await reader.cancel();
        abandoned = true;
        break;
      }
    }
    expect(abandoned).toBe(true);
    // The data the agent needed was delivered before the hang-up.
    expect(text).toContain('"name":"get_weather"');

    const requestId = response.headers.get("x-brokey-request-id");
    let row: typeof usageLogs.$inferSelect | undefined;
    for (let waited = 0; !row && waited < 1500; waited += 25) {
      await Bun.sleep(25);
      row = app.db
        .select()
        .from(usageLogs)
        .where(eq(usageLogs.requestId, requestId ?? ""))
        .get();
    }
    expect(row?.status).toBe(200);
    expect(row?.errorCode).toBeNull();
    expect(row?.streamed).toBe(true);
    expect(row?.estimated).toBe(true);
    // Arguments of the abandoned tool call count towards the estimate.
    expect(row?.completionTokens).toBeGreaterThan(0);

    // No failure surfaced to the client and the key stayed healthy.
    expect(text).not.toContain("stream_error");
    const key = await adminJson<{ keys: { lastError: string | null }[] }>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    expect(key.keys[0]?.lastError).toBeNull();
  });
});
