export type OpenCodeConfig = {
  /** The model catalog the real OpenCode client reads at boot. */
  catalogUrl: string;
  /** Update handshake the OpenCode CLI polls; yields the live release version. */
  updateApiBase: string;
  /** Raw GitHub root for the release the handshake points at. */
  sourceBase: string;
  /** Fallback release feed when the update API is unreachable. */
  atomUrl: string;
  channel: string;
  /** Pins the identity when set: derivation is disabled entirely. */
  userAgent: string | null;
  /** Pins the inference endpoint instead of deriving it from the catalog. */
  chatUrl: string | null;
  /** `always` adopts every release; `reactive` waits for a gate rejection. */
  updateMode: "reactive" | "always";
};

export type AppConfig = {
  port: number;
  dbPath: string;
  adminToken: string;
  development: boolean;
  opencode: OpenCodeConfig;
};

export function defaultOpenCodeConfig(): OpenCodeConfig {
  return {
    catalogUrl: "https://models.opencode.ai/api.json",
    updateApiBase: "https://opencode.ai/update/api",
    sourceBase: "https://raw.githubusercontent.com/anomalyco/opencode",
    atomUrl: "https://github.com/anomalyco/opencode/releases.atom",
    channel: "latest",
    userAgent: null,
    chatUrl: null,
    updateMode: "reactive",
  };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const port = Number(env.PORT ?? 3000);
  const defaults = defaultOpenCodeConfig();
  const setting = (name: string) => (env[name] ?? "").trim();
  const updateMode = setting("BROKEY_OPENCODE_UPDATE_MODE");
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    dbPath: env.DATABASE_PATH ?? "./data/brokey.db",
    adminToken: env.ADMIN_TOKEN ?? "",
    development: env.NODE_ENV !== "production",
    opencode: {
      catalogUrl: setting("BROKEY_OPENCODE_CATALOG_URL") || defaults.catalogUrl,
      updateApiBase: (
        setting("BROKEY_OPENCODE_UPDATE_API") || defaults.updateApiBase
      ).replace(/\/+$/, ""),
      sourceBase: (
        setting("BROKEY_OPENCODE_SOURCE_BASE") || defaults.sourceBase
      ).replace(/\/+$/, ""),
      atomUrl: setting("BROKEY_OPENCODE_ATOM_URL") || defaults.atomUrl,
      channel: setting("BROKEY_OPENCODE_CHANNEL") || defaults.channel,
      // An empty pin means "derive it": only a non-empty value disables sync.
      userAgent: setting("BROKEY_OPENCODE_USER_AGENT") || null,
      chatUrl:
        (setting("BROKEY_OPENCODE_CHAT_URL") || "").replace(/\/+$/, "") || null,
      updateMode: updateMode === "always" ? "always" : "reactive",
    },
  };
}
