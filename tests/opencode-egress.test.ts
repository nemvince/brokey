import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { egressHealth } from "../src/server/schema.ts";
import {
  adminJson,
  adminRequest,
  proxyRequest,
  readJson,
  seedClientKey,
  seedModel,
  seedOpenCodeProvider,
  startMockUpstream,
  startTestApp,
  type MockUpstream,
  type TestApp,
} from "./helpers.ts";

/**
 * A forward proxy the way Bun's `fetch(..., { proxy })` uses one: absolute-form
 * request URLs for http targets, `Proxy-Authorization` for credentials. The
 * Cloudflare trace endpoint is answered locally so no test needs the internet.
 */
type ForwardProxy = {
  /** host:port of this listener, without credentials. */
  host: string;
  /** `url` with credentials, the value stored in the pool. */
  url: string;
  seen: string[];
  stop: () => void;
};

async function startForwardProxy(
  options: { credentials?: string } = {},
): Promise<ForwardProxy> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const target = req.url ?? "";
    seen.push(target);
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400).end("absolute-form URL required");
      return;
    }
    if (parsed.hostname === "www.cloudflare.com") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fl=test\nip=203.0.113.9\nts=1\n");
      return;
    }
    const upstream = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: parsed.host },
      },
      (proxied) => {
        res.writeHead(proxied.statusCode ?? 502, proxied.headers);
        proxied.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502).end("proxy error");
    });
    req.pipe(upstream);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const auth = options.credentials ? `${options.credentials}@` : "";
  return {
    host: `127.0.0.1:${port}`,
    url: `http://${auth}127.0.0.1:${port}`,
    seen,
    stop: () => server.close(),
  };
}

const CATALOG = {
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "big-pickle": {
        name: "Big Pickle",
        cost: { input: 0, output: 0 },
        limit: { context: 200_000, output: 64_000 },
        reasoning: true,
        tool_call: true,
      },
    },
  },
};

