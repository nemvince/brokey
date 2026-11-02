import pkg from "../../package.json";

/** Baked into the frontend bundle at build time from `package.json`. */
export const APP_VERSION: string = pkg.version;
