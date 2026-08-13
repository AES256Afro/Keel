// Minimal module resolver so the unit-test scripts can import the app's
// TypeScript modules directly.
//
// Node strips the types itself (--experimental-strip-types); the only thing it
// doesn't know is the "@/*" → "src/*" path alias from tsconfig.json.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const root = path.resolve(import.meta.dirname, "..");

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const base = path.join(root, "src", specifier.slice(2));
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (existsSync(candidate)) {
        return next(pathToFileURL(candidate).href, context);
      }
    }
  }
  return next(specifier, context);
}
