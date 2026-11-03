import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { providers } from "../src/server/schema.ts";
import type { ProviderDetailDTO, StatsResponse } from "../src/shared/types.ts";
import {
  adminJson,
  adminRequest,
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

const SECRET = "sk-live-PROVIDER-SECRET-7f3a9c";

describe("credential handling", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "leaky",
      baseUrl: mock.baseUrl,
      secrets: [SECRET],
    });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "cred-client" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("an upstream that echoes the credential cannot leak it to a client", async () => {
    mock.chatHandler = (call) =>
      Response.json(
        {
          error: {
            message: `Incorrect API key provided: ${call.auth}`,
            type: "invalid_request_error",
          },
        },
        { status: 401 },
      );

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    const text = await response.text();
    // The key is rejected, so the client gets brokey's verdict rather than the
    // provider's body — which cannot leak the credential because it is never
    // echoed. The raw, redacted text stays on the key for the admin.
    expect(response.status).toBe(503);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("No usable API keys left for provider");

    // ...nor into the stored key error that the admin UI renders.
    const detail = await adminJson<ProviderDetailDTO>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    expect(detail.keys[0]?.lastError).not.toContain(SECRET);
    expect(detail.keys[0]?.lastError).toContain("[redacted]");
    mock.chatHandler = null;
  });

  test("provider secrets never appear in admin or public responses", async () => {
    const detailText = await (
      await adminRequest(app, `/api/admin/providers/${providerId}`)
    ).text();
    expect(detailText).not.toContain(SECRET);
    expect(detailText).not.toContain('lastError":"Incorrect');

    const listText = await (
      await adminRequest(app, "/api/admin/providers")
    ).text();
    expect(listText).not.toContain(SECRET);

    const statsText = await (await fetch(`${app.baseUrl}/api/stats`)).text();
    expect(statsText).not.toContain(SECRET);
    expect(statsText).not.toContain("keyHash");
  });
});

describe("header handling", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "headers",
      baseUrl: mock.baseUrl,
      secrets: ["sk-header-key"],
    });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "header-client" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("cookies and brokey control headers stop at the proxy", async () => {
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [{ role: "user", content: "hi" }] },
      headers: {
        cookie: "session=proxy-only",
        "x-brokey-provider": "headers",
        "x-brokey-probe": "1",
        "x-custom-client": "keep-me",
      },
    });
    expect(response.status).toBe(200);

    const call = mock.calls[mock.calls.length - 1];
    expect(call?.auth).toBe("Bearer sk-header-key");
    expect(call?.headers.cookie).toBeUndefined();
    expect(
      Object.keys(call?.headers ?? {}).filter((name) =>
        name.startsWith("x-brokey"),
      ),
    ).toEqual([]);
    expect(call?.headers["x-custom-client"]).toBe("keep-me");
  });

  test("extraHeaders reach the upstream but cannot replace the credential", async () => {
    mock.modelsHandler = () => undefined;
    await adminJson(app, `/api/admin/providers/${providerId}`, {
      method: "PATCH",
      body: { extraHeaders: { "http-referer": "https://example.com" } },
    });
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(response.status).toBe(200);
    const call = mock.calls[mock.calls.length - 1];
    expect(call?.headers["http-referer"]).toBe("https://example.com");
    expect(call?.auth).toBe("Bearer sk-header-key");
  });

  test("malformed extraHeaders are rejected at write time", async () => {
    for (const extraHeaders of [
      { "bad header": "value" },
      { "x-ok": "line\r\nbreak" },
      { authorization: "Bearer attacker" },
      { host: "evil.example.com" },
    ]) {
      const response = await adminRequest(
        app,
        `/api/admin/providers/${providerId}`,
        {
          method: "PATCH",
          body: { extraHeaders },
        },
      );
      expect(response.status).toBe(400);
    }

    // Nothing was stored, and the provider still works.
    const detail = await adminJson<ProviderDetailDTO>(
      app,
      `/api/admin/providers/${providerId}`,
    );
    expect(detail.extraHeaders).toEqual({
      "http-referer": "https://example.com",
    });
  });

  test("a legacy invalid extraHeaders row cannot break the proxy", async () => {
    app.db
      .update(providers)
      .set({
        extraHeaders: JSON.stringify({
          "bad header name": "v",
          "x-legacy": "ok",
        }),
      })
      .where(eq(providers.id, providerId))
      .run();

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(response.status).toBe(200);
    const call = mock.calls[mock.calls.length - 1];
    expect(call?.headers["x-legacy"]).toBe("ok");
    expect(call?.auth).toBe("Bearer sk-header-key");

    app.db
      .update(providers)
      .set({ extraHeaders: null })
      .where(eq(providers.id, providerId))
      .run();
  });

  test("malformed percent-encoding in a model ID is a 404, not a crash", async () => {
    const response = await proxyRequest(app, "/v1/models/%ZZ", token);
    expect(response.status).toBe(404);
    const body = await readJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("model_not_found");
  });
});

