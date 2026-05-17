import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One row per (user, EHR provider) once that user has completed the
// SMART OAuth handshake. Stores the refresh token + a copy of the most
// recent access token; the AuthCodeTokenProvider refreshes the access
// token when it gets close to expiry.
//
// accessToken / refreshToken are stored as AES-256-GCM ciphertext
// (see artifacts/api-server/src/lib/token-crypto.ts for the format).
// The key comes from the EHR_TOKEN_ENC_KEY env var. The column type
// stays `text` because ciphertext is an opaque ASCII string; we never
// query against the token values, only fetch + decrypt them.
export const ehrConnectionsTable = pgTable(
  "ehr_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `ehrc_${randomUUID()}`),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // "athenahealth" | "epic" — matches the existing EHR_MODE values.
    provider: text("provider").notNull(),
    accessToken: text("access_token").notNull(),
    // Athena issues a refresh token along with the access token for the
    // authorization_code grant. Nullable in the schema for spec-conformance
    // (RFC 6749 §4.1.4 allows the auth server to omit it) but in practice
    // every Athena response we've seen includes one.
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    // Practitioner.id from the OAuth context, e.g. "abc-123". Same value
    // we'd previously set on users.ehr_practitioner_id manually — the
    // OAuth callback writes it through automatically.
    practitionerId: text("practitioner_id"),
    // Space-separated scopes the server granted (may differ from what
    // we asked for). Stored for debugging + so we can surface
    // permission gaps in the UI later.
    scope: text("scope"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // At most one active connection per (user, provider). Re-connecting
    // updates the existing row via ON CONFLICT.
    uniqueIndex("ehr_connections_user_provider_uniq").on(t.userId, t.provider),
  ],
);

// Short-lived state for the OAuth handshake. Created on /start, consumed
// on /callback, gc'd by TTL. Holds the PKCE verifier (kept server-side so
// a stolen authorize URL alone isn't enough to complete the flow) and the
// user id the flow was initiated for.
export const ehrOauthStatesTable = pgTable("ehr_oauth_states", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  // Optional: where to send the browser after a successful callback.
  // Defaults to /settings if omitted. Constrained to same-origin paths
  // by the callback handler.
  returnPath: text("return_path"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EhrConnection = typeof ehrConnectionsTable.$inferSelect;
export type NewEhrConnection = typeof ehrConnectionsTable.$inferInsert;
export type EhrOauthState = typeof ehrOauthStatesTable.$inferSelect;
export type NewEhrOauthState = typeof ehrOauthStatesTable.$inferInsert;
