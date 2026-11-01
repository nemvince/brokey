export type AppConfig = {
  port: number;
  dbPath: string;
  adminToken: string;
  development: boolean;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const port = Number(env.PORT ?? 3000);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    dbPath: env.DATABASE_PATH ?? "./data/brokey.db",
    adminToken: env.ADMIN_TOKEN ?? "",
    development: env.NODE_ENV !== "production",
  };
}
