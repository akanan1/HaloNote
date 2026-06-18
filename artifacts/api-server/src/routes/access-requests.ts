import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "@workspace/api-zod";
import { PostgresRateLimitStore } from "../lib/postgres-rate-limit-store";
import { sendEmail } from "../lib/email";

const router: IRouter = Router();

// Marketing-site early-access form. No DB row — the founder inbox is
// the system of record at this stage. Two emails fire per submission:
// an acknowledgement to the requester, and a notification to the
// founder inbox.

const FOUNDER_INBOX =
  process.env["EARLY_ACCESS_INBOX"]?.trim() || "hello@halonote.app";

const AccessRequestBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.email().max(254),
  specialty: z.string().trim().min(1).max(120),
  practiceType: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(1).max(200),
  ehrSystem: z.string().trim().min(1).max(120),
  message: z.string().trim().max(2000).optional(),
});

// Tight per-IP cap. Form is unauthenticated and fires real email — a
// loose limit becomes a spam relay.
const accessRequestIpRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  message: { error: "too_many_attempts" },
});

router.post(
  "/access-requests",
  accessRequestIpRateLimit,
  async (req, res) => {
    const parsed = AccessRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const requesterEmail = data.email.toLowerCase();

    const ack = {
      to: requesterEmail,
      subject: "Your HaloNote early access request",
      body:
        `Hi ${data.fullName},\n\n` +
        `Thanks for asking about HaloNote early access. We've received your request and someone from the team will be in touch within 48 hours.\n\n` +
        `For reference, here's what you sent:\n` +
        `  Specialty: ${data.specialty}\n` +
        `  Practice: ${data.practiceType} — ${data.organizationName}\n` +
        `  EHR: ${data.ehrSystem}\n` +
        (data.message ? `  Notes: ${data.message}\n` : "") +
        `\n— The HaloNote team`,
    };

    const notification = {
      to: FOUNDER_INBOX,
      subject: `Early access request — ${data.fullName} (${data.organizationName})`,
      body:
        `New early-access request from the marketing site.\n\n` +
        `Name:         ${data.fullName}\n` +
        `Email:        ${requesterEmail}\n` +
        `Specialty:    ${data.specialty}\n` +
        `Practice:     ${data.practiceType}\n` +
        `Organization: ${data.organizationName}\n` +
        `EHR:          ${data.ehrSystem}\n` +
        (data.message ? `\nMessage:\n${data.message}\n` : ""),
    };

    try {
      // Notification first — if the founder email fails, we want to
      // surface that as a 500 and NOT silently ack the requester.
      await sendEmail(notification);
      await sendEmail(ack);
    } catch (err) {
      req.log.error({ err }, "Failed to dispatch access-request emails");
      res.status(500).json({ error: "email_dispatch_failed" });
      return;
    }

    res.status(201).json({ status: "received" });
  },
);

export default router;
