// Flat config. The ignore list is the load-bearing part.
//
// ESLint 9 does not read `.gitignore`, and a glob without a leading `**/`
// only matches at the repo root - `dist/**` would leave a nested
// `.worktrees/x/dist` to be linted as source. `components/**` and `lib/**`
// are vendored shadcn files this plugin owns but did not write; they are
// edited when a control needs changing, not held to this config.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.worktrees/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "components/**",
      "lib/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // The plugin surface is full of `unknown` crossing a boundary, and a
      // deliberate `void promise` is how fire-and-forget work is spelled here.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": "error",
    },
  },
  {
    // Test fixtures are standalone MCP servers run by node, not plugin code.
    files: ["tests/fixtures/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
