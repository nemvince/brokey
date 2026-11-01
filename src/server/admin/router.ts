import { json, toResponse } from "../errors.ts";
import type { AppDb } from "../db.ts";
import { assertAdmin } from "../auth.ts";
import type { AdminCtx } from "./context.ts";
import {
  createProvider,
  createProviderKey,
  deleteProvider,
  deleteProviderKey,
  getProvider,
  listProviders,
  resetProviderKey,
  updateProvider,
  updateProviderKey,
} from "./providers.ts";
import {
  applyModels,
  createModel,
  deleteModel,
  fetchModels,
  listModels,
  updateModel,
} from "./models.ts";
import {
  createClientKey,
  deleteClientKey,
  listClientKeys,
  updateClientKey,
} from "./client-keys.ts";
import { listUsage } from "./usage.ts";

type Handler = (ctx: AdminCtx) => Response | Promise<Response>;

type Route = { method: string; pattern: RegExp; handler: Handler };

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/admin\/me$/,
    handler: () => json({ ok: true }),
  },

  {
    method: "GET",
    pattern: /^\/api\/admin\/providers$/,
    handler: listProviders,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/providers$/,
    handler: createProvider,
  },
  {
    method: "GET",
    pattern: /^\/api\/admin\/providers\/(\d+)$/,
    handler: getProvider,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/admin\/providers\/(\d+)$/,
    handler: updateProvider,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/providers\/(\d+)$/,
    handler: deleteProvider,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/providers\/(\d+)\/keys$/,
    handler: createProviderKey,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/providers\/(\d+)\/models\/fetch$/,
    handler: fetchModels,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/providers\/(\d+)\/models\/apply$/,
    handler: applyModels,
  },

  {
    method: "PATCH",
    pattern: /^\/api\/admin\/provider-keys\/(\d+)$/,
    handler: updateProviderKey,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/provider-keys\/(\d+)$/,
    handler: deleteProviderKey,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/provider-keys\/(\d+)\/reset$/,
    handler: resetProviderKey,
  },

  { method: "GET", pattern: /^\/api\/admin\/models$/, handler: listModels },
  { method: "POST", pattern: /^\/api\/admin\/models$/, handler: createModel },
  {
    method: "PATCH",
    pattern: /^\/api\/admin\/models\/(\d+)$/,
    handler: updateModel,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/models\/(\d+)$/,
    handler: deleteModel,
  },

  {
    method: "GET",
    pattern: /^\/api\/admin\/client-keys$/,
    handler: listClientKeys,
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/client-keys$/,
    handler: createClientKey,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/admin\/client-keys\/(\d+)$/,
    handler: updateClientKey,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/client-keys\/(\d+)$/,
    handler: deleteClientKey,
  },

  { method: "GET", pattern: /^\/api\/admin\/usage$/, handler: listUsage },
];

export async function handleAdmin(
  req: Request,
  url: URL,
  db: AppDb,
  adminToken: string,
): Promise<Response> {
  const auth = assertAdmin(req, adminToken);
  if (!auth.ok) return auth.response;

  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const ctx: AdminCtx = {
      req,
      url,
      db,
      params: match.slice(1),
      now: Date.now(),
    };
    try {
      return await route.handler(ctx);
    } catch (error) {
      return toResponse(error);
    }
  }

  return json(
    { error: { message: `No admin route for ${req.method} ${path}.` } },
    404,
  );
}
