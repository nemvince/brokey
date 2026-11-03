import { HttpError } from "./errors.ts";

export function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function asString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string {
  if (typeof value !== "string")
    throw new HttpError(400, `"${field}" must be a string.`);
  const text = opts.trim === false ? value : value.trim();
  const min = opts.min ?? 0;
  const max = opts.max ?? 10_000;
  if (text.length < min) {
    throw new HttpError(
      400,
      `"${field}" must be at least ${min} character${min === 1 ? "" : "s"}.`,
    );
  }
  if (text.length > max)
    throw new HttpError(400, `"${field}" must be at most ${max} characters.`);
  return text;
}

export function asBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new HttpError(400, `"${field}" must be a boolean.`);
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(
      400,
      `"${field}" must be one of ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

/** `null` clears the value, `undefined` leaves it untouched. */
export function asOptionalInt(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, `"${field}" must be an integer or null.`);
  }
  const min = opts.min ?? 0;
  if (value < min) throw new HttpError(400, `"${field}" must be >= ${min}.`);
  if (opts.max !== undefined && value > opts.max) {
    throw new HttpError(400, `"${field}" must be <= ${opts.max}.`);
  }
  return value;
}

/** A finite float in range, for sampling parameters such as temperature. */
export function asOptionalNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `"${field}" must be a number or null.`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new HttpError(400, `"${field}" must be >= ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new HttpError(400, `"${field}" must be <= ${opts.max}.`);
  }
  return value;
}

export function asOptionalString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return asString(value, field, opts);
}

export function asPositiveId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `"${field}" must be a positive integer.`);
  }
  return value;
}

export function optionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    throw new HttpError(400, `"${field}" must be a positive integer.`);
  }
  return asPositiveId(value, field);
}

export function queryInt(url: URL, name: string): number | undefined {
  return optionalId(url.searchParams.get(name), name);
}
