import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "..");
const outputDirectory = resolve(mobileRoot, "dist");
const publicApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim()
  || "https://intern-notifs.jdkrasnick.workers.dev";
const approvedApiOrigins = new Set([
  "https://intern-notifs.jdkrasnick.workers.dev",
  "https://intern-notifs-dev.jdkrasnick.workers.dev",
]);
if (!approvedApiOrigins.has(publicApiUrl)) {
  throw new Error(`Web export requires an approved Cloudflare API origin; received ${new URL(publicApiUrl).origin}`);
}
const policyFiles = [
  "policy.css",
  "privacy.html",
  "retention.html",
  "source-policy.html",
  "support.html",
  "terms.html",
];

await rm(outputDirectory, { recursive: true, force: true });
execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["expo", "export", "--clear", "--platform", "web", "--output-dir", outputDirectory],
  {
    cwd: mobileRoot,
    env: { ...process.env, EXPO_PUBLIC_API_URL: publicApiUrl },
    stdio: "inherit",
  },
);

await mkdir(outputDirectory, { recursive: true });
const indexPath = resolve(outputDirectory, "index.html");
const indexHtml = await readFile(indexPath, "utf8");
const favicon = await readFile(resolve(outputDirectory, "favicon.ico"));
const iconVersion = createHash("sha256").update(favicon).digest("hex").slice(0, 12);
const faviconName = `favicon-${iconVersion}.ico`;
await copyFile(resolve(outputDirectory, "favicon.ico"), resolve(outputDirectory, faviconName));
await writeFile(indexPath, indexHtml
  .replace('href="/favicon.ico"', `href="/${faviconName}"`)
  .replace("</head>", `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${iconVersion}" /></head>`));
await Promise.all(policyFiles.map((name) => copyFile(resolve(repositoryRoot, "docs", name), resolve(outputDirectory, name))));

const requiredFiles = ["index.html", "_headers", "favicon.ico", "apple-touch-icon.png", ...policyFiles];
await Promise.all(requiredFiles.map(async (name) => {
  const value = await readFile(resolve(outputDirectory, name));
  if (value.byteLength === 0) throw new Error(`Web export produced an empty ${name}`);
}));

const bundleDirectory = resolve(outputDirectory, "_expo", "static", "js", "web");
const bundles = (await readdir(bundleDirectory)).filter((name) => name.endsWith(".js"));
// Cloudflare Pages does not upload node_modules paths, so expo's
// /assets/node_modules/... font URLs 404 (with nosniff, fonts fail).
// Relocate each emitted asset under /vendor with node_modules segments
// stripped, then rewrite the absolute references to match.
const urlRewrites = new Map();
const collectAssetFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectAssetFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
};
const assetsDirectory = resolve(outputDirectory, "assets");
for (const fullPath of await collectAssetFiles(assetsDirectory)) {
  const relative = fullPath.slice(assetsDirectory.length + 1);
  const flattened = relative.split("/").filter((segment) => segment !== "node_modules").join("/");
  const target = resolve(outputDirectory, "vendor", flattened);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(fullPath, target);
  urlRewrites.set(`/assets/${relative}`, `/vendor/${flattened}`);
}
await rm(assetsDirectory, { recursive: true, force: true });
for (const name of bundles) {
  const bundlePath = resolve(bundleDirectory, name);
  let rewritten = await readFile(bundlePath, "utf8");
  for (const [from, to] of [...urlRewrites.entries()].sort((a, b) => b[0].length - a[0].length)) {
    rewritten = rewritten.replaceAll(from, to);
  }
  await writeFile(bundlePath, rewritten);
}
const bundleText = (await Promise.all(bundles.map((name) => readFile(resolve(bundleDirectory, name), "utf8")))).join("\n");
if (!bundleText.includes(publicApiUrl)) {
  throw new Error(`Web export did not embed the expected API origin ${publicApiUrl}`);
}
if (bundleText.includes('"/assets/') || bundleText.includes("node_modules/")) {
  throw new Error("Web export still references un-uploadable asset URLs");
}

console.log(`Verified deployable web export at ${outputDirectory} using API ${publicApiUrl}`);
