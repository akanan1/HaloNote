// initializeMobileFor — one-shot setup for a provider's first /m visit.
//
// Flips the auto-push flags so the mobile flow ("record → walk out")
// actually delivers notes + non-medication orders into the chart without
// further taps. Idempotent: once `mobileOnboardedAt` is set, subsequent
// calls observe the user's current settings and return without
// re-flipping. This matters because a provider may legitimately turn
// auto-push back off later (different practice setup, on-call
// shadowing, whatever) and we must respect that.
//
// What it sets on first call:
//   autoPushMode = "after_transcription"  → note auto-approves + pushes
//                                            as soon as the AI body lands.
//   autoPushOrders = true                 → approved non-med orders push
//                                            inline (no extra tap).
//   autoPushMedications = false           → meds still require explicit
//                                            provider approval before push;
//                                            patient-safety floor.
//   autoApproveNonMedOrders = true        → AI-suggested non-med orders
//                                            auto-approve (still require
//                                            autoPushOrders to push).
//
// Medications are deliberately the only thing left in the
// "ai_suggested → wait for desktop review" lane.

import { eq } from "drizzle-orm";
import { getDb, usersTable, type User } from "@workspace/db";

export interface MobileInitResult {
  initialized: boolean; // false if already onboarded (call was a noop)
  user: Pick<
    User,
    | "id"
    | "autoPushMode"
    | "autoPushOrders"
    | "autoPushMedications"
    | "autoApproveNonMedOrders"
    | "mobileOnboardedAt"
  >;
}

export async function initializeMobileFor(
  userId: string,
): Promise<MobileInitResult> {
  const db = getDb();

  const [current] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!current) {
    throw new Error(`initializeMobileFor: user ${userId} not found`);
  }

  // Already onboarded — return current state without touching flags.
  // The provider's later edits (whatever they are) win.
  if (current.mobileOnboardedAt) {
    return {
      initialized: false,
      user: {
        id: current.id,
        autoPushMode: current.autoPushMode,
        autoPushOrders: current.autoPushOrders,
        autoPushMedications: current.autoPushMedications,
        autoApproveNonMedOrders: current.autoApproveNonMedOrders,
        mobileOnboardedAt: current.mobileOnboardedAt,
      },
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(usersTable)
    .set({
      autoPushMode: "after_transcription",
      autoPushOrders: true,
      autoPushMedications: false,
      autoApproveNonMedOrders: true,
      mobileOnboardedAt: now,
    })
    .where(eq(usersTable.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`initializeMobileFor: update returned no row`);
  }

  return {
    initialized: true,
    user: {
      id: updated.id,
      autoPushMode: updated.autoPushMode,
      autoPushOrders: updated.autoPushOrders,
      autoPushMedications: updated.autoPushMedications,
      autoApproveNonMedOrders: updated.autoApproveNonMedOrders,
      mobileOnboardedAt: updated.mobileOnboardedAt,
    },
  };
}
