import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { json } from "../errors.ts";
import { usageLogs } from "../schema.ts";
import { queryInt } from "../validate.ts";
import type { UsagePage } from "../../shared/types.ts";
import { toUsageRow } from "./dto.ts";
import type { AdminCtx } from "./context.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

export function listUsage(ctx: AdminCtx): Response {
  const conditions = [];
  const clientKeyId = queryInt(ctx.url, "clientKeyId");
  if (clientKeyId !== undefined)
    conditions.push(eq(usageLogs.clientKeyId, clientKeyId));
  const providerId = queryInt(ctx.url, "providerId");
  if (providerId !== undefined)
    conditions.push(eq(usageLogs.providerId, providerId));
  const modelId = queryInt(ctx.url, "modelId");
  if (modelId !== undefined) conditions.push(eq(usageLogs.modelId, modelId));

  const status = ctx.url.searchParams.get("status");
  if (status === "success") conditions.push(lt(usageLogs.status, 400));
  else if (status === "error") conditions.push(gte(usageLogs.status, 400));

  const from = intParam(ctx.url, "from");
  if (from !== undefined) conditions.push(gte(usageLogs.createdAt, from));
  const to = intParam(ctx.url, "to");
  if (to !== undefined) conditions.push(lte(usageLogs.createdAt, to));

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, intParam(ctx.url, "pageSize") ?? DEFAULT_PAGE_SIZE),
  );
  const page = Math.max(0, intParam(ctx.url, "page") ?? 0);
  const where = conditions.length > 0 ? and(...conditions) : sql`1 = 1`;

  const total = Number(
    ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(usageLogs)
      .where(where)
      .get()?.count ?? 0,
  );
  const rows = ctx.db
    .select()
    .from(usageLogs)
    .where(where)
    .orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
    .limit(pageSize)
    .offset(page * pageSize)
    .all();

  const result: UsagePage = {
    rows: rows.map(toUsageRow),
    total,
    page,
    pageSize,
  };
  return json(result);
}
