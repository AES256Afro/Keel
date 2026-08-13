#!/usr/bin/env node
// Static browser/API contract checks for owner-managed operator settings.
// Runtime storage behavior is covered by operator-settings-check.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const settingsClient = read("src/components/SettingsClient.tsx");
const panel = read("src/components/OperatorSettingsPanel.tsx");
const route = read("src/app/api/instance/operator-settings/route.ts");
const sameOrigin = read("src/lib/same-origin.ts");
const helper = read("src/lib/instance-settings.ts");
const siteLayout = read("src/app/site/layout.tsx");

let passed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  }
}

console.log("\nOwner operator settings UI and API boundary\n");
check(
  "the panel renders only for the instance owner",
  settingsClient.includes("{isInstanceOwner && <OperatorSettingsPanel />}")
);
check(
  "the panel loads owner state without browser caching",
  panel.includes('fetch("/api/instance/operator-settings", { cache: "no-store" })')
);
check(
  "all writes use the owner-only operator endpoint",
  panel.includes('method: "PATCH"') && panel.includes('fetch("/api/instance/operator-settings"')
);
check(
  "the API requires instance-owner authorization for reads and writes",
  (route.match(/requireInstanceOwner\(\)/g) ?? []).length === 2
);
check(
  "writes require an explicit same-origin browser request",
  route.includes("requireSameOriginMutation(req") &&
    sameOrigin.includes('req.headers.get("origin")') &&
    sameOrigin.includes('req.headers.get("sec-fetch-site") === "cross-site"')
);
check(
  "writes are rate-limited and bounded to 16 KB",
  route.includes('enforceLimit("operator-settings"') &&
    route.includes("16 * 1024") &&
    route.includes("Buffer.byteLength")
);
check(
  "unknown top-level and public-site fields are rejected",
  route.includes("requireExactKeys(body") &&
    helper.includes('"Unknown public-site field"')
);
check(
  "responses are explicitly non-cacheable",
  (route.match(/"Cache-Control": "no-store"/g) ?? []).length === 2
);
check(
  "audit entries record only operation and field names",
  route.includes('detail: { operation: "save", fields: Object.keys(fields) }') &&
    route.includes('detail: { operation: "save", configured: true }') &&
    !route.includes("detail: { passphrase")
);
check(
  "the scheduled-backup input is write-only and never prefilled",
  /type="password"[\s\S]{0,500}autoComplete="new-password"/.test(panel) &&
    panel.includes("never sends it back") &&
    !panel.includes("value={settings.backupPassphrase")
);
check(
  "replacement and clear operations require confirmation",
  panel.includes("Replace the managed scheduled-backup passphrase?") &&
    panel.includes("Clear the managed scheduled-backup passphrase?") &&
    panel.includes('action: "clear", confirm: true')
);
check(
  "environment overrides are clearly locked per field",
  panel.includes("Locked by KEEL_SITE_NAME") &&
    panel.includes("Locked by KEEL_SITE_TAGLINE") &&
    panel.includes("Locked by KEEL_NOTES_URL") &&
    panel.includes("Configured and locked by KEEL_BACKUP_PASSPHRASE")
);
check(
  "the effective summary promises redaction and provides no mutation controls",
  panel.includes("Secret values, database") &&
    panel.includes("absolute host paths are intentionally omitted") &&
    panel.includes("<dl") &&
    !panel.includes('section: "effective"')
);
check(
  "unexpected secret-storage failures are not swallowed",
  helper.includes("if (error instanceof ServerSecretError) return undefined;") &&
    helper.includes("throw error;")
);
check(
  "the public site derives dynamic metadata from managed branding",
  siteLayout.includes("export async function generateMetadata") &&
    siteLayout.includes("getSiteSettingsStatus()") &&
    siteLayout.includes("site.name.value") &&
    siteLayout.includes("site.tagline.value")
);

if (failures.length) {
  console.error(`\n${failures.length} operator UI check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} operator UI checks passed.`);
}
