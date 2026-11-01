import { timingSafeEqual } from "node:crypto";
import type { AppDb } from "./db.ts";
import { type ClientKeyRow, clientKeys } from "./schema.ts";
import { HttpError } from "./errors.ts";
import { eq } from "drizzle-orm";

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type AdminAuth = { ok: true } | { ok: false; response: Response };

export function assertAdmin(req: Request, adminToken: string): AdminAuth {
  if (adminToken.trim() === "") {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            message: "Admin is disabled: set ADMIN_TOKEN on the server.",
            code: "admin_disabled",
          },
        },
        { status: 503 },
      ),
    };
  }
  const token = bearerToken(req);
  if (!token || !timingSafeEqualString(token, adminToken)) {
    return {
      ok: false,
      response: Response.json(
        { error: { message: "Invalid admin token.", code: "unauthorized" } },
        { status: 401 },
      ),
    };
  }
  return { ok: true };
}

export function hashClientToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export type ClientAuthFailure = { ok: false; response: Response };

export function authenticateClient(
  req: Request,
  db: AppDb,
): { ok: true; key: ClientKeyRow } | ClientAuthFailure {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      response: openaiAuthError(
        "Missing bearer token in Authorization header.",
      ),
    };
  }
  const key = db
    .select()
    .from(clientKeys)
    .where(eq(clientKeys.keyHash, hashClientToken(token)))
    .get();
  if (!key) {
    return {
      ok: false,
      response: openaiAuthError("Incorrect API key provided."),
    };
  }
  if (!key.enabled) {
    return {
      ok: false,
      response: openaiAuthError("This API key has been disabled."),
    };
  }
  return { ok: true, key };
}

function openaiAuthError(message: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    },
    { status: 401 },
  );
}

export function requireId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Not found.");
  return id;
}
