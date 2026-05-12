import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");

// Vitest globalSetup: runs once in the main process before any worker
// starts. We use it to ensure the schema is up to date against the test
// database. The returned function is the teardown (no-op here).
export default async function setup(): Promise<() => void> {
  const testUrl = process.env["TEST_DATABASE_URL"];
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL must be set to run integration tests. " +
        "Use a database separate from your dev DB — these tests will TRUNCATE all tables.",
    );
  }

  // Safety: don't ever truncate the dev DB.
  const devUrl = process.env["DATABASE_URL"];
  if (devUrl && devUrl === testUrl) {
    throw new Error(
      "TEST_DATABASE_URL equals DATABASE_URL. Use a different database for tests.",
    );
  }

  // eslint-disable-next-line no-console
  console.log("[integration] pushing schema to test database…");
  execSync("pnpm --filter @workspace/db run push", {
    cwd: workspaceRoot,
    // CI=true bypasses drizzle-kit's TTY prompt; DATABASE_URL override
    // routes the push at the test database, not the dev one.
    env: { ...process.env, DATABASE_URL: testUrl, CI: "true" },
    stdio: "inherit",
  });

  return () => {
    // No teardown — leaving the schema in place for the next run.
  };
}
