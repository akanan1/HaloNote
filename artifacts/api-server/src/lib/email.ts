import { Resend } from "resend";
import { logger } from "./logger";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSender {
  /** Name of the provider that handled this call. Useful for logs / tests. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

// -----------------------------------------------------------------------------
// In-memory sink (default in dev / test). Lets integration tests fish the
// reset URL out of the rendered body without standing up SMTP.
// -----------------------------------------------------------------------------

const sentEmails: EmailMessage[] = [];
const MAX_RETAINED = 100;

class LogOnlyEmailSender implements EmailSender {
  readonly name = "log-only";
  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject },
      "outbound email (dev sink)",
    );
    logger.debug({ body: message.body }, "outbound email body");
    sentEmails.push(message);
    while (sentEmails.length > MAX_RETAINED) sentEmails.shift();
  }
}

// -----------------------------------------------------------------------------
// Resend impl.
// -----------------------------------------------------------------------------

class ResendEmailSender implements EmailSender {
  readonly name = "resend";
  private readonly client: Resend;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.client = new Resend(apiKey);
    this.from = from;
  }

  async send(message: EmailMessage): Promise<void> {
    const result = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      // Send as text/plain — our outbound bodies are short, no HTML
      // templating yet. Add a `html` field here when one shows up.
      text: message.body,
    });
    if (result.error) {
      // Surface enough for an operator to act on without leaking the
      // recipient into the error message (logs may go to third-party
      // aggregators).
      throw new Error(
        `Resend rejected message: ${result.error.name} — ${result.error.message}`,
      );
    }
    logger.info(
      {
        to: message.to,
        subject: message.subject,
        resendId: result.data?.id,
      },
      "outbound email sent via Resend",
    );
  }
}

// -----------------------------------------------------------------------------
// Factory + module-level singleton.
// -----------------------------------------------------------------------------

function buildSender(): EmailSender {
  const provider = process.env["EMAIL_PROVIDER"]?.trim().toLowerCase();
  if (provider === "resend") {
    const apiKey = process.env["RESEND_API_KEY"]?.trim();
    const from = process.env["EMAIL_FROM"]?.trim();
    if (!apiKey || !from) {
      logger.warn(
        {
          missing: [
            !apiKey ? "RESEND_API_KEY" : null,
            !from ? "EMAIL_FROM" : null,
          ].filter(Boolean),
        },
        "EMAIL_PROVIDER=resend but config missing; falling back to log-only sender",
      );
      return new LogOnlyEmailSender();
    }
    return new ResendEmailSender(apiKey, from);
  }
  return new LogOnlyEmailSender();
}

// Lazy — construct on first send so process.env mutations during test
// bootstrap (setting EMAIL_PROVIDER, TEST_DATABASE_URL, etc.) take effect.
let cached: EmailSender | undefined;
function sender(): EmailSender {
  if (!cached) cached = buildSender();
  return cached;
}

/** Reset the cached sender. For tests that flip EMAIL_PROVIDER. */
export function resetEmailSender(): void {
  cached = undefined;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await sender().send(message);
}

// -----------------------------------------------------------------------------
// Test helpers — read what the log-only sink captured.
// -----------------------------------------------------------------------------

export function drainSentEmails(): EmailMessage[] {
  const snapshot = sentEmails.slice();
  sentEmails.length = 0;
  return snapshot;
}

export function getLastEmailTo(address: string): EmailMessage | undefined {
  for (let i = sentEmails.length - 1; i >= 0; i--) {
    if (sentEmails[i]!.to === address) return sentEmails[i];
  }
  return undefined;
}
