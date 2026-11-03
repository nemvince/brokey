import { asc, eq } from "drizzle-orm";
import { HttpError, expectRow, json, readJson } from "../errors.ts";
import { models, providers } from "../schema.ts";
import {
  asBool,
  asOptionalInt,
  asOptionalString,
  asRecord,
  asString,
  queryInt,
} from "../validate.ts";
import type { ModelDTO, SyncApplyBody, SyncField } from "../../shared/types.ts";
import { toModelDTO } from "./dto.ts";
import { findProvider, getProviderDetail } from "./providers.ts";
import type { AdminCtx } from "./context.ts";
import {
  applySync,
  buildPreview,
  fetchUpstreamModels,
  sanitizePublicId,
  validatePublicId,
} from "../proxy/models-sync.ts";

const MAX_OUTPUT_LIMIT = 10_000_000;
const SYNC_FIELDS: readonly SyncField[] = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
];

function modelRowsForList(ctx: AdminCtx, providerId?: number): ModelDTO[] {
  const base = ctx.db
    .select({ model: models, providerName: providers.name })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id));
  const rows =
    providerId === undefined
      ? base.orderBy(asc(models.publicId)).all()
      : base
          .where(eq(models.providerId, providerId))
          .orderBy(asc(models.publicId))
          .all();
  return rows.map((row) => toModelDTO(row.model, row.providerName));
}

export function listModels(ctx: AdminCtx): Response {
  return json({
    models: modelRowsForList(ctx, queryInt(ctx.url, "providerId")),
  });
}

function validateUpstreamId(value: unknown): string {
  return asString(value, "upstreamId", { min: 1, max: 200 });
}

function publicIdIsTaken(
  ctx: AdminCtx,
  publicId: string,
  exceptId?: number,
): boolean {
  const rows = ctx.db
    .select({ id: models.id })
    .from(models)
    .where(eq(models.publicId, publicId))
    .all();
  return rows.some((row) => row.id !== exceptId);
}

