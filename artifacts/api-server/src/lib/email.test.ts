import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Resend SDK is a single named class with an `emails.send` method.
// Mock it module-wide so we don't actually hit the network.
const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

import {
  drainSentEmails,
  resetEmailSender,
  sendEmail,
} from "./email";

describe("email sender factory", () => {
  beforeEach(() => {
    sendMock.mockReset();
    drainSentEmails();
    resetEmailSender();
  });

  afterEach(() => {
    delete process.env["EMAIL_PROVIDER"];
    delete process.env["RESEND_API_KEY"];
    delete process.env["EMAIL_FROM"];
    resetEmailSender();
  });

  it("uses the log-only sink when EMAIL_PROVIDER is unset", async () => {
    await sendEmail({
      to: "a@b.test",
      subject: "hi",
      body: "hello",
    });
    expect(sendMock).not.toHaveBeenCalled();
    const captured = drainSentEmails();
    expect(captured).toEqual([{ to: "a@b.test", subject: "hi", body: "hello" }]);
  });

  it("falls back to log-only when EMAIL_PROVIDER=resend but creds missing", async () => {
    process.env["EMAIL_PROVIDER"] = "resend";
    // No RESEND_API_KEY, no EMAIL_FROM → factory warns and uses log-only.
    await sendEmail({
      to: "a@b.test",
      subject: "hi",
      body: "hello",
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(drainSentEmails().length).toBe(1);
  });

  it("routes through Resend when EMAIL_PROVIDER=resend + creds set", async () => {
    process.env["EMAIL_PROVIDER"] = "resend";
    process.env["RESEND_API_KEY"] = "re_test_key";
    process.env["EMAIL_FROM"] = "HaloNote <auth@halonote.test>";
    sendMock.mockResolvedValue({ data: { id: "msg_123" }, error: null });

    await sendEmail({
      to: "user@example.test",
      subject: "Reset your password",
      body: "Click here…",
    });

    expect(sendMock).toHaveBeenCalledWith({
      from: "HaloNote <auth@halonote.test>",
      to: "user@example.test",
      subject: "Reset your password",
      text: "Click here…",
    });
    // Real-send path doesn't append to the log-only sink.
    expect(drainSentEmails().length).toBe(0);
  });

  it("throws when Resend returns an error", async () => {
    process.env["EMAIL_PROVIDER"] = "resend";
    process.env["RESEND_API_KEY"] = "re_test_key";
    process.env["EMAIL_FROM"] = "HaloNote <auth@halonote.test>";
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "from is required" },
    });

    await expect(
      sendEmail({ to: "x@y.test", subject: "x", body: "x" }),
    ).rejects.toThrow(/Resend rejected message: validation_error/);
  });
});
