/**
 * Public production service identifiers. They are intentionally safe to ship
 * in the client; environment values can override them for approved builds.
 */
const productionApiUrl = "https://intern-notifs.jdkrasnick.workers.dev";
/**
 * Company icons alone are served from a custom domain, because Cloudflare's edge
 * cache never populates on `workers.dev` and the icon route leans on it. Every
 * other call stays on the API origin, so cookies, signed URLs, and CORS keep one
 * origin. A dev build keeps its own origin for icons too.
 */
const productionIconApiUrl = "https://api.ntern.app";
const approvedApiOrigins = new Set([
  productionApiUrl,
  "https://intern-notifs-dev.jdkrasnick.workers.dev",
]);
const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "");
const approvedApiUrl = configuredApiUrl && approvedApiOrigins.has(configuredApiUrl) ? configuredApiUrl : undefined;

export const publicConfig = {
  // Local Expo configuration is user-managed. Do not allow a retired endpoint
  // there to silently replace the Cloudflare catalog in a public build.
  apiUrl: approvedApiUrl ?? productionApiUrl,
  iconApiUrl: approvedApiUrl && approvedApiUrl !== productionApiUrl ? approvedApiUrl : productionIconApiUrl,
  /** Public rollout switch; private records remain guarded by the Worker flag. */
  resumeTunerEnabled: process.env.EXPO_PUBLIC_RESUME_TUNER_ENABLED !== "false",
};
