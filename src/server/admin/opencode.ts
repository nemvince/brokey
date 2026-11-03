import { HttpError, json, readJson } from "../errors.ts";
import type { ProviderRow } from "../schema.ts";
import { asRecord } from "../validate.ts";
import type {
  EgressEntryUpdate,
  EgressPoolUpdate,
} from "../../shared/types.ts";
import type { AdminCtx } from "./context.ts";
import { findProvider } from "./providers.ts";

/** The provider a route addressed, refused unless it is the free-tier kind. */
function openCodeProvider(ctx: AdminCtx): ProviderRow {
  const provider = findProvider(ctx.db, Number(ctx.params[0]));
  if (provider.kind !== "opencode")
    throw new HttpError(400, "Provider is not an OpenCode free provider.");
  return provider;
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new HttpError(400, `"${field}" must be a string.`);
  if (value.length > max)
    throw new HttpError(400, `"${field}" must be at most ${max} characters.`);
  return value;
}

function parseEntries(value: unknown): EgressEntryUpdate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new HttpError(400, '"entries" must be an array.');
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const update: EgressEntryUpdate = {};
    const id = optionalString(record.id, `entries[${index}].id`, 32);
    const label = optionalString(record.label, `entries[${index}].label`, 64);
    const url = optionalString(record.url, `entries[${index}].url`, 500);
    if (id !== undefined) update.id = id;
    if (label !== undefined) update.label = label;
    if (url !== undefined) update.url = url;
    if (record.enabled !== undefined) {
      if (typeof record.enabled !== "boolean")
        throw new HttpError(
          400,
          `"entries[${index}].enabled" must be a boolean.`,
        );
      update.enabled = record.enabled;
    }
    if (record.weight !== undefined) {
      if (typeof record.weight !== "number")
        throw new HttpError(
          400,
          `"entries[${index}].weight" must be a number.`,
        );
      update.weight = record.weight;
    }
    return update;
  });
}

export function getEgress(ctx: AdminCtx): Response {
  const provider = openCodeProvider(ctx);
  return json(ctx.opencode.egressPool(ctx.db, provider.id, ctx.now));
}

export async function saveEgress(ctx: AdminCtx): Promise<Response> {
  const provider = openCodeProvider(ctx);
  const body = asRecord(await readJson(ctx.req));
  const update: EgressPoolUpdate = {};
  if (body.strategy !== undefined) {
    if (typeof body.strategy !== "string")
      throw new HttpError(400, '"strategy" must be a string.');
    update.strategy = body.strategy as EgressPoolUpdate["strategy"];
  }
  if (body.relayUrl !== undefined) {
    if (body.relayUrl !== null && typeof body.relayUrl !== "string")
      throw new HttpError(400, '"relayUrl" must be a string or null.');
    update.relayUrl = body.relayUrl;
  }
  const entries = parseEntries(body.entries);
  if (entries !== undefined) update.entries = entries;
  return json({
    ok: true,
    egress: ctx.opencode.saveEgressPool(ctx.db, provider.id, update),
  });
}

export async function testEgress(ctx: AdminCtx): Promise<Response> {
  const provider = openCodeProvider(ctx);
  return json({ results: await ctx.opencode.testEgress(ctx.db, provider.id) });
}

/**
 * Refresh the derived identity. Always 200: a failed refresh is state the
 * operator needs to see, not an exception.
 */
export async function refreshIdentity(ctx: AdminCtx): Promise<Response> {
  const provider = openCodeProvider(ctx);
  await ctx.opencode.refresh(true);
  return json({
    identity: ctx.opencode.identity(),
    gate: ctx.opencode.gate(provider.id),
  });
}
