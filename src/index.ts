import { createApp } from "./server/app.ts";
import { loadConfig } from "./server/config.ts";
import { resolve } from "node:path";

const config = loadConfig();
const { server } = createApp({
  port: config.port,
  dbPath: config.dbPath,
  adminToken: config.adminToken,
  development: config.development,
});

console.log(`Server running at ${server.url}`);
console.log(
  `Database: ${config.dbPath === ":memory:" ? ":memory:" : resolve(config.dbPath)}`,
);
if (config.adminToken.trim() === "") {
  console.warn(
    "ADMIN_TOKEN is empty: the admin API is disabled (503). Set ADMIN_TOKEN to manage providers and keys.",
  );
}
