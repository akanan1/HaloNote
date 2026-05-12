import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit-only by default. Integration tests run via vitest.integration.config.ts
    // since they need a separate Postgres + globalSetup.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
    ],
  },
});
