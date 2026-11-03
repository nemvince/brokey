import type { AppDb } from "../db.ts";
import type { OpenCodeRuntime } from "../proxy/opencode/runtime.ts";

export type AdminCtx = {
  req: Request;
  url: URL;
  db: AppDb;
  opencode: OpenCodeRuntime;
  params: string[];
  now: number;
};
