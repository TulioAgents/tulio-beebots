import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Nested worktrees are separate checkouts and must be linted from their own roots.
  // beekeeper/ holds the Zap's two Code by Zapier steps: they run in Zapier's sandbox (inputData, output), not here.
  { ignores: ["dist/", "node_modules/", "data/", "vendor/", "dashboard/", ".kilo/worktrees/", "beekeeper/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // All output goes through the redacting logger.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { files: ["src/tools/**"], rules: { "no-console": "off" } },
);
