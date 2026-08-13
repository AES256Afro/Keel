#!/usr/bin/env node
// Static UI contract checks for owner-managed OAuth settings. The backend
// suite verifies encryption and authorization. These checks keep the browser
// surface write-only, owner-gated, explicit about verification, and free of
// restart instructions.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = readFileSync(path.join(root, "src/components/SettingsClient.tsx"), "utf8");
const page = readFileSync(path.join(root, "src/app/(workspace)/settings/page.tsx"), "utf8");
const cloudDocs = readFileSync(path.join(root, "docs/CLOUD.md"), "utf8");
const panel = settings.slice(
  settings.indexOf("function OAuthIntegrations()"),
  settings.indexOf("export interface OneNoteStatus")
);

let passed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  }
}

console.log("\nOwner-managed OAuth settings UI\n");
check("the Integrations panel is rendered only for the instance owner", settings.includes("{isInstanceOwner && <OAuthIntegrations />}"));
check("provider state is fetched without browser caching", panel.includes('fetch("/api/instance/oauth-settings", { cache: "no-store" })'));
check("writes use the owner-only OAuth settings endpoint", (panel.match(/fetch\("\/api\/instance\/oauth-settings"/g) ?? []).length === 3);
check("clearing requires explicit API confirmation", panel.includes('action: "clear", confirm: true'));
check("replacing a saved value requires browser confirmation", panel.includes("replacesSavedValue &&") && panel.includes("Replace the saved"));
check("client secrets use a password input", /type="password"[\s\S]{0,1800}autoComplete="new-password"/.test(panel));
check("saved secrets are described as write-only and never refilled", panel.includes("write-only") && panel.includes("never sends it back") && panel.includes("never\n                    filled back into this form"));
check("environment-managed credentials are read-only", panel.includes("controlled by server environment variables") && panel.includes("cannot be viewed or changed in the browser"));
check("saved credentials are not presented as verified", panel.includes("Saved, not verified") && panel.includes("only that both values are present"));
check("successful provider authorization has a distinct verified state", panel.includes('provider.status === "verified"') && panel.includes("Verified by a successful provider authorization"));
check("Google sign-in is not offered as an in-session test", !settings.includes("Try Google sign-in") && !settings.includes('testLabels: { signIn:'));
check("Google sign-in testing warns users to isolate the session", /separate private or incognito window/.test(settings) && /separate\s+private or incognito window/.test(cloudDocs));
check("OAuth changes do not claim a restart is needed", !/restart/i.test(panel));
check("async OAuth readiness is awaited before rendering Settings", /Promise\.all\(\[[\s\S]*googleConfigured\(\)[\s\S]*microsoftConfigured\(\)/.test(page));

if (failures.length) {
  console.error(`\n${failures.length} OAuth UI check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} OAuth UI checks passed.`);
}
