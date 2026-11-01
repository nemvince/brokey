import { asc, eq } from "drizzle-orm";
import type { AppDb } from "../db.ts";
import { HttpError, expectRow, json, readJson } from "../errors.ts";
import { models, providerKeys, type ProviderKeyRow, type ProviderRow, providers } from "../schema.ts";
import { asBool, asRecord, asString } from "../validate.ts";
import type { ProviderDTO, ProviderDetailDTO } from "../../shared/types.ts";
import {
  type ProviderCounts,
  toModelDTO,
  toProviderDTO,
  toProviderKeyDTO,
} from "./dto.ts";
import type { AdminCtx } from "./context.ts";

export function findProvider(db: AppDb, id: number): ProviderRow {
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) throw new HttpError(404, "Provider not found.");
  return row;
}

function findProviderKey(db: AppDb, id: number): ProviderKeyRow {
  const row = db.select().from(providerKeys).where(eq(providerKeys.id, id)).get();
  if (!row) throw new HttpError(404, "Provider key not found.");
  return row;
}

function providerCounts(db: AppDb, providerId: number, now: number): ProviderCounts {
  const keys = db
    .select({ enabled: providerKeys.enabled, cooldownUntil: providerKeys.cooldownUntil })
    .from(providerKeys)
    .where(eq(providerKeys.providerId, providerId))
    .all();
  const counts: ProviderCounts = {
    keyCount: keys.length,
    modelCount: db.select({ id: models.id }).from(models).where(eq(models.providerId, providerId)).all().length,
    active: 0,
    cooling: 0,
    disabled: 0,
  };
  for (const key of keys) {
    if (!key.enabled) counts.disabled += 1;
    else if (key.cooldownUntil !== null && key.cooldownUntil > now) counts.cooling += 1;
    else counts.active += 1;
  }
  return counts;
}

export function getProviderDetail(db: AppDb, id: number, now = Date.now()): ProviderDetailDTO {
  const provider = findProvider(db, id);
  const counts = providerCounts(db, id, now);
  const keys = db
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.providerId, id))
    .orderBy(asc(providerKeys.id))
    .all();
  const providerModelRows = db
    .select()
    .from(models)
    .where(eq(models.providerId, id))
    .orderBy(asc(models.publicId))
    .all();
  return {
    ...toProviderDTO(provider, counts),
    keys: keys.map((row) => toProviderKeyDTO(row, now)),
    models: providerModelRows.map((row) => toModelDTO(row, provider.name)),
  };
}

function validateBaseUrl(value: unknown): string {
  const raw = asString(value, "baseUrl", { min: 1, max: 500 });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, '"baseUrl" must be an absolute URL, for example https://api.openai.com/v1.');
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, '"baseUrl" must use http or https.');
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new HttpError(400, '"baseUrl" must not contain a query string or fragment.');
  }
  return raw.trim().replace(/\/+$/, "");
}

function serializeExtraHeaders(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, '"extraHeaders" must be an object of string values.');
  }
  const entries = Object.entries(value);
  const out: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string") {
      throw new HttpError(400, `"extraHeaders.${name}" must be a string.`);
    }
    out[name] = headerValue;
  }
  return entries.length === 0 ? null : JSON.stringify(out);
}

export function listProviders(ctx: AdminCtx): Response {
  const rows = ctx.db.select().from(providers).orderBy(asc(providers.name)).all();
  const dtos: ProviderDTO[] = rows.map((row) =>
    toProviderDTO(row, providerCounts(ctx.db, row.id, ctx.now)),
  );
  return json({ providers: dtos });
}