export async function createModel(ctx: AdminCtx): Promise<Response> {
  const body = asRecord(await readJson(ctx.req));
  const providerId = Number(body.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) {
    throw new HttpError(400, '"providerId" must be a positive integer.');
  }
  const provider = findProvider(ctx.db, providerId);
  const upstreamId = validateUpstreamId(body.upstreamId);
  if (provider.kind === "opencode") {
    // The catalog is the authority on what the free tier serves; a model it
    // does not list is allowed (the fetch may simply have failed).
    await ctx.opencode.loadCatalog();
    const verdict = ctx.opencode.verdict(upstreamId);
    if (verdict === "deprecated")
      throw new HttpError(
        404,
        `Model "${upstreamId}" has been retired upstream.`,
      );
    if (verdict === "paid")
      throw new HttpError(
        400,
        `Model "${upstreamId}" is not on the OpenCode free tier.`,
      );
  }

  const requestedPublicId = asOptionalString(body.publicId, "publicId", {
    min: 1,
    max: 128,
  });
  const publicId =
    requestedPublicId === undefined || requestedPublicId === null
      ? sanitizePublicId(upstreamId)
      : validatePublicId(requestedPublicId);
  if (publicId === "") {
    throw new HttpError(
      400,
      '"upstreamId" cannot be turned into a public ID; set "publicId" explicitly.',
    );
  }
  if (publicIdIsTaken(ctx, publicId)) {
    throw new HttpError(
      409,
      `Public ID "${publicId}" is already in use by another model.`,
    );
  }

  const displayName =
    asOptionalString(body.displayName, "displayName", { min: 1, max: 128 }) ??
    publicId;
  const enabled =
    body.enabled === undefined ? true : asBool(body.enabled, "enabled");
  const contextWindow = asOptionalInt(body.contextWindow, "contextWindow", {
    min: 0,
  });
  const maxOutputTokens = asOptionalInt(
    body.maxOutputTokens,
    "maxOutputTokens",
    {
      min: 0,
      max: MAX_OUTPUT_LIMIT,
    },
  );
  const notes = asOptionalString(body.notes, "notes", { max: 2000 });

  const inserted = expectRow(
    ctx.db
      .insert(models)
      .values({
        providerId,
        upstreamId,
        publicId,
        displayName,
        enabled,
        contextWindow: contextWindow ?? null,
        maxOutputTokens: maxOutputTokens ?? null,
        notes: notes ?? null,
        upstreamCreatedAt: null,
        upstreamOwnedBy: null,
        upstreamAvailable: true,
        syncedDisplayName: null,
        syncedContextWindow: null,
        syncedMaxOutputTokens: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning()
      .get(),
    "Failed to create model.",
  );

  return json(toModelDTO(inserted, provider.name), 201);
}

export async function updateModel(ctx: AdminCtx): Promise<Response> {
  const id = Number(ctx.params[0]);
  const existing = ctx.db.select().from(models).where(eq(models.id, id)).get();
  if (!existing) throw new HttpError(404, "Model not found.");
  const body = asRecord(await readJson(ctx.req));

  const patch: Partial<typeof models.$inferInsert> = { updatedAt: ctx.now };
  if (body.publicId !== undefined) {
    const publicId = validatePublicId(
      asString(body.publicId, "publicId", { min: 1, max: 128 }),
    );
    if (publicIdIsTaken(ctx, publicId, id)) {
      throw new HttpError(
        409,
        `Public ID "${publicId}" is already in use by another model.`,
      );
    }
    patch.publicId = publicId;
  }
  if (body.upstreamId !== undefined)
    patch.upstreamId = validateUpstreamId(body.upstreamId);
  if (body.displayName !== undefined) {
    patch.displayName = asString(body.displayName, "displayName", {
      min: 1,
      max: 128,
    });
  }
  if (body.enabled !== undefined)
    patch.enabled = asBool(body.enabled, "enabled");
  if (body.contextWindow !== undefined) {
    patch.contextWindow =
      asOptionalInt(body.contextWindow, "contextWindow", { min: 0 }) ?? null;
  }
  if (body.maxOutputTokens !== undefined) {
    patch.maxOutputTokens =
      asOptionalInt(body.maxOutputTokens, "maxOutputTokens", {
        min: 0,
        max: MAX_OUTPUT_LIMIT,
      }) ?? null;
  }
  if (body.notes !== undefined) {
    patch.notes = asOptionalString(body.notes, "notes", { max: 2000 }) ?? null;
  }

  const updated = expectRow(
    ctx.db.update(models).set(patch).where(eq(models.id, id)).returning().get(),
    "Failed to update model.",
  );
  const provider = findProvider(ctx.db, updated.providerId);
  return json(toModelDTO(updated, provider.name));
}

export function deleteModel(ctx: AdminCtx): Response {
  const id = Number(ctx.params[0]);
  const existing = ctx.db
    .select({ id: models.id })
    .from(models)
    .where(eq(models.id, id))
    .get();
  if (!existing) throw new HttpError(404, "Model not found.");
  ctx.db.delete(models).where(eq(models.id, id)).run();
  return json({ ok: true });
}

export async function fetchModels(ctx: AdminCtx): Promise<Response> {
  const provider = findProvider(ctx.db, Number(ctx.params[0]));
  const upstream = await fetchUpstreamModels(
    provider,
    ctx.db,
    ctx.now,
    ctx.opencode,
  );
  return json(buildPreview(ctx.db, provider, upstream, ctx.now));
}

function parseApplyBody(body: unknown): SyncApplyBody {
  const record = asRecord(body);
  const result: SyncApplyBody = { added: [], missing: [], resolutions: [] };

  if (record.added !== undefined) {
    if (!Array.isArray(record.added))
      throw new HttpError(400, '"added" must be an array.');
    result.added = record.added.map((entry) => {
      const item = asRecord(entry);
      if (
        typeof item.upstreamId !== "string" ||
        item.upstreamId.trim() === ""
      ) {
        throw new HttpError(
          400,
          '"added[].upstreamId" must be a non-empty string.',
        );
      }
      if (typeof item.publicId !== "string" || item.publicId.trim() === "") {
        throw new HttpError(
          400,
          '"added[].publicId" must be a non-empty string.',
        );
      }
      return {
        upstreamId: item.upstreamId.trim(),
        publicId: item.publicId.trim(),
      };
    });
  }

  if (record.missing !== undefined) {
    if (!Array.isArray(record.missing))
      throw new HttpError(400, '"missing" must be an array.');
    result.missing = record.missing.map((entry) => {
      const item = asRecord(entry);
      const action = item.action;
      if (action !== "keep" && action !== "disable" && action !== "delete") {
        throw new HttpError(
          400,
          '"missing[].action" must be keep, disable, or delete.',
        );
      }
      const modelId = Number(item.modelId);
      if (!Number.isInteger(modelId) || modelId <= 0) {
        throw new HttpError(
          400,
          '"missing[].modelId" must be a positive integer.',
        );
      }
      return { modelId, action };
    });
  }

  if (record.resolutions !== undefined) {
    if (!Array.isArray(record.resolutions)) {
      throw new HttpError(400, '"resolutions" must be an array.');
    }
    result.resolutions = record.resolutions.map((entry) => {
      const item = asRecord(entry);
      const field = item.field;
      if (!SYNC_FIELDS.includes(field as SyncField)) {
        throw new HttpError(
          400,
          `"resolutions[].field" must be one of ${SYNC_FIELDS.join(", ")}.`,
        );
      }
      const choice = item.choice;
      if (choice !== "local" && choice !== "upstream") {
        throw new HttpError(
          400,
          '"resolutions[].choice" must be local or upstream.',
        );
      }
      const modelId = Number(item.modelId);
      if (!Number.isInteger(modelId) || modelId <= 0) {
        throw new HttpError(
          400,
          '"resolutions[].modelId" must be a positive integer.',
        );
      }
      return { modelId, field: field as SyncField, choice };
    });
  }

  return result;
}

export async function applyModels(ctx: AdminCtx): Promise<Response> {
  const provider = findProvider(ctx.db, Number(ctx.params[0]));
  const body = parseApplyBody(await readJson(ctx.req));
  const upstream = await fetchUpstreamModels(
    provider,
    ctx.db,
    ctx.now,
    ctx.opencode,
  );
  applySync(ctx.db, provider, body, upstream, ctx.now);
  return json(getProviderDetail(ctx.db, provider.id, ctx.now, ctx.opencode));
}
