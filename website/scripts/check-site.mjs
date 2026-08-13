import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const website = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.join(website, "public");
const files = [];
const errors = [];
const repositoryRoot = path.resolve(website, "..");
const privatePatternFile = path.join(repositoryRoot, ".keel-private-patterns");
const privateLiterals = [
  ...(fs.existsSync(privatePatternFile)
    ? fs.readFileSync(privatePatternFile, "utf8").split(/\r?\n/)
    : []),
  ...(process.env.KEEL_PRIVATE_PATTERNS ?? "").split(/\r?\n/),
]
  .map((value) => value.trim())
  .filter((value) => value && !value.startsWith("#"));

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}

function localTarget(page, href) {
  const url = new URL(href, `https://keelnotes.com/${path.relative(root, page).replaceAll(path.sep, "/")}`);
  if (url.origin !== "https://keelnotes.com") return null;
  const pathname = decodeURIComponent(url.pathname);
  const cleanPath = pathname.replace(/^\/+/, "");
  if (pathname.endsWith("/")) return path.join(root, cleanPath, "index.html");
  const direct = path.join(root, cleanPath);
  if (path.extname(direct)) return direct;
  return path.join(root, cleanPath, "index.html");
}

walk(root);

for (const file of files) {
  const relative = path.relative(root, file);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");

  if (text.includes("\u2014")) errors.push(`${relative}: contains a Unicode em dash`);
  if (/tail[0-9a-f]{8,}\.ts\.net/i.test(text) || /\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
    errors.push(`${relative}: contains private host metadata`);
  }
  const lowerText = text.toLowerCase();
  for (const literal of privateLiterals) {
    if (lowerText.includes(literal.toLowerCase())) {
      errors.push(`${relative}: contains an operator-supplied private identifier`);
    }
  }

  if (!file.endsWith(".html")) continue;
  for (const required of ["<title>", "name=\"description\"", "name=\"viewport\""]) {
    if (!text.includes(required)) errors.push(`${relative}: missing ${required}`);
  }
  if (/\sstyle="/i.test(text)) errors.push(`${relative}: inline style violates the site CSP`);
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(text)) errors.push(`${relative}: inline script violates the site CSP`);
  const idCounts = new Map();
  for (const match of text.matchAll(/\sid="([^"]+)"/g)) idCounts.set(match[1], (idCounts.get(match[1]) ?? 0) + 1);
  for (const [id, count] of idCounts) if (count > 1) errors.push(`${relative}: duplicate id #${id}`);

  for (const match of text.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1];
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("data:")) continue;
    const target = localTarget(file, href);
    if (target && !fs.existsSync(target)) errors.push(`${relative}: missing local target ${href}`);
  }
}

const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const cssBytes = fs.statSync(path.join(root, "assets", "styles.css")).size;
const jsBytes = fs.statSync(path.join(root, "assets", "site.js")).size;
const workerModuleUrl = new URL("../src/worker.js", import.meta.url);
const workerSource = fs.readFileSync(workerModuleUrl, "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`
);
const redirectOnlyAssets = { fetch: () => Promise.reject(new Error("redirect reached assets")) };
const httpRedirect = await worker.fetch(
  new Request("http://keelnotes.com/install/?from=http"),
  { ASSETS: redirectOnlyAssets }
);
if (
  httpRedirect.status !== 301 ||
  httpRedirect.headers.get("location") !== "https://keelnotes.com/install/?from=http"
) {
  errors.push("worker.js: HTTP requests do not redirect exactly to the HTTPS URL");
}
const wwwRedirect = await worker.fetch(
  new Request("https://www.keelnotes.com/security/?from=www"),
  { ASSETS: redirectOnlyAssets }
);
if (
  wwwRedirect.status !== 301 ||
  wwwRedirect.headers.get("location") !== "https://keelnotes.com/security/?from=www"
) {
  errors.push("worker.js: www requests do not redirect exactly to the HTTPS apex URL");
}
if (cssBytes > 80_000) errors.push(`styles.css exceeds 80 KB (${cssBytes} bytes)`);
if (jsBytes > 20_000) errors.push(`site.js exceeds 20 KB (${jsBytes} bytes)`);

console.log(`Checked ${files.length} site files (${Math.round(totalBytes / 1024)} KB total).`);
console.log(`Shared CSS: ${Math.round(cssBytes / 1024)} KB; shared JS: ${Math.round(jsBytes / 1024)} KB.`);
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log("Site links, required metadata, private-reference guard, and size budgets passed.");
