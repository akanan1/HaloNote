import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "@workspace/db";
import { logger } from "./logger";

/**
 * Apply pending drizzle migrations against the DB pointed at by
 * DATABASE_URL. Run from index.ts before app.listen so a deploy that
 * ships a schema change can't accept traffic until the schema matches
 * the code that's about to handle it.
 *
 * The migrations folder location varies by deploy:
 *   - Local dev / tests: lib/db/migrations relative to the workspace root
 *   - Docker image: /app/migrations
 *
 * DB_MIGRATIONS_PATH overrides the default for both cases. The default
 * picks the local-dev path so a developer running `pnpm dev` doesn't
 * need to set anything.
 */
export async function runMigrations(): Promise<void> {
  if (process.env["SKIP_MIGRATIONS"] === "true") {
    logger.warn("SKIP_MIGRATIONS=true; not applying migrations");
    return;
  }

  const migrationsFolder =
    process.env["DB_MIGRATIONS_PATH"] ?? "../../lib/db/migrations";

  logger.info({ migrationsFolder }, "applying database migrations");
  await migrate(getDb(), { migrationsFolder });
  logger.info("migrations complete");
}
