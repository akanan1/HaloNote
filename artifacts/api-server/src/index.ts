import { initSentry } from "./lib/sentry";
// Initialize Sentry before any other module imports — its instrumentation
// monkey-patches http/express. Safe no-op when SENTRY_DSN is unset.
initSentry();

import app from "./app";
import { logger } from "./lib/logger";
import { closeDb } from "@workspace/db";
import { seedPatientsIfEmpty } from "./lib/patients";
import { seedUsersIfEmpty } from "./lib/seed-users";
import { getInflightCount, waitForDrain } from "./lib/inflight";
import {
  scheduleAuditLogCleanup,
  stopAuditLogCleanup,
} from "./lib/audit-cleanup";
import { runMigrations } from "./lib/run-migrations";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try {
  // Run pending migrations first so the seed code below sees the
  // schema it expects. A deploy that ships a schema change can't
  // accept traffic until the schema matches the code.
  await runMigrations();
  await seedUsersIfEmpty();
  await seedPatientsIfEmpty();
} catch (err) {
  logger.error({ err }, "Startup failed; refusing to start");
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

// Daily delete of audit-log rows older than the retention window.
// .unref()-ed so it doesn't keep the event loop alive on SIGTERM.
scheduleAuditLogCleanup();

server.on("error", (err) => {
  logger.error({ err }, "Server failed to start");
  process.exit(1);
});

const SHUTDOWN_DRAIN_MS = Number(
  process.env["SHUTDOWN_DRAIN_MS"] ?? "10000",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(
    { signal, inflight: getInflightCount() },
    "Shutdown requested; refusing new connections and draining in-flight",
  );

  // Stop accepting new connections. Existing ones keep going until
  // either they finish or waitForDrain times out.
  server.close((err) => {
    if (err) logger.error({ err }, "Error closing HTTP server");
  });

  const drained = await waitForDrain(SHUTDOWN_DRAIN_MS);
  if (!drained) {
    logger.warn(
      { inflight: getInflightCount(), waitedMs: SHUTDOWN_DRAIN_MS },
      "Drain timeout — closing pool with requests still in flight",
    );
  }

  stopAuditLogCleanup();

  try {
    await closeDb();
  } catch (err) {
    logger.error({ err }, "Error closing database pool");
  }

  logger.info("Shutdown complete");
  // Tiny grace so log writes flush before exit.
  setTimeout(() => process.exit(drained ? 0 : 1), 50).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
