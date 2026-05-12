import { describe, it, expect } from "vitest";
import {
  generateCsrfToken,
  isSafeMethod,
  timingSafeStringEqual,
} from "./csrf";

describe("isSafeMethod", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("considers %s safe", (m) => {
    expect(isSafeMethod(m)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("considers %s unsafe", (m) => {
    expect(isSafeMethod(m)).toBe(false);
  });
});

describe("timingSafeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
  });

  it("returns false for unequal strings of the same length", () => {
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
  });

  it("returns false for unequal-length strings without throwing", () => {
    expect(timingSafeStringEqual("abc", "ab")).toBe(false);
    expect(timingSafeStringEqual("ab", "abcd")).toBe(false);
  });

  it("returns false for empty + non-empty", () => {
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});

describe("generateCsrfToken", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct tokens across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(generateCsrfToken());
    expect(seen.size).toBe(20);
  });
});
