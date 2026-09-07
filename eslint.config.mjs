import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Netlify's build output. It is a copy of .next plus the bundled functions, so
    // linting it reported 669 errors in generated code and buried the handful in ours —
    // a lint run nobody can read is a lint run nobody looks at.
    ".netlify/**",
    // Playwright MCP scratch: page snapshots and throwaway audit scripts.
    ".playwright-mcp/**",
  ]),
]);

export default eslintConfig;
