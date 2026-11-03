#!/usr/bin/env bun
/**
 * egress-proxy.ts: a minimal HTTP forward proxy, for turning a host into one
 * rotatable egress entry.
 *
 * Derived from azrinaldi/opencode-free-bridge `egress-proxy.js` (MIT),
 * Copyright (c) 2026 azrinaldi:
 * https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/egress-proxy.js
 * See THIRD_PARTY_NOTICES.md.
 *
 * The pool only needs two shapes: CONNECT for TLS, and absolute-URI HTTP(S)
 * for an occasional plaintext probe. This process answers both and does
 * nothing else: no caching, no TLS termination, no header rewriting, no body
 * inspection. A pool entry only has to carry one machine's egress.
 *
 * Reachability: the proxy binds loopback by default. Reaching it from another
 * host is the tunnel's job (an SSH `-L`), which also carries authentication, so
 * a token is optional and only meaningful when the listener is exposed.
 *
 *   PORT=8888 EGRESS_PROXY_TOKEN=secret bun scripts/egress-proxy.ts
 *   curl -x http://secret@127.0.0.1:8888 https://models.opencode.ai/api.json
 *
 * Never logs upstream targets, paths, or bodies.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const PORT = intEnv("PORT", 8888);
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const TOKEN = (process.env.EGRESS_PROXY_TOKEN ?? "").trim();
const CONNECT_TIMEOUT_MS = intEnv("CONNECT_TIMEOUT_MS", 15_000);
const IDLE_TIMEOUT_MS = intEnv("IDLE_TIMEOUT_MS", 120_000);
const MAX_CONNECTIONS = intEnv("MAX_CONNECTIONS", 512);

const startedAt = Date.now();
let active = 0;

function authorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  // Proxy-Authorization: Basic base64(user:token). Only the password is
  // checked, because a proxy URL's user part is conventionally free-form.
  const header = req.headers["proxy-authorization"];
  const value = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  const match = /^Basic\s+(.+)$/i.exec(value);
  if (!match) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  } catch {
    return false;
  }
  return decoded.slice(decoded.indexOf(":") + 1) === TOKEN;
}

function requireAuth(res: http.ServerResponse): void {
  res.writeHead(407, {
    "Proxy-Authenticate": 'Basic realm="egress"',
    "Content-Type": "text/plain",
  });
  res.end("proxy authentication required\n");
}

function jsonStatus(
  res: http.ServerResponse,
  status: number,
  error: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function release(): void {
  active = Math.max(0, active - 1);
}

const ALLOWED_METHODS: Record<string, true> = {
  GET: true,
  HEAD: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  OPTIONS: true,
};
const ALLOW_HEADER = Object.keys(ALLOWED_METHODS).join(", ");

/** Plaintext forwarding: replay the request against the absolute-URI target. */
function forwardHttp(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  target: URL,
): void {
  const method = (clientReq.method ?? "GET").toUpperCase();
  if (ALLOWED_METHODS[method] !== true) {
    clientRes.writeHead(405, { Allow: ALLOW_HEADER });
    clientRes.end();
    return;
  }

  if (active >= MAX_CONNECTIONS) {
    jsonStatus(clientRes, 503, "proxy connection limit reached");
    return;
  }
  active += 1;

  const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = target.host;

  const secure = target.protocol === "https:";
  const transport = secure ? https : http;
  const options: https.RequestOptions = {
    host: target.hostname,
    port: target.port ? Number.parseInt(target.port, 10) : secure ? 443 : 80,
    method,
    path: `${target.pathname}${target.search}`,
    headers,
  };
  if (secure) options.servername = target.hostname;

  let done = false;
  let upstream: http.ClientRequest | null = null;
  const finish = (): void => {
    if (done) return;
    done = true;
    release();
    upstream?.destroy();
  };

  upstream = transport.request(options, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
    upstreamRes.on("end", finish);
    upstreamRes.on("aborted", finish);
    upstreamRes.on("error", finish);
  });

  upstream.setTimeout(CONNECT_TIMEOUT_MS, () =>
    upstream?.destroy(new Error("upstream timeout")),
  );
  upstream.on("error", (err) => {
    finish();
    if (!clientRes.headersSent)
      jsonStatus(clientRes, 502, `upstream: ${err.message}`);
    else clientRes.destroy();
  });
  clientRes.on("close", finish);
  clientRes.on("error", finish);
  clientReq.pipe(upstream);
}

const server = http.createServer((req, res) => {
  // Health is unauthenticated on purpose: it carries a connection count and an
  // uptime, and a monitor should not need the proxy credential to ask whether
  // the proxy is up. It never reports the token or a target.
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        role: "egress-proxy",
        activeConnections: active,
        uptimeMs: Date.now() - startedAt,
      }),
    );
    return;
  }

  if (!authorized(req)) {
    requireAuth(res);
    return;
  }

  const target = req.url ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    jsonStatus(res, 400, "Only CONNECT and absolute http:// URLs are proxied.");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    jsonStatus(res, 400, "Only CONNECT and absolute http:// URLs are proxied.");
    return;
  }

  forwardHttp(req, res, parsed);
});

function splitHostPort(value: string): [string | null, string | null] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return [null, null];
    return [value.slice(1, end), value.slice(end + 1).replace(/^:/, "")];
  }
  const index = value.lastIndexOf(":");
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

/** CONNECT: open a raw TCP tunnel and join both directions. */
server.on("connect", (req, clientSocket, head: Buffer) => {
  if (!authorized(req)) {
    clientSocket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\n\r\n',
    );
    return;
  }
  if (active >= MAX_CONNECTIONS) {
    clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }

  const [host, portRaw] = splitHostPort(req.url ?? "");
  const port = Number.parseInt(portRaw ?? "443", 10);
  if (!host || !Number.isFinite(port) || port < 1 || port > 65_535) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  active += 1;
  const upstream = net.connect({ host, port });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    release();
    upstream.destroy();
    clientSocket.destroy();
  };

  const connectTimer = setTimeout(
    () => upstream.destroy(new Error("connect timeout")),
    CONNECT_TIMEOUT_MS,
  );
  // Half-open handling: either side closing tears down the pair, so a dead
  // client never pins a slot until the idle timeout fires.
  upstream.on("connect", () => {
    clearTimeout(connectTimer);
    upstream.setTimeout(IDLE_TIMEOUT_MS, () =>
      upstream.destroy(new Error("idle timeout")),
    );
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    clearTimeout(connectTimer);
    if (!clientSocket.destroyed)
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    close();
  });
  upstream.on("close", close);
  clientSocket.on("error", close);
  clientSocket.on("close", close);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[egress-proxy] listening on ${HOST}:${PORT}` +
      (TOKEN ? " (token required)" : " (no token)"),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[egress-proxy] ${signal}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
