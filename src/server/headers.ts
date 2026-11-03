/** RFC 9110 token characters, the only ones valid in a header field name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Connection-scoped headers that must never be forwarded to another hop. */
export const HOP_BY_HOP: readonly string[] = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Headers brokey sets itself. Allowing provider `extraHeaders` to override them
 * would replace the provider credential or corrupt the request framing.
 */
export const RESERVED_EXTRA_HEADERS: readonly string[] = [
  "authorization",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "accept-encoding",
];

export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}

/** Rejects CR/LF and NUL so a stored value can never split a request. */
export function isValidHeaderValue(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * A provider's stored `extraHeaders` as a header map. Entries that brokey sets
 * itself, or that could not be sent at all, are dropped rather than trusted.
 */
export function parseStoredExtraHeaders(
  raw: string | null,
): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      if (!isValidHeaderName(name) || !isValidHeaderValue(value)) continue;
      if (RESERVED_EXTRA_HEADERS.includes(name.toLowerCase())) continue;
      out[name] = value;
    }
    return out;
  } catch {
    return null;
  }
}
