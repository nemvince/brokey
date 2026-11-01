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
