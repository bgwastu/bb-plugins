// The `@/` alias the vendored `components/ui/*` are imported through. tsc
// reads it from tsconfig's `paths` and `bb plugin build` from the same file;
// vitest needs it spelled out here or a component test cannot resolve a
// control the panel imports.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
  test: {
    // A worktree carries a full copy of this repo, tests included. Without
    // this, running the suite from the main checkout runs every worktree's
    // copy too - against the same fixtures, at the same time.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
