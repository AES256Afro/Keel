// eslint-config-next 16 ships native flat configs - no FlatCompat needed.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "dist-desktop/**",
      "desktop-build/**",
      "node_modules/**",
      "prisma/migrations/**",
      "next-env.d.ts",
    , "dist/**"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // An intentionally-ignored argument (`_req` in a route handler) is
      // idiomatic; a genuinely unused binding is a leftover.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Standalone Node scripts and the Electron shell: CommonJS is expected.
    files: ["scripts/**/*.mjs", "desktop/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default config;
