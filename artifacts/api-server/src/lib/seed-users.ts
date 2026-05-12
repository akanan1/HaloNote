import { getDb, usersTable } from "@workspace/db";
import { hashPassword } from "./auth";
import { logger } from "./logger";

// Dev users seeded into an empty users table on first boot. Remove once a
// real onboarding flow exists (or gate behind NODE_ENV !== "production").
const DEMO_USERS = [
  {
    id: "usr_demo_alice",
    email: "alice@halonote.example",
    displayName: "Dr. Alice Chen",
    password: "hunter2",
  },
  {
    id: "usr_demo_bob",
    email: "bob@halonote.example",
    displayName: "Dr. Bob Park",
    password: "hunter2",
  },
];

export async function seedUsersIfEmpty(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (existing.length > 0) return;

  const rows = await Promise.all(
    DEMO_USERS.map(async (u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      passwordHash: await hashPassword(u.password),
    })),
  );
  await db.insert(usersTable).values(rows);
  logger.info(
    { count: rows.length, emails: DEMO_USERS.map((u) => u.email) },
    "Seeded users table with demo accounts (password: hunter2)",
  );
}
