import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./errors";

describe("isUniqueViolation", () => {
  it("matches the top-level 23505 code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("matches when drizzle wraps the pg error under `cause`", () => {
    // Drizzle's pg driver shape: top-level `code` may be undefined and
    // the original pg error sits on `cause`.
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("does NOT match other postgres error codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false); // FK violation
    expect(isUniqueViolation({ cause: { code: "23502" } })).toBe(false); // NOT NULL
  });

  it("returns false for null / undefined / primitives", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
  });

  it("returns false when cause is not an object", () => {
    expect(isUniqueViolation({ cause: "23505" })).toBe(false);
  });
});
