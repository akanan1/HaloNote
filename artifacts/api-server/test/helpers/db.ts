import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@workspace/db";

// Wipe every table the api server writes to. RESTART IDENTITY resets any
// SERIAL/identity sequences; CASCADE follows FK chains (sessions → users,
// notes → users via authorId). Table names are baked into the SQL because
// they're a hardcoded constant — not user input — so no injection surface.
export async function resetTestDb(): Promise<void> {
  await getDb().execute(
    sql`TRUNCATE TABLE sessions, notes, patients, users RESTART IDENTITY CASCADE`,
  );
}

export async function teardownTestDb(): Promise<void> {
  await closeDb();
}
