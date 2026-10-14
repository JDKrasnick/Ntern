import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = (message) => {
  console.error(`Release check failed: ${message}`);
  process.exitCode = 1;
};
const app = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
).expo;
const eas = JSON.parse(
  readFileSync(new URL("../eas.json", import.meta.url), "utf8"),
);
const profiles = eas.build ?? {};

const expectedProfiles = {
  development: {
    environment: "development",
    distribution: "internal",
    developmentClient: true,
  },
  preview: { environment: "preview", distribution: "internal" },
  testflight: {
    environment: "production",
    distribution: "store",
    autoIncrement: true,
  },
  production: {
    environment: "production",
    distribution: "store",
    autoIncrement: true,
  },
};
for (const [name, expected] of Object.entries(expectedProfiles)) {
  const actual = profiles[name];
  if (!actual) {
    fail(`missing EAS build profile: ${name}`);
    continue;
  }
  for (const [key, value] of Object.entries(expected))
    if (actual[key] !== value)
      fail(`${name}.${key} must be ${JSON.stringify(value)}`);
}
if (eas.cli?.appVersionSource !== "remote")
  fail("EAS must use remote app versioning");
if (!app.extra?.eas?.projectId) fail("missing stable EAS project ID");
for (const asset of ["assets/icon.png", "assets/splash-icon.png"])
  if (!existsSync(new URL(`../${asset}`, import.meta.url)))
    fail(`missing ${asset}`);
const splash = app.plugins?.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
);
if (!app.icon || !splash)
  fail("icon and expo-splash-screen configuration are required");

const requiredUrls = [
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_PRIVACY_URL",
  "EXPO_PUBLIC_TERMS_URL",
  "EXPO_PUBLIC_RETENTION_URL",
  "EXPO_PUBLIC_SOURCE_POLICY_URL",
  "EXPO_PUBLIC_SUPPORT_URL",
];
for (const name of requiredUrls) {
  const value = process.env[name];
  if (!value || !/^https:\/\//.test(value))
    fail(`${name} must be a public HTTPS URL`);
}
const nativePrivacyPath = new URL(
  "../ios/InternNotifs/PrivacyInfo.xcprivacy", import.meta.url,
);
if (!existsSync(nativePrivacyPath)) {
  fail("missing native privacy manifest");
} else if (!readFileSync(nativePrivacyPath, "utf8").includes(
  "<string>NSPrivacyCollectedDataTypeEmailsOrTextMessages</string>",
)) {
  fail("native privacy manifest must disclose optional Gmail email data");
}
if (!process.exitCode) {
  await Promise.all(requiredUrls.filter(name => name !== "EXPO_PUBLIC_API_URL").map(async name => {
    try {
      const response = await fetch(process.env[name], {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok || !response.url.startsWith("https://") ||
          !response.headers.get("content-type")?.includes("text/html")) {
        fail(`${name} must load a public HTTPS policy page (HTTP ${response.status})`);
        await response.body?.cancel();
        return;
      }
      const page = await response.text();
      if (name === "EXPO_PUBLIC_SUPPORT_URL" &&
          !/id=["']delete-account["']/.test(page)) {
        fail("support page must include the public account-deletion path");
      }
    } catch {
      fail(`${name} public page could not be verified`);
    }
  }));
}
if (!process.exitCode) {
  for (const [command, args] of [
    ["npm", ["run", "typecheck"]],
    ["npx", ["expo", "config", "--type", "public"]],
  ]) {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log("Release configuration is valid.");
}
