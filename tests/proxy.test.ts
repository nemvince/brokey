import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model?: string;
};
type StatsBody = {
  totals: { requests: number; totalTokens: number };
  recent: { requestId: string; status: number; streamed: boolean }[];
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

    const preview = await adminJson<{ added: { upstreamId: string; suggestedPublicId: string }[] }>(
      app,
      `/api/admin/providers/${providerId}/models/fetch`,
      { method: "POST" },
    );
    const addition = preview.added.find((row) => row.upstreamId === "upstream-mock-chat");
    expect(addition).toBeDefined();
    await adminJson(app, `/api/admin/providers/${providerId}/models/apply`, {
      body: { added: [{ upstreamId: "upstream-mock-chat", publicId: "mock-chat" }] },
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

    const stats = await readJson<StatsBody>(await fetch(`${app.baseUrl}/api/stats?range=24h`));
    expect(stats.totals.requests).toBe(1);
    expect(stats.totals.totalTokens).toBe(10);
    expect(stats.recent[0]?.status).toBe(200);
  });

  test("public model ID is rewritten to the upstream ID", async () => {
    await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "rewrite" }] },
    });
    const chatCalls = mock.calls.filter((call) => call.path === "/v1/chat/completions");
    const last = chatCalls[chatCalls.length - 1];
    expect((last?.body as { model?: string } | null)?.model).toBe("upstream-mock-chat");
    expect(last?.auth).toBe("Bearer sk-primary-a");
  });

  test("/v1/models requires a client key and serves the local catalog", async () => {
    const unauthorised = await fetch(`${app.baseUrl}/v1/models`);
    expect(unauthorised.status).toBe(401);

    const response = await proxyRequest(app, "/v1/models", token);
    expect(response.status).toBe(200);
    const body = await readJson<{ object: string; data: { id: string; owned_by: string }[] }>(response);
    expect(body.object).toBe("list");
    expect(body.data.map((row) => row.id)).toContain("mock-chat");
    expect(body.data[0]?.owned_by).toBe("primary");

    const single = await proxyRequest(app, "/v1/models/mock-chat", token);
    expect(single.status).toBe(200);
    expect((await readJson<{ id: string }>(single)).id).toBe("mock-chat");
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
      .map((call) => call.body as { stream_options?: { include_usage?: boolean } } | null)
      .filter((body) => body?.stream_options !== undefined)
      .pop();
    expect(upstreamBody?.stream_options?.include_usage).toBe(true);

    const usage = await readJson<{ rows: { streamed: boolean; totalTokens: number }[] }>(
      await adminRequest(app, "/api/admin/usage?pageSize=1"),
    );
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
    const response = await proxyRequest(app, "/v1/chat/completions", limited.token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "abc" }] },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-brokey-requests-remaining")).toBe("4");
    expect(Number(response.headers.get("x-brokey-tokens-remaining"))).toBeLessThan(1000);
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
    await seedModel(app, providerId, { upstreamId: "upstream-mock-chat", publicId: "mock-chat" });
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
    expect((await readJson<ChatBody>(response)).choices[0]?.message.content).toBe("hello");

    const detail = await adminJson<{
      keys: { label: string; status: string; cooldownUntil: number | null; lastError: string | null }[];
    }>(app, `/api/admin/providers/${providerId}`);
    const bad = detail.keys.find((key) => key.label === "key-1");
    const good = detail.keys.find((key) => key.label === "key-2");
    expect(bad?.status).toBe("cooling");
    expect(bad?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(bad?.lastError).toContain("429");
    expect(good?.status).toBe("active");

    const providers = await adminJson<{ providers: { keyStatusCounts: { cooling: number } }[] }>(
      app,
      "/api/admin/providers",
    );
    expect(providers.providers[0]?.keyStatusCounts.cooling).toBe(1);
  });
});

describe("all provider keys exhausted", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    mock.chatHandler = () =>
      Response.json({ error: { message: "quota gone" } }, { status: 429, headers: { "retry-after": "45" } });
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

  test("the upstream 429 is forwarded, then 429 all_keys_exhausted", async () => {
    const first = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(first.status).toBe(429);
    expect((await readJson<ErrorBody>(first)).error.message).toContain("quota gone");

    const second = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(second.status).toBe(429);
    const body = await readJson<ErrorBody>(second);
    expect(body.error.code).toBe("all_keys_exhausted");
    expect(body.error.message).toBe("All API keys for this provider are temporarily unavailable.");
    const retryAfter = Number(second.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(45);
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
    await seedModel(app, providerId, { upstreamId: "upstream-mock-chat", publicId: "mock-chat" });
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
    expect((await readJson<ErrorBody>(response)).error.code).toBe("provider_unavailable");

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
    expect(body.error.message).toBe('No enabled API keys for provider "routing".');
  });

  test("invalid JSON for a strict endpoint returns 400 without an upstream call", async () => {
    const before = mock.calls.length;
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      raw: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toContain("parse the JSON body");
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
      const body = call.body as { stream_options?: unknown; stream?: boolean } | null;
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
      body: { model: "mock-chat", stream: true, messages: [{ role: "user", content: "hi there" }] },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("hel");
    expect(text).toContain("lo");

    const streamCalls = mock.calls.filter((call) => call.path === "/v1/chat/completions");
    expect(streamCalls.length).toBe(2);
    expect((streamCalls[0]?.body as { stream_options?: unknown } | null)?.stream_options).toBeDefined();
    expect((streamCalls[1]?.body as { stream_options?: unknown } | null)?.stream_options).toBeUndefined();

    const usage = await readJson<{
      rows: { estimated: boolean; promptTokens: number; completionTokens: number; status: number }[];
    }>(await adminRequest(app, "/api/admin/usage?pageSize=1"));
    const row = usage.rows[0];
    expect(row?.status).toBe(200);
    expect(row?.estimated).toBe(true);
    expect(row?.promptTokens).toBeGreaterThan(0);
    expect(row?.completionTokens).toBeGreaterThan(0);
  });
});
