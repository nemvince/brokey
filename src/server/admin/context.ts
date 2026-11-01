import type { AppDb } from "../db.ts";

export type AdminCtx = {
  req: Request;
  url: URL;
  db: AppDb;
  params: string[];
  now: number;
};
