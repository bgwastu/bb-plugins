import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-bb-sidebar",
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
