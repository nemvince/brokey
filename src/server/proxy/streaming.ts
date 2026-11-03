export type SseFrame = { raw: string; separator: string };

/** A single event larger than this means the upstream is not sending SSE. */
const MAX_FRAME_BYTES = 1024 * 1024;

/** Splits a byte stream into raw SSE event frames, keeping the original separators. */
export class SseSplitter {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";

  push(chunk: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const frames = this.drain();
    if (this.buffer.length > MAX_FRAME_BYTES) {
      throw new Error(
        `SSE event exceeded ${MAX_FRAME_BYTES} bytes without a separator.`,
      );
    }
    return frames;
  }

  flush(): SseFrame[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? [] : [{ raw: rest, separator: "" }];
  }

  /**
   * Events are terminated by a blank line: `\n\n` or `\r\n\r\n`. Scanning with
   * `indexOf` keeps this linear; a regex over a growing buffer is quadratic.
   */
  private drain(): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const lf = this.buffer.indexOf("\n\n");
      const crlf = this.buffer.indexOf("\r\n\r\n");
      const useCrlf = crlf !== -1 && (lf === -1 || crlf <= lf);
      const index = useCrlf ? crlf : lf;
      if (index === -1) return frames;
      const separator = useCrlf ? "\r\n\r\n" : "\n\n";
      frames.push({ raw: this.buffer.slice(0, index), separator });
      this.buffer = this.buffer.slice(index + separator.length);
    }
  }
}

export function sseData(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length > 0 ? data.join("\n") : null;
}

export function parseEventJson(raw: string): unknown {
  const data = sseData(raw);
  if (data === null || data === "") return null;
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}

export function concatChunks(
  chunks: Uint8Array[],
  total: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a response body while enforcing a byte cap, so a hostile or broken
 * upstream cannot make the proxy buffer without bound.
 */
export async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: new Uint8Array(0), truncated: true };
  }
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return {
          bytes: concatChunks(chunks, total - value.byteLength),
          truncated: true,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: concatChunks(chunks, total), truncated: false };
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // Match the abort type, never substrings of the message: Bun reports an
  // upstream reset as `ECONNRESET: The socket connection was closed
  // unexpectedly`, which is a network failure, not a client abort.
  if ("name" in error && error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

export function streamErrorEvent(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: "api_error",
      param: null,
      code: "stream_error",
    },
  })}\n\n`;
}
