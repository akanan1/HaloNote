import { describe, expect, it, vi } from "vitest";
import { z } from "@workspace/api-zod";
import type { NextFunction, Request, Response } from "express";
import { validateBody } from "./validate";

function makeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    status: status as unknown as Response["status"],
    json: json as unknown as Response["json"],
    _status: status,
    _json: json,
  } as Response & {
    _status: ReturnType<typeof vi.fn>;
    _json: ReturnType<typeof vi.fn>;
  };
}

describe("validateBody", () => {
  const schema = z.object({ name: z.string().min(1), age: z.number().int() });

  it("calls next and replaces req.body with parsed data on success", () => {
    const mw = validateBody(schema);
    const req = { body: { name: "Avery", age: 7 } } as Request;
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    // Same shape here, but the value is now the *parsed* (post-coercion)
    // result — same identity guarantee callers rely on.
    expect(req.body).toEqual({ name: "Avery", age: 7 });
    expect(res._status).not.toHaveBeenCalled();
  });

  it("responds 400 with the canonical envelope on validation failure", () => {
    const mw = validateBody(schema);
    const req = { body: { name: "", age: "not a number" } } as Request;
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toHaveBeenCalledWith(400);
    expect(res._json).toHaveBeenCalledOnce();
    const payload = res._json.mock.calls[0]![0] as {
      error: string;
      issues: unknown[];
    };
    expect(payload.error).toBe("invalid_request");
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(payload.issues.length).toBeGreaterThan(0);
  });

  it("does not mutate req.body on validation failure", () => {
    const mw = validateBody(schema);
    const original = { name: "", age: "x" };
    const req = { body: original } as Request;
    mw(req, makeRes(), vi.fn() as NextFunction);
    expect(req.body).toBe(original);
  });
});
