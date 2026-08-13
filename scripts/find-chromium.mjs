// Locate a Chromium to drive the browser suites.
//
// playwright-core launches the revision it was compiled against and nothing
// else - but it ships no installer (that lives in @playwright/test), so on a
// machine whose cache holds a *neighbouring* revision every browser suite dies
// at launch with "Executable doesn't exist ... chromium_headless_shell-1228".
// That failure is indistinguishable from a broken app to anyone running the
// suite, and it means the browser checks quietly stop running: they are not in
// the `npm test` chain, so nobody notices until someone runs one by hand.
//
// So: honour CHROMIUM when set, otherwise take whatever Chromium the cache
// actually has, otherwise a system Chrome. Any recent build renders these
// pages identically - pinning matters for screenshot diffing, which none of
// these suites do.
import fs from "fs";
import path from "path";
import os from "os";

const CACHES = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  path.join(os.homedir(), "Library/Caches/ms-playwright"), // macOS
  path.join(os.homedir(), ".cache/ms-playwright"), // Linux
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"), // Windows
].filter((p) => typeof p === "string" && p.length > 0);

/** Where each cached build keeps its binary, most preferred shape first. */
const INSIDE = [
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-linux/chrome",
  "chrome-win/chrome.exe",
  "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "chrome-headless-shell-mac/chrome-headless-shell",
  "chrome-headless-shell-linux/chrome-headless-shell",
  "chrome-headless-shell-win/chrome-headless-shell.exe",
];

const SYSTEM = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/**
 * A launchable Chromium path, or null to let playwright-core try its own.
 * Full builds are preferred over headless shells: the shell cannot do
 * everything (no extensions, no headed mode) and some suites take screenshots.
 */
export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;

  const found = [];
  for (const cache of CACHES) {
    let entries;
    try {
      entries = fs.readdirSync(cache);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^chromium(_headless_shell)?-\d+$/.test(entry)) continue;
      const shell = entry.includes("headless_shell");
      const revision = Number(/-(\d+)$/.exec(entry)?.[1] ?? 0);
      for (const rel of INSIDE) {
        const candidate = path.join(cache, entry, rel);
        if (fs.existsSync(candidate)) {
          found.push({ candidate, shell, revision });
          break;
        }
      }
    }
  }
  // Newest full build wins; a shell only if that is all there is.
  found.sort((a, b) => Number(a.shell) - Number(b.shell) || b.revision - a.revision);
  if (found.length) return found[0].candidate;

  for (const candidate of SYSTEM) if (fs.existsSync(candidate)) return candidate;
  return null;
}

/** Spread into chromium.launch(): `{ ...chromiumLaunchOptions(), headless: true }`. */
export function chromiumLaunchOptions() {
  const executablePath = findChromium();
  return executablePath ? { executablePath } : {};
}
