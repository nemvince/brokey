import { asc, eq } from "drizzle-orm";
import { HttpError, expectRow, json, readJson } from "../errors.ts";
import { clientKeys } from "../schema.ts";
import { hashClientToken } from "../auth.ts";
import {
  asBool,
  asEnum,
  asOptionalInt,
  asRecord,
  asString,
} from "../validate.ts";
import type {
  ClientKeyCreatedDTO,
  ClientKeyDTO,
  LimitWindow,
} from "../../shared/types.ts";
import { toClientKeyDTO } from "./dto.ts";
import type { AdminCtx } from "./context.ts";
import { usageForWindow } from "../proxy/limits.ts";

const LIMIT_WINDOWS: readonly LimitWindow[] = ["total", "day", "month"];
const TOKEN_PREFIX = "sk-brokey-";

export function listClientKeys(ctx: AdminCtx): Response {
  const rows = ctx.db
    .select()
    .from(clientKeys)
    .orderBy(asc(clientKeys.id))
    .all();
  const dtos: ClientKeyDTO[] = rows.map((row) =>
    toClientKeyDTO(
      row,
      usageForWindow(ctx.db, row.id, row.limitWindow as LimitWindow, ctx.now),
    ),
  );
  return json({ clientKeys: dtos });
}

function generateClientToken(): {
  token: string;
  keyHash: string;
  keyPrefix: string;
} {
  const token =
    TOKEN_PREFIX +
    Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
      "base64url",
    );
  return {
    token,
    keyHash: hashClientToken(token),
    keyPrefix: token.slice(0, 14),
  };
}

export async function createClientKey(ctx: AdminCtx): Promise<Response> {
  const body = asRecord(await readJson(ctx.req));
  const name = asString(body.name, "name", { min: 1, max: 64 });
  const limitWindow =
    body.limitWindow === undefined
      ? "total"
      : asEnum(body.limitWindow, "limitWindow", LIMIT_WINDOWS);
  const limitTokens = asOptionalInt(body.limitTokens, "limitTokens", {
    min: 0,
  });
  const limitRequests = asOptionalInt(body.limitRequests, "limitRequests", {
    min: 0,
  });
  const enabled =
    body.enabled === undefined ? true : asBool(body.enabled, "enabled");

  const { token, keyHash, keyPrefix } = generateClientToken();
  const inserted = expectRow(
    ctx.db
      .insert(clientKeys)
      .values({
        name,
        keyHash,
        keyPrefix,
        enabled,
        limitWindow,
        limitTokens: limitTokens ?? null,
        limitRequests: limitRequests ?? null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        lastUsedAt: null,
      })
      .returning()
      .get(),
    "Failed to create client key.",
  );

  const dto: ClientKeyCreatedDTO = {
    ...toClientKeyDTO(
      inserted,
      usageForWindow(ctx.db, inserted.id, limitWindow, ctx.now),
    ),
    key: token,
  };
  return json(dto, 201);
}

export async function updateClientKey(ctx: AdminCtx): Promise<Response> {
  const id = Number(ctx.params[0]);
  const existing = ctx.db
    .select()
    .from(clientKeys)
    .where(eq(clientKeys.id, id))
    .get();
  if (!existing) throw new HttpError(404, "Client key not found.");
  const body = asRecord(await readJson(ctx.req));

  const patch: Partial<typeof clientKeys.$inferInsert> = { updatedAt: ctx.now };
  if (body.name !== undefined)
    patch.name = asString(body.name, "name", { min: 1, max: 64 });
  if (body.limitWindow !== undefined) {
    patch.limitWindow = asEnum(body.limitWindow, "limitWindow", LIMIT_WINDOWS);
  }
  if (body.limitTokens !== undefined) {
    patch.limitTokens =
      asOptionalInt(body.limitTokens, "limitTokens", { min: 0 }) ?? null;
  }
  if (body.limitRequests !== undefined) {
    patch.limitRequests =
      asOptionalInt(body.limitRequests, "limitRequests", { min: 0 }) ?? null;
  }
  if (body.enabled !== undefined)
    patch.enabled = asBool(body.enabled, "enabled");

  const updated = expectRow(
    ctx.db
      .update(clientKeys)
      .set(patch)
      .where(eq(clientKeys.id, id))
      .returning()
      .get(),
    "Failed to update client key.",
  );

  return json(
    toClientKeyDTO(
      updated,
      usageForWindow(
        ctx.db,
        updated.id,
        updated.limitWindow as LimitWindow,
        ctx.now,
      ),
    ),
  );
}

export function deleteClientKey(ctx: AdminCtx): Response {
  const id = Number(ctx.params[0]);
  const existing = ctx.db
    .select({ id: clientKeys.id })
    .from(clientKeys)
    .where(eq(clientKeys.id, id))
    .get();
  if (!existing) throw new HttpError(404, "Client key not found.");
  ctx.db.delete(clientKeys).where(eq(clientKeys.id, id)).run();
  return json({ ok: true });
}
