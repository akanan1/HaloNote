// One-off: connect to the dev Postgres and CREATE DATABASE <devdb>_test if missing.
// Intended for local setup of the api-server integration test harness.
//
//   pnpm --filter @workspace/scripts run create-test-db
//
// Reads DATABASE_URL from the workspace root .env via node --env-file.
import pg from "pg";

const sourceUrl = process.env["DATABASE_URL"];
if (!sourceUrl) {
  throw new Error("DATABASE_URL must be set (load via --env-file=../../.env).");
}

const u = new URL(sourceUrl);
const sourceDb = u.pathname.replace(/^\//, "") || "postgres";
const testDb = `${sourceDb}_test`;

console.log(`Creating database "${testDb}" (sibling of "${sourceDb}")…`);
const client = new pg.Client({ connectionString: sourceUrl });
await client.connect();
try {
  // Identifier interpolation — Postgres doesn't allow parameterized identifiers
  // in DDL. testDb is derived from sourceDb (which is controlled by the
  // operator's connection string), but we still sanitize for safety.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(testDb)) {
    throw new Error(`Refusing to create database with unusual name: ${testDb}`);
  }
  await client.query(`CREATE DATABASE "${testDb}"`);
  console.log(`Created "${testDb}".`);
} catch (err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e.code === "42P04") {
    console.log(`Database "${testDb}" already exists. (OK)`);
  } else {
    throw err;
  }
} finally {
  await client.end();
}

const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${testDb}`;
console.log("");
console.log("Add this to your .env (or export in your shell):");
console.log(`TEST_DATABASE_URL=${testUrl.toString()}`);