export async function createProvider(ctx: AdminCtx): Promise<Response> {
  const body = asRecord(await readJson(ctx.req));
  const name = asString(body.name, "name", { min: 1, max: 64 });
  const baseUrl = validateBaseUrl(body.baseUrl);
  const extraHeaders = serializeExtraHeaders(body.extraHeaders);
  const enabled = body.enabled === undefined ? true : asBool(body.enabled, "enabled");

  const now = ctx.now;
  const inserted = expectRow(
    ctx.db
      .insert(providers)
      .values({
        name,
        baseUrl,
        extraHeaders: extraHeaders ?? null,
        enabled,
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get(),
    "Failed to create provider.",
  );

  return json(toProviderDTO(inserted, providerCounts(ctx.db, inserted.id, now)), 201);
}

export async function updateProvider(ctx: AdminCtx): Promise<Response> {
  const id = Number(ctx.params[0]);
  const provider = findProvider(ctx.db, id);
  const body = asRecord(await readJson(ctx.req));

  const patch: Partial<typeof providers.$inferInsert> = { updatedAt: ctx.now };
  if (body.name !== undefined) patch.name = asString(body.name, "name", { min: 1, max: 64 });
  if (body.baseUrl !== undefined) patch.baseUrl = validateBaseUrl(body.baseUrl);
  if (body.enabled !== undefined) patch.enabled = asBool(body.enabled, "enabled");
  const extraHeaders = serializeExtraHeaders(body.extraHeaders);
  if (extraHeaders !== undefined) patch.extraHeaders = extraHeaders;

  const updated = expectRow(
    ctx.db.update(providers).set(patch).where(eq(providers.id, provider.id)).returning().get(),
    "Failed to update provider.",
  );

  return json(toProviderDTO(updated, providerCounts(ctx.db, id, ctx.now)));
}

export function deleteProvider(ctx: AdminCtx): Response {
  const id = Number(ctx.params[0]);
  findProvider(ctx.db, id);
  ctx.db.delete(providers).where(eq(providers.id, id)).run();
  return json({ ok: true });
}

export function getProvider(ctx: AdminCtx): Response {
  return json(getProviderDetail(ctx.db, Number(ctx.params[0]), ctx.now));
}

export async function createProviderKey(ctx: AdminCtx): Promise<Response> {
  const id = Number(ctx.params[0]);
  findProvider(ctx.db, id);
  const body = asRecord(await readJson(ctx.req));
  const label = asString(body.label, "label", { min: 1, max: 64 });
  const secret = asString(body.secret, "secret", { min: 1, max: 5000 });

  const inserted = expectRow(
    ctx.db
      .insert(providerKeys)
      .values({
        providerId: id,
        label,
        secret,
        keyPreview: `…${secret.slice(-4)}`,
        enabled: true,
        cooldownUntil: null,
        lastError: null,
        lastErrorAt: null,
        lastUsedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning()
      .get(),
    "Failed to create provider key.",
  );

  return json(toProviderKeyDTO(inserted, ctx.now), 201);
}

export async function updateProviderKey(ctx: AdminCtx): Promise<Response> {
  const key = findProviderKey(ctx.db, Number(ctx.params[0]));
  const body = asRecord(await readJson(ctx.req));

  const patch: Partial<typeof providerKeys.$inferInsert> = { updatedAt: ctx.now };
  if (body.label !== undefined) patch.label = asString(body.label, "label", { min: 1, max: 64 });
  if (body.enabled !== undefined) patch.enabled = asBool(body.enabled, "enabled");
  if (body.secret !== undefined) {
    const secret = asString(body.secret, "secret", { min: 1, max: 5000 });
    patch.secret = secret;
    patch.keyPreview = `…${secret.slice(-4)}`;
    patch.cooldownUntil = null;
    patch.lastError = null;
    patch.lastErrorAt = null;
  }

  const updated = expectRow(
    ctx.db.update(providerKeys).set(patch).where(eq(providerKeys.id, key.id)).returning().get(),
    "Failed to update provider key.",
  );

  return json(toProviderKeyDTO(updated, ctx.now));
}

export function deleteProviderKey(ctx: AdminCtx): Response {
  const key = findProviderKey(ctx.db, Number(ctx.params[0]));
  ctx.db.delete(providerKeys).where(eq(providerKeys.id, key.id)).run();
  return json({ ok: true });
}

export function resetProviderKey(ctx: AdminCtx): Response {
  const key = findProviderKey(ctx.db, Number(ctx.params[0]));
  const updated = expectRow(
    ctx.db
      .update(providerKeys)
      .set({ cooldownUntil: null, lastError: null, lastErrorAt: null, updatedAt: ctx.now })
      .where(eq(providerKeys.id, key.id))
      .returning()
      .get(),
    "Failed to reset provider key.",
  );
  return json(toProviderKeyDTO(updated, ctx.now));
}
