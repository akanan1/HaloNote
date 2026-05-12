// Runs once per worker process, before the worker imports any test file.
// We rewrite DATABASE_URL → TEST_DATABASE_URL here so that the @workspace/db
// lazy pool, when first instantiated by the api-server's app code, opens
// against the test DB rather than the dev one.

const testUrl = process.env["TEST_DATABASE_URL"];
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL must be set to run integration tests.",
  );
}
process.env["DATABASE_URL"] = testUrl;
