/** RFC 9110 token characters, the only ones valid in a header field name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