function sseCompletion(text: string): Response {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })}`,
    "data: [DONE]",
    "",
  ];
  return new Response(lines.join("\n\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

type EgressBody = {
  strategy: string;
  relayHost: string | null;
  active: boolean;
  entries: {
    id: string;
    host: string | null;
    direct: boolean;
    enabled: boolean;
    failures: number;
    cooling: boolean;
  }[];
};

describe("opencode egress pool", () => {
  let app: TestApp;
  let mock: MockUpstream;
  let providerId: number;
  let token: string;
  const proxies: ForwardProxy[] = [];

  const chatTargets = (proxy: ForwardProxy) =>
    proxy.seen.filter((target) => target.includes("/chat/completions")).length;

  const setPool = async (body: unknown) =>
    adminJson<{ ok: boolean; egress: EgressBody }>(
      app,
      `/api/admin/providers/${providerId}/egress`,
      { method: "PUT", body },
    );

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
    const provider = await seedOpenCodeProvider(app, { name: "rotating" });
    providerId = provider.providerId;
    await seedModel(app, providerId, {
      upstreamId: "big-pickle",
      publicId: "big-pickle",
      displayName: "Big Pickle",
    });
    token = (await seedClientKey(app, { name: "egress-client" })).token;
    mock.chatHandler = () => sseCompletion("via egress");
  });

  afterAll(() => {
    app.stop();
    mock.stop();
    for (const proxy of proxies) proxy.stop();
  });

  test("a spent allowance rotates to the next egress", async () => {
    const first = await startForwardProxy();
    const second = await startForwardProxy();
    proxies.push(first, second);
    await setPool({
      strategy: "failover",
      entries: [
        { label: "a", url: first.url },
        { label: "b", url: second.url },
      ],
    });

    let attempt = 0;
    mock.chatHandler = () => {
      attempt += 1;
      if (attempt === 1)
        return Response.json(
          {
            error: {
              type: "FreeUsageLimitError",
              message: "too many requests",
            },
          },
          { status: 429 },
        );
      return sseCompletion("second egress");
    };

    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "rotate" }],
      },
    });
    expect(response.status).toBe(200);
    expect(chatTargets(first)).toBe(1);
    expect(chatTargets(second)).toBe(1);
    // The first proxy reached upstream first, so failover order held.
    expect(first.seen.length).toBeGreaterThan(0);

    const rows = app.db
      .select()
      .from(egressHealth)
      .where(eq(egressHealth.providerId, providerId))
      .all();
    const cooling = rows.filter((row) => row.cooldownUntil > Date.now());
    expect(cooling.length).toBe(1);
    expect(cooling[0]?.failures).toBe(1);
    mock.chatHandler = () => sseCompletion("via egress");
  });

  test("round-robin rotates and failover stays sticky", async () => {
    const a = await startForwardProxy();
    const b = await startForwardProxy();
    const c = await startForwardProxy();
    proxies.push(a, b, c);
    await setPool({
      strategy: "round-robin",
      entries: [
        { label: "a", url: a.url },
        { label: "b", url: b.url },
        { label: "c", url: c.url },
      ],
    });

    for (const message of ["one", "two", "three"]) {
      const response = await proxyRequest(app, "/v1/chat/completions", token, {
        body: {
          model: "big-pickle",
          messages: [{ role: "user", content: message }],
        },
      });
      expect(response.status).toBe(200);
    }
    expect([chatTargets(a), chatTargets(b), chatTargets(c)]).toEqual([1, 1, 1]);

    await setPool({
      strategy: "failover",
      entries: [
        { label: "a", url: a.url },
        { label: "b", url: b.url },
        { label: "c", url: c.url },
      ],
    });
    const beforeA = chatTargets(a);
    const beforeB = chatTargets(b);
    const beforeC = chatTargets(c);
    for (const message of ["four", "five"]) {
      await proxyRequest(app, "/v1/chat/completions", token, {
        body: {
          model: "big-pickle",
          messages: [{ role: "user", content: message }],
        },
      });
    }
    // Sticky on the first healthy entry, which keeps upstream prompt caching.
    expect([chatTargets(a), chatTargets(b), chatTargets(c)]).toEqual([
      beforeA + 2,
      beforeB,
      beforeC,
    ]);
  });

  test("a relay receives the target in headers and forwards", async () => {
    const relayed: { target: string; path: string; method: string }[] = [];
    const relay = Bun.serve({
      port: 0,
      async fetch(req) {
        const target = req.headers.get("x-relay-target") ?? "";
        const path = req.headers.get("x-relay-path") ?? "";
        relayed.push({ target, path, method: req.method });
        const body = await req.arrayBuffer();
        const forwarded = await fetch(`${target}${path}`, {
          method: req.method,
          headers: {
            "content-type":
              req.headers.get("content-type") ?? "application/json",
            authorization: req.headers.get("authorization") ?? "",
          },
          body: req.method === "GET" ? undefined : body,
        });
        return new Response(forwarded.body, {
          status: forwarded.status,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const relayProxy = await startForwardProxy();
    proxies.push(relayProxy);

    await setPool({
      relayUrl: `http://127.0.0.1:${relay.port}`,
      entries: [{ label: "relay", url: relayProxy.url }],
    });

    const upstreamCalls = mock.calls.length;
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "relay" }],
      },
    });
    expect(response.status).toBe(200);
    expect(relayed.length).toBeGreaterThan(0);
    const origin = new URL(mock.baseUrl).origin;
    expect(relayed[0]?.target).toBe(origin);
    expect(relayed[0]?.path).toBe("/v1/chat/completions");
    expect(relayed[0]?.method).toBe("POST");
    expect(mock.calls.length).toBe(upstreamCalls + 1);
    relay.stop(true);
  });

  test("credentials stay server-side and survive an entry update", async () => {
    const proxy = await startForwardProxy({ credentials: "user:secreta" });
    proxies.push(proxy);
    const saved = await setPool({
      strategy: "failover",
      relayUrl: null,
      entries: [{ label: "creds", url: proxy.url }],
    });
    const entry = saved.egress.entries[0];
    expect(entry?.host).toBe(proxy.host);
    const asJson = JSON.stringify(saved);
    expect(asJson).not.toContain("secreta");
    expect(asJson).not.toContain("user:");
    expect(entry?.id).toBeDefined();

    // Updating by id without a URL keeps the stored credential.
    await setPool({
      entries: [{ id: entry?.id, label: "creds renamed" }],
    });
    const before = chatTargets(proxy);
    const response = await proxyRequest(app, "/v1/chat/completions", token, {
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "keep" }],
      },
    });
    expect(response.status).toBe(200);
    expect(chatTargets(proxy)).toBe(before + 1);

    const secondDirect = await adminRequest(
      app,
      `/api/admin/providers/${providerId}/egress`,
      {
        method: "PUT",
        body: {
          entries: [
            { label: "direct-a", url: "" },
            { label: "direct-b", url: "" },
          ],
        },
      },
    );
    expect(secondDirect.status).toBe(400);

    const socks = await adminRequest(
      app,
      `/api/admin/providers/${providerId}/egress`,
      {
        method: "PUT",
        body: { entries: [{ label: "socks", url: "socks5://1.2.3.4:1080" }] },
      },
    );
    expect(socks.status).toBe(400);

    const nonHttp = await adminRequest(
      app,
      `/api/admin/providers/${providerId}/egress`,
      {
        method: "PUT",
        body: { entries: [{ label: "path", url: "http://1.2.3.4:8080/path" }] },
      },
    );
    expect(nonHttp.status).toBe(400);
  });

  test("a probe reports upstream status and the egress exit IP", async () => {
    const proxy = await startForwardProxy();
    proxies.push(proxy);
    await setPool({ entries: [{ label: "probe", url: proxy.url }] });
    const result = await adminJson<{
      results: {
        ok?: boolean;
        status?: number;
        exitIp?: string;
        host: string | null;
      }[];
    }>(app, `/api/admin/providers/${providerId}/egress/test`, { body: {} });
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[0]?.status).toBe(200);
    // The exit-IP probe is best effort: an https target needs a CONNECT
    // tunnel, which this test proxy does not provide.
    const exitIp = result.results[0]?.exitIp;
    expect(exitIp === null || typeof exitIp === "string").toBe(true);
    expect(result.results[0]?.host).toBe(proxy.host);
  });

  test("a non-opencode provider refuses the pool routes", async () => {
    const plain = await adminJson<{ id: number }>(app, "/api/admin/providers", {
      body: { name: "plain", baseUrl: "https://api.example.com/v1" },
    });
    const response = await adminRequest(
      app,
      `/api/admin/providers/${plain.id}/egress`,
    );
    expect(response.status).toBe(400);
    const pool = await readJson<{ error: { message: string } }>(response);
    expect(pool.error.message).toContain("not an OpenCode free provider");
  });

  test("health rows follow the entry they describe", async () => {
    const proxy = await startForwardProxy();
    proxies.push(proxy);
    await setPool({ entries: [{ label: "only", url: proxy.url }] });
    const rows = app.db
      .select()
      .from(egressHealth)
      .where(and(eq(egressHealth.providerId, providerId)))
      .all();
    // Entries from earlier pools are gone, so their health rows are too.
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
