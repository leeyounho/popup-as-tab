import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");
const files = ["manifest.json", "popup.html", "popup.css", "popup.js"];
const icons = ["icon16.png", "icon32.png", "icon48.png", "icon128-sized.png"];

await mkdir(outputDirectory, { recursive: true });
await mkdir(path.join(outputDirectory, "icons"), { recursive: true });
await Promise.all(files.map((file) => copyFile(
  path.join(projectRoot, file),
  path.join(outputDirectory, file),
)));
await Promise.all(icons.map((icon) => copyFile(
  path.join(projectRoot, "icons", icon),
  path.join(outputDirectory, "icons", icon),
)));
