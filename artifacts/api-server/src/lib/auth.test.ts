import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./auth";

describe("password hashing", () => {
  it("verifies a freshly-hashed password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter3", hash)).toBe(false);
  });

  it("produces a different hash each call (salt is fresh)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    // Both still verify.
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("returns false (no throw) for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "no-colon")).toBe(false);
    expect(await verifyPassword("x", ":")).toBe(false);
    expect(await verifyPassword("x", "deadbeef:")).toBe(false);
    expect(await verifyPassword("x", ":deadbeef")).toBe(false);
    // Wrong key length.
    expect(await verifyPassword("x", "00112233445566778899aabbccddeeff:00")).toBe(
      false,
    );
    // Non-hex bytes — Buffer.from(*, "hex") tolerates this by truncating,
    // but the wrong-length branch covers it.
    expect(await verifyPassword("x", "zz:zz")).toBe(false);
  });
});
