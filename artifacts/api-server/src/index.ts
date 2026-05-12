import app from "./app";
import { logger } from "./lib/logger";
import { closeDb } from "@workspace/db";
import { seedPatientsIfEmpty } from "./lib/patients";
import { seedUsersIfEmpty } from "./lib/seed-users";

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
  await seedUsersIfEmpty();
  await seedPatientsIfEmpty();
} catch (err) {
  logger.error({ err }, "Seed failed; refusing to start");
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server failed to start");
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  server.close((err) => {
    if (err) logger.error({ err }, "Error closing HTTP server");
  });

  try {
    await closeDb();
  } catch (err) {
    logger.error({ err }, "Error closing database pool");
  }

  // Give in-flight handlers a moment, then exit hard.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