describe("admin surface", () => {
  test("an empty ADMIN_TOKEN disables the admin API but keeps the proxy public", async () => {
    const app = startTestApp({ adminToken: "" });
    try {
      const me = await fetch(`${app.baseUrl}/api/admin/me`);
      expect(me.status).toBe(503);
      const body = await readJson<{ error: { code: string } }>(me);
      expect(body.error.code).toBe("admin_disabled");

      const anyToken = await fetch(`${app.baseUrl}/api/admin/providers`, {
        headers: { authorization: "Bearer anything" },
      });
      expect(anyToken.status).toBe(503);

      const stats = await fetch(`${app.baseUrl}/api/stats`);
      expect(stats.status).toBe(200);
    } finally {
      app.stop();
    }
  });

  test("client requests without a key are rejected before any upstream call", async () => {
    const app = startTestApp();
    const mock = startMockUpstream();
    try {
      const provider = await seedProvider(app, {
        name: "gate",
        baseUrl: mock.baseUrl,
      });
      await seedModel(app, provider.providerId, {
        upstreamId: "upstream-mock-chat",
        publicId: "mock-chat",
      });

      const missing = await fetch(`${app.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-chat", messages: [] }),
      });
      expect(missing.status).toBe(401);

      const wrong = await proxyRequest(
        app,
        "/v1/chat/completions",
        "sk-brokey-nope",
        {
          body: { model: "mock-chat", messages: [] },
        },
      );
      expect(wrong.status).toBe(401);
      expect(mock.calls.length).toBe(0);
    } finally {
      app.stop();
      mock.stop();
    }
  });
});

describe("quota enforcement", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "quota",
      baseUrl: mock.baseUrl,
      secrets: ["sk-quota-key"],
    });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "quota-client" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("usage is counted for non-chat endpoints too", async () => {
    const response = await proxyRequest(app, "/v1/completions", token, {
      body: { model: "mock-chat", prompt: "hi" },
    });
    expect(response.status).toBe(200);

    const usage = await readJson<{
      rows: { endpoint: string; totalTokens: number }[];
    }>(await adminRequest(app, "/api/admin/usage?pageSize=1"));
    expect(usage.rows[0]?.endpoint).toBe("/v1/completions");
    expect(usage.rows[0]?.totalTokens).toBe(10);
  });

  test("a request cap holds under concurrency", async () => {
    mock.chatHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return Response.json({
        choices: [{ message: { role: "assistant", content: "slow" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const key = await seedClientKey(app, {
      name: "concurrent",
      limitWindow: "total",
      limitRequests: 1,
    });

    const [first, second] = await Promise.all([
      proxyRequest(app, "/v1/chat/completions", key.token, {
        body: { model: "mock-chat", messages: [] },
      }),
      proxyRequest(app, "/v1/chat/completions", key.token, {
        body: { model: "mock-chat", messages: [] },
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 429]);

    const rejected = first.status === 429 ? first : second;
    const body = await readJson<{ error: { code: string } }>(rejected);
    expect(body.error.code).toBe("usage_limit_exceeded");
    mock.chatHandler = null;
  });
});

describe("upstream response hardening", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let token: string;

  beforeAll(async () => {
    app = startTestApp();
    mock = startMockUpstream();
    const provider = await seedProvider(app, {
      name: "hardening",
      baseUrl: mock.baseUrl,
      secrets: ["sk-hardening"],
    });
    await seedModel(app, provider.providerId, {
      upstreamId: "upstream-mock-chat",
      publicId: "mock-chat",
    });
    token = (await seedClientKey(app, { name: "hardening-client" })).token;
  });

  afterAll(() => {
    app.stop();
    mock.stop();
  });

  test("non-JSON content types on a JSON endpoint are rejected before forwarding", async () => {
    const before = mock.calls.length;
    const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ model: "mock-chat", messages: [] }),
    });
    expect(response.status).toBe(415);
    expect(
      (await readJson<{ error: { code: string } }>(response)).error.code,
    ).toBe("unsupported_media_type");
    expect(mock.calls.length).toBe(before);
  });

  test("a 403 is forwarded and does not cool the provider key", async () => {
    mock.chatHandler = () =>
      Response.json(
        { error: { message: "model not permitted for this key" } },
        { status: 403 },
      );
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: { model: "mock-chat", messages: [] },
    });
    expect(response.status).toBe(403);
    const detail = await adminJson<ProviderDetailDTO>(
      app,
      "/api/admin/providers/1",
    );
    expect(detail.keys[0]?.status).toBe("active");
    expect(detail.keys[0]?.cooldownUntil).toBeNull();
    mock.chatHandler = null;
  });

  test("upstream document content types cannot execute on the proxy origin", async () => {
    mock.anyHandler = (call) =>
      call.path === "/v1/images/generations"
        ? new Response("<script>alert(1)</script>", {
            status: 200,
            headers: {
              "content-type": "text/html",
              location: "https://evil.example",
            },
          })
        : undefined;

    const response = await proxyRequest(app, "/v1/images/generations", token, {
      body: { model: "mock-chat", prompt: "x" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    mock.anyHandler = null;
  });
});

describe("storage hygiene", () => {
  test("the database file is created private to its owner", async () => {
    const dir = `/tmp/brokey-perm-${Date.now()}`;
    const dbPath = `${dir}/brokey.db`;
    const app = startTestApp({ dbPath });
    try {
      const { statSync } = await import("node:fs");
      const stat = statSync(dbPath);
      expect(stat.mode & 0o777).toBe(0o600);
      const dirStat = statSync(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      app.stop();
      await import("node:fs").then(({ rmSync }) =>
        rmSync(dir, { recursive: true, force: true }),
      );
    }
  });

  test("the stats cache follows admin mutations", async () => {
    const app = startTestApp();
    const mock = startMockUpstream();
    try {
      const provider = await seedProvider(app, {
        name: "cache",
        baseUrl: mock.baseUrl,
      });
      const key = await seedClientKey(app, { name: "cache-client" });
      insertUsageLog(app, {
        clientKeyId: key.id,
        clientKeyLabel: "cache-client",
        providerId: provider.providerId,
        providerName: "cache",
        totalTokens: 5,
      });

      // The public payload never names keys or providers.
      const first = await readJson<StatsResponse>(
        await fetch(`${app.baseUrl}/api/stats?range=all`),
      );
      expect(first.totals.totalTokens).toBe(5);

      await adminJson(app, `/api/admin/client-keys/${key.id}`, {
        method: "DELETE",
      });

      // The log rows keep their snapshots, so the totals survive the delete.
      const second = await readJson<StatsResponse>(
        await fetch(`${app.baseUrl}/api/stats?range=all`),
      );
      expect(second.totals.totalTokens).toBe(5);
    } finally {
      app.stop();
      mock.stop();
    }
  });
});
