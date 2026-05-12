import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: "./test/global-setup.ts",
    setupFiles: ["./test/setup.ts"],
    // Integration tests share a single test DB and reset between runs;
    // executing them in parallel would interleave TRUNCATEs and writes.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Schema push + scrypt password hashing pushes the slowest tests past
    // the default 5s timeout on cold runs.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
