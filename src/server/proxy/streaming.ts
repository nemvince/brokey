export type SseFrame = { raw: string; separator: string };

/** Splits a byte stream into raw SSE event frames, keeping the original separators. */
export class SseSplitter {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";

  push(chunk: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  flush(): SseFrame[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? [] : [{ raw: rest, separator: "" }];
  }

  private drain(): SseFrame[] {
    const frames: SseFrame[] = [];
    // Events are terminated by a blank line: \n\n or \r\n\r\n.
    let match = /\r?\n\r?\n/.exec(this.buffer);
    while (match) {
      const end = match.index;
      const separator = match[0];
      frames.push({ raw: this.buffer.slice(0, end), separator });
      this.buffer = this.buffer.slice(end + separator.length);
      match = /\r?\n\r?\n/.exec(this.buffer);
    }
    return frames;
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

export const SSE_ENCODER = new TextEncoder();

export function encodeFrames(frames: SseFrame[]): Uint8Array[] {
  return frames.map((frame) => SSE_ENCODER.encode(frame.raw + frame.separator));
}

export function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}
