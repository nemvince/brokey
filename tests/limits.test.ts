import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { estimateChatPromptTokens, estimateTokens } from "../src/server/proxy/usage.ts";
import { parseRetryAfter } from "../src/server/proxy/keys.ts";
import { windowStart } from "../src/server/proxy/limits.ts";
import { SseSplitter, parseEventJson } from "../src/server/proxy/streaming.ts";
import {
  adminJson,
  insertUsageLog,
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

type ClientKeyRow = {
  id: number;
  limitWindow: string;
  usage: { requests: number; tokens: number; windowStart: number | null };
};
type ErrorBody = { error: { message: string; code: string | null; type: string } };

const encoder = new TextEncoder();

describe("pure helpers", () => {
  test("parseRetryAfter handles seconds, dates and durations", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("5000", now)).toBe(3600);
    expect(parseRetryAfter("0", now)).toBe(1);
    expect(parseRetryAfter("1.5s", now)).toBe(2);
    expect(parseRetryAfter("2m", now)).toBe(120);
    expect(parseRetryAfter("1h", now)).toBe(3600);
    expect(parseRetryAfter("500ms", now)).toBe(1);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now)).toBe(1);
    expect(parseRetryAfter(String(new Date(now + 90_000).toUTCString()), now)).toBe(90);
    expect(parseRetryAfter(null, now)).toBe(60);
    expect(parseRetryAfter("nonsense", now)).toBe(60);
  });

  test("estimateTokens and estimateChatPromptTokens", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(
      estimateChatPromptTokens([
        { role: "user", content: "12345678" },
        { role: "assistant", content: [{ type: "text", text: "1234" }] },
      ]),
    ).toBe(3 + 8);
    expect(estimateChatPromptTokens(null)).toBe(0);
  });

  test("windowStart buckets by UTC day and month", () => {
    const now = Date.UTC(2026, 4, 17, 13, 45, 12);
    expect(windowStart("total", now)).toBeNull();
    expect(windowStart("day", now)).toBe(Date.UTC(2026, 4, 17));
    expect(windowStart("month", now)).toBe(Date.UTC(2026, 4, 1));
  });

  test("SSE splitter keeps frames and separators across chunk boundaries", () => {
    const splitter = new SseSplitter();
    const frames = [
      ...splitter.push(encoder.encode("data: {\"a\":")),
      ...splitter.push(encoder.encode("1}\n\ndata: [DONE]\n\n")),
    ];
    expect(frames.length).toBe(2);
    expect(frames[0]?.raw).toBe('data: {"a":1}');
    expect(frames[0]?.separator).toBe("\n\n");
    expect(parseEventJson(frames[0]!.raw)).toEqual({ a: 1 });
    expect(frames[1]?.raw).toBe("data: [DONE]");
    expect(parseEventJson(frames[1]!.raw)).toBeNull();

    const trailing = splitter.push(encoder.encode("data: {\"tail\":true}"));
    expect(trailing.length).toBe(0);
    const flushed = splitter.flush();
    expect(flushed.length).toBe(1);
    expect(parseEventJson(flushed[0]!.raw)).toEqual({ tail: true });
  });
});

describe("client key limits", () => {
  let app: TestApp;
  let mock: MockUpstream;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, { name: "limits", baseUrl: mock.baseUrl });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("the request cap rejects the next request with usage_limit_exceeded", async () => {
    const key = await seedClientKey(app, {
      name: "requests-cap",
      limitWindow: "day",
      limitRequests: 1,
    });
    const first = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(first.status).toBe(200);

    const second = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(second.status).toBe(429);
    const body = await readJson<ErrorBody>(second);
    expect(body.error.code).toBe("usage_limit_exceeded");
    expect(body.error.type).toBe("insufficient_quota");
    expect(body.error.message).toBe("API key usage limit exceeded (requests) for this day window.");
  });

  test("upstream error responses still consume the request cap", async () => {
    mock.chatHandler = () => Response.json({ error: { message: "bad request" } }, { status: 400 });
    const key = await seedClientKey(app, {
      name: "error-cap",
      limitWindow: "total",
      limitRequests: 1,
    });
    const first = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(first.status).toBe(400);
    const second = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(second.status).toBe(429);
    mock.chatHandler = null;
  });

  test("the token cap rejects once the window is spent and remaining headers decrease", async () => {
    const key = await seedClientKey(app, {
      name: "token-cap",
      limitWindow: "total",
      limitTokens: 20,
    });
    const first = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(first.status).toBe(200);
    const firstRemaining = Number(first.headers.get("x-brokey-tokens-remaining"));
    expect(firstRemaining).toBe(20);

    const second = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(second.status).toBe(200);
    const secondRemaining = Number(second.headers.get("x-brokey-tokens-remaining"));
    expect(secondRemaining).toBe(10);

    const third = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(third.status).toBe(429);
    expect((await readJson<ErrorBody>(third)).error.message).toBe(
      "API key usage limit exceeded (tokens) for this total window.",
    );
  });

  test("remaining token headers clamp at zero", async () => {
    const key = await seedClientKey(app, {
      name: "clamp",
      limitWindow: "total",
      limitTokens: 100,
    });
    insertUsageLog(app, { clientKeyId: key.id, totalTokens: 99, createdAt: Date.now() });
    const response = await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: {
        model: "mock-chat",
        messages: [{ role: "user", content: "x".repeat(200) }],
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-brokey-tokens-remaining")).toBe("0");
  });

  test("day windows ignore logs from before UTC midnight, total windows do not", async () => {
    const dayKey = await seedClientKey(app, { name: "day-window", limitWindow: "day" });
    const totalKey = await seedClientKey(app, { name: "total-window", limitWindow: "total" });

    const now = Date.now();
    const dayStart = windowStart("day", now) as number;
    const yesterday = dayStart - 60_000;
    insertUsageLog(app, { clientKeyId: dayKey.id, totalTokens: 100, createdAt: yesterday });
    insertUsageLog(app, { clientKeyId: dayKey.id, totalTokens: 5, createdAt: now });
    insertUsageLog(app, { clientKeyId: totalKey.id, totalTokens: 100, createdAt: yesterday });
    insertUsageLog(app, { clientKeyId: totalKey.id, totalTokens: 5, createdAt: now });

    const list = await adminJson<{ clientKeys: ClientKeyRow[] }>(app, "/api/admin/client-keys");
    const day = list.clientKeys.find((row) => row.id === dayKey.id);
    const total = list.clientKeys.find((row) => row.id === totalKey.id);
    expect(day?.usage.requests).toBe(1);
    expect(day?.usage.tokens).toBe(5);
    expect(day?.usage.windowStart).toBe(dayStart);
    expect(total?.usage.requests).toBe(2);
    expect(total?.usage.tokens).toBe(105);
    expect(total?.usage.windowStart).toBeNull();
  });

  test("rejected requests are not logged", async () => {
    const key = await seedClientKey(app, {
      name: "unlogged",
      limitWindow: "total",
      limitRequests: 1,
    });
    await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    const before = await adminJson<{ total: number }>(
      app,
      `/api/admin/usage?clientKeyId=${key.id}`,
    );
    await proxyRequest(app, "/v1/chat/completions", key.token, {
      body: { model: "mock-chat", messages: [] },
    });
    const after = await adminJson<{ total: number }>(app, `/api/admin/usage?clientKeyId=${key.id}`);
    expect(after.total).toBe(before.total);
    expect(before.total).toBe(1);
  });
});
