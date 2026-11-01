import { serve } from "bun";
import index from "../index.html";
import { createDb } from "./db.ts";
import { handleAdmin } from "./admin/router.ts";
import { handleProxy } from "./proxy/handler.ts";
import { handleStats } from "./stats.ts";

export type CreateAppOptions = {
  port?: number;
  dbPath?: string;
  adminToken?: string;
  development?: boolean;
};

export function createApp(options: CreateAppOptions = {}) {
  const dbPath = options.dbPath ?? "./data/brokey.db";
  const adminToken = options.adminToken ?? "";
  const development = options.development ?? false;

  const db = createDb(dbPath);
  const raw = db.$client;

  const server = serve({
    port: options.port ?? 3000,
    // Proxied bodies are buffered once for model rewriting and JSON parsing, so
    // cap what a client key can make the process hold (Bun's default is 128 MiB).
    maxRequestBodySize: 16 * 1024 * 1024,
    development: development ? { hmr: true, console: true } : false,
    routes: {
      "/api/health": () => Response.json({ ok: true }),
      "/api/stats": (req) => handleStats(req, db),
      "/api/admin/*": (req) =>
        handleAdmin(req, new URL(req.url), db, adminToken),
      "/v1/*": (req) => handleProxy(req, { db }),
      // Bun's HTML bundle route cannot carry custom response headers, so
      // framing is blocked from `src/index.html` instead.
      "/admin": index,
      "/admin/*": index,
      "/*": index,
    },
  });

  const stop = () => {
    server.stop(true);
    if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:"))
      raw.close();
  };

  return { server, db, raw, stop };
}
