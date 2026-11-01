export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error";

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers as object) },
  });
}

/** OpenAI-compatible error envelope. */
export function openaiError(
  status: number,
  message: string,
  type: ErrorType = "invalid_request_error",
  code: string | null = null,
  param: string | null = null,
  headers?: HeadersInit,
): Response {
  return json({ error: { message, type, param, code } }, status, headers);
}

/** Admin API error envelope: `{ error: { message, code } }`. */
export function adminError(status: number, message: string, code?: string): Response {
  return json({ error: code ? { message, code } : { message } }, status);
}

export class HttpError extends Error {
  status: number;
  code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function toResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return adminError(error.status, error.message, error.code);
  }
  const conflict = uniqueConstraintField(error);
  if (conflict) {
    return adminError(409, `A record with that ${conflict} already exists.`, "conflict");
  }
  const message = error instanceof Error ? error.message : String(error);
  return adminError(500, message);
}

/** `UNIQUE constraint failed: models.public_id` → `public id`. */
export function uniqueConstraintField(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  const match = /UNIQUE constraint failed: ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/.exec(message);
  if (!match) return null;
  const column = match[2] as string;
  return column.replace(/_/g, " ");
}

/** Narrow a `.get()` result, turning a missing row into an HTTP error. */
export function expectRow<T>(row: T | undefined, message: string, status = 500): T {
  if (row === undefined) throw new HttpError(status, message);
  return row;
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}
