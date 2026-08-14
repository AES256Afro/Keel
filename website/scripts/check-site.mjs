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
  const textual = /\.(?:html|css|js|svg|txt|xml)$/i.test(file);

  if (textual) {
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
  }

  if (!file.endsWith(".html")) continue;
  if (text.includes('href="/assets/styles.css"')) {
    errors.push(`${relative}: stylesheet URL is not cache-versioned`);
  }
  for (const required of ["<title>", "name=\"description\"", "name=\"viewport\""]) {
    if (!text.includes(required)) errors.push(`${relative}: missing ${required}`);
  }
  if (text.includes('property="og:image"')) {
    for (const required of [
      'property="og:image:width" content="1200"',
      'property="og:image:height" content="630"',
      'property="og:image:alt"',
      'name="twitter:card" content="summary_large_image"',
      'name="twitter:image" content="https://keelnotes.com/keel-notes-sailboat-foundation.png"',
    ]) {
      if (!text.includes(required)) errors.push(`${relative}: incomplete social preview metadata (${required})`);
    }
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
const ogBytes = fs.readFileSync(path.join(root, "keel-notes-sailboat-foundation.png"));
if (
  ogBytes.subarray(1, 4).toString("ascii") !== "PNG" ||
  ogBytes.readUInt32BE(16) !== 1200 ||
  ogBytes.readUInt32BE(20) !== 630
) {
  errors.push("keel-notes-sailboat-foundation.png must be a 1200x630 PNG for reliable link previews");
}
for (const screenshot of ["keel-editor.png", "keel-board.png", "keel-graph.png"]) {
  const screenshotPath = path.join(root, "assets", "screenshots", screenshot);
  if (!fs.existsSync(screenshotPath)) {
    errors.push(`assets/screenshots/${screenshot}: missing real-product screenshot`);
    continue;
  }
  const screenshotBytes = fs.readFileSync(screenshotPath);
  if (
    screenshotBytes.subarray(1, 4).toString("ascii") !== "PNG" ||
    screenshotBytes.readUInt32BE(16) !== 1440 ||
    screenshotBytes.readUInt32BE(20) !== 900
  ) {
    errors.push(`assets/screenshots/${screenshot}: must be a 1440x900 PNG`);
  }
}
const homeSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "assets", "styles.css"), "utf8");
if (!/\.nav-links \.button\s*\{[^}]*background:\s*var\(--blue-dark\);[^}]*color:\s*var\(--white\);/s.test(stylesSource)) {
  errors.push("styles.css: the header Get Keel button must keep its bright accessible treatment");
}
if (!/\.feature-card:nth-child\(5\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/.test(stylesSource)) {
  errors.push("styles.css: feature card 05 must span the full grid instead of collapsing to one column");
}
if (!/class="button button-small"[^>]*>Get Keel 1\.2\.5<\/a>/.test(homeSource)) {
  errors.push("index.html: missing the styled Get Keel header action");
}
const leadImageIndex = homeSource.indexOf('src="/keel-notes-sailboat-foundation.png"');
for (const screenshot of ["keel-editor.png", "keel-board.png", "keel-graph.png"]) {
  const screenshotIndex = homeSource.indexOf(`src="/assets/screenshots/${screenshot}"`);
  if (screenshotIndex === -1) {
    errors.push(`index.html: missing ${screenshot} from the product gallery`);
  } else if (leadImageIndex === -1 || screenshotIndex < leadImageIndex) {
    errors.push(`index.html: the combined sailboat must appear before ${screenshot}`);
  }
}
if (homeSource.includes('src="/assets/keel-notes-workspace.png"')) {
  errors.push("index.html: the former split hero artwork is still rendered");
}
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
const oldPreviewRedirect = await worker.fetch(
  new Request("https://keelnotes.com/og.png"),
  { ASSETS: redirectOnlyAssets }
);
if (
  oldPreviewRedirect.status !== 301 ||
  oldPreviewRedirect.headers.get("location") !==
    "https://keelnotes.com/keel-notes-sailboat-foundation.png"
) {
  errors.push("worker.js: the former social image URL does not redirect to the sailboat");
}
const previousSailboatRedirect = await worker.fetch(
  new Request("https://keelnotes.com/keel-notes-sailboat.png"),
  { ASSETS: redirectOnlyAssets }
);
if (
  previousSailboatRedirect.status !== 301 ||
  previousSailboatRedirect.headers.get("location") !==
    "https://keelnotes.com/keel-notes-sailboat-foundation.png"
) {
  errors.push("worker.js: the previous social image URL does not redirect to the combined artwork");
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
