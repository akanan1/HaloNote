import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-redirect";

// jsdom's default origin is http://localhost:3000. Every assertion
// below is anchored to that origin via window.location.origin inside
// safeNext.

describe("safeNext — accepts safe same-origin paths", () => {
  it("accepts a plain root-relative path", () => {
    expect(safeNext("/")).toBe("/");
  });

  it("accepts a typical SPA route", () => {
    expect(safeNext("/patients/abc/notes/new")).toBe(
      "/patients/abc/notes/new",
    );
  });

  it("accepts an api-server route (the Cerner launch case)", () => {
    expect(
      safeNext("/api/auth/ehr/cerner/launch?iss=foo&launch=bar"),
    ).toBe("/api/auth/ehr/cerner/launch?iss=foo&launch=bar");
  });

  it("preserves the query string and hash on the normalized path", () => {
    expect(safeNext("/foo?a=1&b=2#section")).toBe("/foo?a=1&b=2#section");
  });
});

describe("safeNext — rejects external / scheme-relative targets", () => {
  it("rejects an absolute external URL", () => {
    expect(safeNext("https://evil.example/steal")).toBeNull();
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeNext("//evil.example/anything")).toBeNull();
  });

  it("rejects the backslash protocol-relative variant", () => {
    expect(safeNext("/\\evil.example")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(safeNext("javascript:alert(1)")).toBeNull();
  });

  it("rejects a data: URL", () => {
    expect(safeNext("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects a URL with embedded credentials (origin still attacker)", () => {
    expect(
      safeNext("https://attacker:foo@halonote.example/x"),
    ).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(safeNext("")).toBeNull();
  });

  it("rejects a path that doesn't start with /", () => {
    expect(safeNext("patients/abc")).toBeNull();
    expect(safeNext("./patients")).toBeNull();
    expect(safeNext("../patients")).toBeNull();
  });

  it("rejects a path longer than the bound", () => {
    expect(safeNext("/" + "x".repeat(2048))).toBeNull();
    // Just under the bound is fine.
    expect(safeNext("/" + "x".repeat(2046))).not.toBeNull();
  });

  it("rejects non-string inputs", () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext(42)).toBeNull();
    expect(safeNext({ next: "/foo" })).toBeNull();
  });
});

describe("safeNext — edge cases", () => {
  it("normalizes redundant slashes via URL parser", () => {
    // A single leading slash is fine; the URL parser canonicalizes
    // anything after the first segment. We don't fight it — what
    // matters is that origin stays same-origin.
    const out = safeNext("/foo///bar");
    expect(out).not.toBeNull();
    expect(out!.startsWith("/")).toBe(true);
  });

  it("handles URL-encoded characters without losing same-origin guarantee", () => {
    const out = safeNext("/patients/abc%20def?ehrId=12345");
    expect(out).not.toBeNull();
    expect(out!).toContain("ehrId=12345");
  });
});
