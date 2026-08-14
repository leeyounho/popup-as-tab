import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");
const expectedFiles = [
  "background.js",
  "icons/icon128-sized.png",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
].sort();

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  }));
  return nested.flat();
}

const manifest = JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (manifest.version !== packageJson.version) {
  throw new Error("Manifest and package versions differ.");
}

const requiredManifestFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);
for (const file of requiredManifestFiles) {
  if (!await exists(path.join(outputDirectory, file))) {
    throw new Error("Missing manifest entry: " + file);
  }
}

const popupHtml = await readFile(path.join(outputDirectory, "popup.html"), "utf8");
const references = [...popupHtml.matchAll(/(?:src|href)="([^"#?]+)"/g)]
  .map((match) => match[1]);
for (const reference of references) {
  if (/^(?:https?:|data:|\/\/)/.test(reference)) continue;
  if (!await exists(path.resolve(outputDirectory, reference))) {
    throw new Error("popup.html references missing file " + reference);
  }
}

const actualFiles = (await filesIn(outputDirectory))
  .map((file) => path.relative(outputDirectory, file).replaceAll(path.sep, "/"))
  .sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Unexpected dist contents:\n" + actualFiles.join("\n"));
}

console.log("Validated " + actualFiles.length + " deployment files in dist.");
