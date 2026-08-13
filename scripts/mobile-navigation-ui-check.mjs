#!/usr/bin/env node
// Static contract for the responsive workspace shell. Rendered browser checks
// cover the actual 390px behavior; these assertions keep the drawer's keyboard
// and desktop-preservation hooks from disappearing in later refactors.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = readFileSync(path.join(root, "src/components/Sidebar.tsx"), "utf8");
const layout = readFileSync(path.join(root, "src/app/(workspace)/layout.tsx"), "utf8");
const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");

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

console.log("\nResponsive workspace navigation\n");
check("mobile navigation has a persistent named trigger", sidebar.includes('aria-label="Open workspace navigation"') && sidebar.includes('aria-controls="workspace-navigation"'));
check("trigger exposes drawer state", sidebar.includes("aria-expanded={mobileOpen}"));
check("drawer has a named close control", sidebar.includes('aria-label="Close workspace navigation"'));
check("drawer closes on Escape", sidebar.includes('event.key === "Escape"') && sidebar.includes("setMobileOpen(false)"));
check("keyboard focus is trapped inside an open drawer", sidebar.includes('event.key !== "Tab"') && sidebar.includes("last.focus()") && sidebar.includes("first.focus()"));
check(
  "focus outside the open drawer is pulled back inside",
  sidebar.includes("sidebarRef.current?.contains(document.activeElement)") &&
    sidebar.includes("(event.shiftKey ? last : first).focus()")
);
check(
  "focus returns to the trigger only while it remains visible",
  sidebar.includes('window.matchMedia("(max-width: 767px)").matches') &&
    sidebar.includes("trigger?.focus()")
);
check(
  "a resize to desktop moves focus into the visible sidebar",
  sidebar.includes("if (desktop.matches)") &&
    sidebar.includes("desktopFocusRef.current") &&
    sidebar.includes("else desktopFocus?.focus()")
);
check("background scrolling is locked only while open", sidebar.includes('document.body.style.overflow = "hidden"') && sidebar.includes("previousOverflow"));
check("mobile backdrop closes the drawer", sidebar.includes('className="fixed inset-0 z-40 bg-black/40 md:hidden"'));
check("desktop sidebar remains statically visible", sidebar.includes("md:static") && sidebar.includes("md:flex") && sidebar.includes("md:w-64"));
check(
  "mobile content gets full width and fixed-header clearance",
  layout.includes("min-w-0 flex-1") &&
    layout.includes("scroll-pt-14") &&
    layout.includes("md:scroll-pt-0") &&
    layout.includes("pt-14") &&
    layout.includes("md:pt-0")
);
check("focus mode hides the mobile trigger with the sidebar", css.includes(".keel-focus-chrome .keel-mobile-nav-trigger"));

if (failures.length) {
  console.error(`\n${failures.length} mobile navigation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} mobile navigation checks passed.`);
}
