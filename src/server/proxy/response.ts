export type ProxyErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error";

/** OpenAI-compatible error envelope. */
export function jsonError(
  status: number,
  message: string,
  type: ProxyErrorType,
  code: string | null = null,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { message, type, param: null, code } },
    { status, headers },
  );
}

const DROP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
];

/**
 * Content types a proxied response may carry. Anything else (notably
 * `text/html` and `image/svg+xml`) is rewritten to octet-stream, so a hostile
 * upstream cannot get script running on brokey's origin where the admin token
 * lives in localStorage.
 */
const SAFE_RESPONSE_TYPE =
  /^(application\/json|application\/[a-z0-9.+-]+\+json|text\/event-stream|text\/plain|application\/octet-stream|image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|multipart\/[a-z0-9.+-]+)/i;

/** Upstream headers that would redirect or re-authenticate the browser. */
const DROPPED_UPSTREAM_HEADERS = ["location", "refresh", "www-authenticate"];

export function forwardHeaders(upstream: HeadersInit): Headers {
  const headers = new Headers();
  new Headers(upstream).forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.includes(lower)) return;
    if (DROPPED_UPSTREAM_HEADERS.includes(lower)) return;
    if (lower === "content-type") {
      headers.set(
        "content-type",
        SAFE_RESPONSE_TYPE.test(value.trim())
          ? value
          : "application/octet-stream",
      );
      return;
    }
    headers.set(name, value);
  });
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  return headers;
}

export function decorate(
  headers: Headers,
  requestId: string,
  limitHeaders: Record<string, string>,
): Headers {
  headers.set("x-brokey-request-id", requestId);
  for (const [name, value] of Object.entries(limitHeaders))
    headers.set(name, value);
  return headers;
}
