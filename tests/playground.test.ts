import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { clientKeys, usageLogs } from "../src/server/schema.ts";
import type {
  PlaygroundModelDTO,
  PlaygroundResult,
} from "../src/shared/types.ts";
import {
  ADMIN_TOKEN,
  adminJson,
  adminRequest,
  insertUsageLog,
  readJson,
  seedClientKey,
  seedModel,
  seedOpenCodeProvider,
  seedProvider,
  startMockUpstream,
  startTestApp,
  type MockUpstream,
  type TestApp,
} from "./helpers.ts";

const CATALOG = {
  opencode: {
    api: "https://opencode.ai/inference/openai/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "free-model": {
        name: "Free Model",
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 32_000 },
      },
    },
  },
};

type StreamEvent = {
  delta?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

/** Parses the playground's own SSE events into one array. */
function parseEvents(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    events.push(JSON.parse(payload) as StreamEvent);
  }
  return events;
}

function playgroundRequest(
  app: TestApp,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${app.baseUrl}/api/admin/playground/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

describe("admin playground", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let clientKeyId: number;

  beforeAll(async () => {
    mock = startMockUpstream();
    mock.anyHandler = (call) =>
      call.path.endsWith("/catalog.json") ? Response.json(CATALOG) : undefined;
    app = startTestApp({
      opencode: {
        userAgent: "opencode/latest/2.2.5/cli",
        chatUrl: mock.baseUrl,
        catalogUrl: `${mock.baseUrl}/catalog.json`,
      },
    });
    const provider = await seedProvider(app, {
      name: "primary",
      baseUrl: mock.baseUrl,
      secrets: ["sk-primary-a"],
    });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
      displayName: "Mock Chat",
    });
    await seedModel(app, providerId, {
      upstreamId: "disabled-model",
      publicId: "disabled-chat",
      enabled: false,
    });
    // A real key with a hard request cap: a playground run must never consume
    // it, and its usage must stay at zero.
    const capped = await seedClientKey(app, {
      name: "capped",
      limitWindow: "total",
      limitRequests: 1,
    });
    clientKeyId = capped.id;

    const free = await seedOpenCodeProvider(app, { name: "free" });
    await seedModel(app, free.providerId, {
      upstreamId: "free-model",
      publicId: "free-model",
      displayName: "Free Model",
    });
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("lists only models enabled end to end", async () => {
    const body = await adminJson<{ models: PlaygroundModelDTO[] }>(
      app,
      "/api/admin/playground/models",
    );
    const ids = body.models.map((row) => row.publicId).sort();
    expect(ids).toEqual(["free-model", "mock-chat"]);
    const chat = body.models.find((row) => row.publicId === "mock-chat");
    expect(chat).toEqual({
      publicId: "mock-chat",
      providerName: "primary",
      displayName: "Mock Chat",
      contextWindow: null,
      maxOutputTokens: null,
      providerKind: "openai",
    });
    const free = body.models.find((row) => row.publicId === "free-model");
    expect(free?.providerKind).toBe("opencode");
  });

  test("requires the admin token", async () => {
    const response = await fetch(`${app.baseUrl}/api/admin/playground/models`);
    expect(response.status).toBe(401);
    const run = await fetch(`${app.baseUrl}/api/admin/playground/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-chat" }),
    });
    expect(run.status).toBe(401);
  });

  test("streams a key-pool completion through the proxy", async () => {
    const before = mock.calls.length;
    const response = await playgroundRequest(app, {
      model: "mock-chat",
      systemPrompt: "be brief",
      temperature: 0.2,
      maxTokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-brokey-request-id")).toMatch(/^req_/);

    const events = parseEvents(await response.text());
    const text = events.map((event) => event.delta ?? "").join("");
    expect(text).toBe("hello");
    expect(events.at(-1)?.usage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });

    // The proxy rewrote the model, used a real key, and carried the system
    // prompt and sampling fields the page sent.
    const call = mock.calls
      .slice(before)
      .find((entry) => entry.path === "/v1/chat/completions");
    expect(call?.auth).toBe("Bearer sk-primary-a");
    const sent = call?.body as {
      model?: string;
      temperature?: number;
      max_completion_tokens?: number;
      messages?: { role: string; content: string }[];
    };
    expect(sent.model).toBe("upstream-mock-chat");
    expect(sent.temperature).toBe(0.2);
    expect(sent.max_completion_tokens).toBe(64);
    expect(sent.messages?.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(sent.messages?.[0]?.content).toBe("be brief");
  });

  test("a run is logged without touching a client key", async () => {
    const key = app.db
      .select()
      .from(clientKeys)
      .where(eq(clientKeys.id, clientKeyId))
      .get();
    expect(key?.lastUsedAt).toBeNull();

    const rows = app.db
      .select()
      .from(usageLogs)
      .orderBy(desc(usageLogs.id))
      .limit(3)
      .all();
    const latest = rows[0];
    expect(latest?.status).toBe(200);
    expect(latest?.modelPublicId).toBe("mock-chat");
    expect(latest?.clientKeyId).toBeNull();
    expect(latest?.providerName).toBe("primary");

    // The per-run key row is gone, so only real keys remain.
    const names = app.db
      .select()
      .from(clientKeys)
      .all()
      .map((row) => row.name);
    expect(names).not.toContain("playground");
  });

  test("buffered delivery returns one JSON result", async () => {
    const response = await playgroundRequest(app, {
      model: "mock-chat",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = await readJson<PlaygroundResult>(response);
    expect(result).toEqual({
      status: 200,
      content: "hello",
      error: null,
      streamed: false,
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      requestId: expect.stringMatching(/^req_/),
      latencyMs: expect.any(Number),
    });
  });

  test("an upstream failure becomes a readable error result", async () => {
    // Its own provider: a 500 cools the key down, which would fail every later
    // run that shares one.
    const faulty = await seedProvider(app, {
      name: "faulty",
      baseUrl: mock.baseUrl,
      secrets: ["sk-faulty"],
    });
    await seedModel(app, faulty.providerId, {
      upstreamId: "faulty-up",
      publicId: "faulty-model",
    });
    mock.chatHandler = () =>
      Response.json(
        {
          error: {
            message: "model is overloaded",
            type: "api_error",
            code: "overloaded",
          },
        },
        { status: 500 },
      );
    try {
      const response = await playgroundRequest(app, {
        model: "faulty-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const result = await readJson<PlaygroundResult>(response);
      expect(result.status).toBe(500);
      expect(result.error).toBe("model is overloaded");
      expect(result.content).toBe("");
    } finally {
      mock.chatHandler = null;
    }
  });

  test("no usable provider key is reported, not thrown", async () => {
    const empty = await seedProvider(app, {
      name: "keyless",
      baseUrl: mock.baseUrl,
      secrets: [],
    });
    await seedModel(app, empty.providerId, {
      upstreamId: "keyless-up",
      publicId: "keyless-model",
    });
    mock.anyHandler = (call) => {
      if (call.path.endsWith("/catalog.json")) return Response.json(CATALOG);
      return undefined;
    };

    const response = await playgroundRequest(app, {
      model: "keyless-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = await readJson<PlaygroundResult>(response);
    expect(result.status).toBe(503);
    expect(result.error).toContain(
      'No API keys are configured for provider "keyless"',
    );
  });

  test("validates the request body", async () => {
    const missing = await adminRequest(app, "/api/admin/playground/run", {
      body: { model: "mock-chat", messages: [] },
    });
    expect(missing.status).toBe(400);

    const noUser = await adminRequest(app, "/api/admin/playground/run", {
      body: {
        model: "mock-chat",
        messages: [{ role: "system", content: "only a system prompt" }],
      },
    });
    expect(noUser.status).toBe(400);

    const badRole = await adminRequest(app, "/api/admin/playground/run", {
      body: {
        model: "mock-chat",
        messages: [{ role: "tool", content: "x" }],
      },
    });
    expect(badRole.status).toBe(400);

    const noModel = await adminRequest(app, "/api/admin/playground/run", {
      body: {
        model: "ghost-model",
        messages: [{ role: "user", content: "x" }],
      },
    });
    expect(noModel.status).toBe(400);
    const body = await readJson<{ error: { message: string } }>(noModel);
    expect(body.error.message).toContain('Unknown model "ghost-model"');

    const disabled = await adminRequest(app, "/api/admin/playground/run", {
      body: {
        model: "disabled-chat",
        messages: [{ role: "user", content: "x" }],
      },
    });
    expect(disabled.status).toBe(400);

    const badTemperature = await adminRequest(
      app,
      "/api/admin/playground/run",
      {
        body: {
          model: "mock-chat",
          temperature: 5,
          messages: [{ role: "user", content: "x" }],
        },
      },
    );
    expect(badTemperature.status).toBe(400);
  });

  test("accepts an OpenAI-style content array", async () => {
    const before = mock.calls.length;
    const response = await playgroundRequest(app, {
      model: "mock-chat",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
          ],
        },
      ],
    });
    const result = await readJson<PlaygroundResult>(response);
    expect(result.error).toBeNull();
    const sent = mock.calls
      .slice(before)
      .find((entry) => entry.path === "/v1/chat/completions")?.body as
      { messages?: { content: unknown }[] } | undefined;
    expect(sent?.messages?.[0]?.content).toBe("part one part two");
  });

  test("the OpenCode free lane runs through the alias resolver", async () => {
    const before = mock.calls.length;
    const response = await playgroundRequest(app, {
      model: "free-model",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const result = await readJson<PlaygroundResult>(response);
    expect(result.error).toBeNull();
    expect(result.content).toBe("hello");

    const call = mock.calls
      .slice(before)
      .find((entry) => entry.path.endsWith("/chat/completions"));
    expect((call?.body as { model?: string } | null)?.model).toBe("free-model");

    const row = app.db
      .select()
      .from(usageLogs)
      .orderBy(desc(usageLogs.id))
      .limit(1)
      .get();
    expect(row?.providerName).toBe("free");
    expect(row?.clientKeyId).toBeNull();
    expect(row?.providerKeyId).toBeNull();
  });

  test("a pre-existing client key's history is unaffected", async () => {
    insertUsageLog(app, { clientKeyId, clientKeyLabel: "capped" });
    const usage = await adminJson<{ rows: { clientKeyLabel: string }[] }>(
      app,
      `/api/admin/usage?clientKeyId=${clientKeyId}`,
    );
    expect(usage.rows.every((row) => row.clientKeyLabel === "capped")).toBe(
      true,
    );
  });
});
