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

// The test:integration script loads .env for TEST_DATABASE_URL convenience,
// which also pulls in real-provider env vars. Force them off so tests run
// against the in-memory/stub paths — otherwise password-reset tests try to
// fish the reset link out of a log-only sink while emails are silently
// going to Resend for fake @halonote.test addresses.
process.env["EMAIL_PROVIDER"] = "log-only";
