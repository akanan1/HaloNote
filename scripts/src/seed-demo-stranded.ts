// One-off seed for the live demo of the per-card retry button. Creates:
//   - a clearly-fake patient ("TEST DELETEME")
//   - an encounter with an Athena-shaped ehrEncounterRef
//   - an approved note (signals "finalized" to the retry-push gate)
//   - an approved_billing_code in the STRANDED state
//     (ehrError set, exportedAt null, billerApprovedAt null)
//
// Also accepts the BAA + Terms + Privacy for the demo user so the UI
// doesn't block on onboarding.
//
// Run with:
//   DATABASE_URL=postgres://halonote:halonote_test@localhost:5433/halonote_test \
//     pnpm --filter @workspace/scripts exec tsx ./src/seed-demo-stranded.ts
//
// Idempotent — ON CONFLICT DO NOTHING on every insert.

// @workspace/legal isn't in this package's deps; read the markdown
// directly from disk and hash it. Keeps this seed standalone.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REQUIRED_DOCUMENT_TYPES = ["baa", "terms", "privacy"] as const;
type DocType = (typeof REQUIRED_DOCUMENT_TYPES)[number];

const DOCUMENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../lib/legal/src/documents",
);

function currentDocument(type: DocType): { version: string; contentHash: string } {
  // Pick the highest-versioned <type>-vN.md present on disk.
  const files = readdirSync(DOCUMENTS_DIR).filter((f) =>
    f.startsWith(`${type}-v`) && f.endsWith(".md"),
  );
  if (files.length === 0) {
    throw new Error(`No legal documents for type ${type} in ${DOCUMENTS_DIR}`);
  }
  files.sort();
  const file = files[files.length - 1]!;
  const version = file.slice(`${type}-v`.length, -".md".length);
  const body = readFileSync(join(DOCUMENTS_DIR, file), "utf-8");
  const contentHash = createHash("sha256").update(body, "utf-8").digest("hex");
  return { version, contentHash };
}

const PATIENT_ID = "pt_demo_stranded";
const ENCOUNTER_ID = "enc_demo_stranded";
const NOTE_ID = "note_demo_stranded";
const CODE_ID = "bcd_demo_stranded";
const ORG_ID = "org_default";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });

  // Find the demo user (created earlier via /api/auth/signup).
  const userRes = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = $1 LIMIT 1`,
    ["demo@halonote.test"],
  );
  const user = userRes.rows[0];
  if (!user) {
    console.error(
      "No user demo@halonote.test in test DB. Sign up first via /api/auth/signup.",
    );
    process.exit(1);
  }
  console.log(`Using user ${user.id} (${user.email})`);

  // Accept the three required legal docs for the demo user. Hashes
  // are recomputed from disk so the audit-verifier still passes.
  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const doc = currentDocument(type);
    // id is a TypeScript-level Drizzle default ($defaultFn); raw SQL
    // needs to provide it explicitly.
    await pool.query(
      `INSERT INTO legal_acceptances
        (id, user_id, document_type, version, content_hash, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `lact_${randomUUID()}`,
        user.id,
        type,
        doc.version,
        doc.contentHash,
        "127.0.0.1",
        "seed-script",
      ],
    );
  }
  console.log("Legal acceptances OK");

  // Ensure org_default exists, add demo user as member, and set the
  // user's session activeOrganizationId so PHI lookups don't 404 on
  // the tenant scope.
  await pool.query(
    `INSERT INTO organizations (id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, "Demo Org", "demo"],
  );
  await pool.query(
    `INSERT INTO organization_members (id, organization_id, user_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [`om_${randomUUID()}`, ORG_ID, user.id, "owner"],
  );
  await pool.query(
    `UPDATE sessions SET active_organization_id = $1 WHERE user_id = $2`,
    [ORG_ID, user.id],
  );
  console.log("Org membership + session active-org OK");

  // Patient.
  await pool.query(
    `INSERT INTO patients (id, organization_id, first_name, last_name, date_of_birth, mrn)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [PATIENT_ID, ORG_ID, "TEST", "DELETEME", "1990-01-01", "MRN-TEST-DELETEME"],
  );

  // Encounter — ehrEncounterRef set so retry-push reaches dispatch.
  await pool.query(
    `INSERT INTO encounters
       (id, organization_id, patient_id, visit_type, status, ehr_encounter_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      ENCOUNTER_ID,
      ORG_ID,
      PATIENT_ID,
      "established_patient",
      "in_progress",
      "Encounter/athena-enc-demo",
    ],
  );

  // Note — status=approved unlocks the note-finalized gate.
  await pool.query(
    `INSERT INTO notes
       (id, organization_id, patient_id, encounter_id, body, status, approved_at,
        approved_by_user_id, signed_note_hash)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      NOTE_ID,
      ORG_ID,
      PATIENT_ID,
      ENCOUNTER_ID,
      "Demo visit summary.\n\nAssessment:\nType 2 diabetes mellitus.",
      "approved",
      user.id,
      "0000000000000000000000000000000000000000000000000000000000000000",
    ],
  );

  // Approved billing code — STRANDED. ehrError set, exportedAt null,
  // billerApprovedAt null — exactly the condition the Retry-push
  // button renders for.
  await pool.query(
    `INSERT INTO approved_billing_codes
       (id, organization_id, encounter_id, code_system, code, description,
        approved_at, approved_by_user_id, ehr_error)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      CODE_ID,
      ORG_ID,
      ENCOUNTER_ID,
      "icd10",
      "E11.9",
      "Type 2 diabetes mellitus without complications",
      user.id,
      "Athena returned 502 — upstream gateway timeout. Try again.",
    ],
  );

  console.log("\nSeed complete.\n");
  console.log(`  Patient:   ${PATIENT_ID} (TEST DELETEME)`);
  console.log(`  Encounter: ${ENCOUNTER_ID}`);
  console.log(`  Note:      ${NOTE_ID} (approved)`);
  console.log(`  Code:      ${CODE_ID} (E11.9, stranded)`);
  console.log("\nNavigate to:");
  console.log(`  http://localhost:8091/encounter/${ENCOUNTER_ID}\n`);

  await pool.end();
  process.exit(0);
}

void main();
