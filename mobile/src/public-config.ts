/**
 * Public production service identifiers. They are intentionally safe to ship
 * in the client; environment values can override them for approved builds.
 */
const productionApiUrl = "https://intern-notifs.jdkrasnick.workers.dev";
const approvedApiOrigins = new Set([
  productionApiUrl,
  "https://intern-notifs-dev.jdkrasnick.workers.dev",
]);
const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "");

export const publicConfig = {
  // Local Expo configuration is user-managed. Do not allow a retired endpoint
  // there to silently replace the Cloudflare catalog in a public build.
  apiUrl: configuredApiUrl && approvedApiOrigins.has(configuredApiUrl)
    ? configuredApiUrl
    : productionApiUrl,
};
