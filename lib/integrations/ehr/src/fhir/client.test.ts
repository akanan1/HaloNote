import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { FhirClient, FhirError } from "./client";

interface FakeCall {
  url: string;
  method: string;
  body: string | null;
  ifMatch: string | null;
  idempotencyKey: string | null;
}

function makeClient(opts: {
  responses: Array<{
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  }>;
  baseUrl?: string;
  /** Override the per-client retry policy in tests. */
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}) {
  const calls: FakeCall[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      ifMatch: headers.get("if-match"),
      idempotencyKey: headers.get("idempotency-key"),
    });
    const r = opts.responses[i++] ?? opts.responses[opts.responses.length - 1]!;
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      {
        status: r.status ?? 200,
        headers: r.headers ?? { "content-type": "application/fhir+json" },
      },
    );
  });

  return {
    client: new FhirClient({
      baseUrl: opts.baseUrl ?? "https://fhir.example/api/FHIR/R4",
      getToken: () => "token-abc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // Keep tests deterministic — record waits, never actually sleep.
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5, ...opts.retry },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      // Pin jitter to 0 so sleep values are exact across runs. The
      // ±20% jitter formula collapses when random() returns 0.5.
      random: () => 0.5,
    }),
    fetchImpl,
    calls,
    sleeps,
  };
}

describe("FhirClient construction", () => {
  it("rejects non-http(s) baseUrl", () => {
    expect(
      () =>
        new FhirClient({
          baseUrl: "ftp://x.example",
          getToken: () => "t",
        }),
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it("accepts http baseUrl in non-production", () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    expect(
      () =>
        new FhirClient({
          baseUrl: "http://localhost:8080/fhir",
          getToken: () => "t",
        }),
    ).not.toThrow();
    process.env["NODE_ENV"] = prev;
  });

  it("requires https baseUrl in production", () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    expect(
      () =>
        new FhirClient({
          baseUrl: "http://insecure.example/fhir",
          getToken: () => "t",
        }),
    ).toThrow(/HTTPS in production/);
    process.env["NODE_ENV"] = prev;
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
      baseUrl: "https://fhir.example/api/FHIR/R4///",
    });
    await client.read("Patient", "p1");
    expect(calls[0]!.url).toBe("https://fhir.example/api/FHIR/R4/Patient/p1");
  });
});

describe("FhirClient operations", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
  });
  afterEach(() => {
    delete process.env["NODE_ENV"];
  });

  it("read: GETs with bearer token", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    const res = await client.read<{ resourceType: "Patient"; id: string }>(
      "Patient",
      "p1",
    );
    expect(res.id).toBe("p1");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.endsWith("/Patient/p1")).toBe(true);
  });

  it("rejects invalid resourceType to prevent path injection", async () => {
    const { client } = makeClient({
      responses: [{ body: {} }],
    });
    await expect(
      // @ts-expect-error: testing runtime validation
      client.read("Patient/../OperationDefinition", "x"),
    ).rejects.toThrow(/Invalid FHIR resourceType/);
  });

  it("search: supports repeated params via array values", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Bundle", type: "searchset", entry: [] } }],
    });
    await client.search("Observation", { _include: ["a", "b"], code: "c1" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll("_include")).toEqual(["a", "b"]);
    expect(url.searchParams.get("code")).toBe("c1");
  });

  it("error: surfaces OperationOutcome diagnostics in message + populates outcome", async () => {
    const { client } = makeClient({
      responses: [
        {
          status: 422,
          body: {
            resourceType: "OperationOutcome",
            issue: [
              {
                severity: "error",
                code: "required",
                diagnostics: "patient missing identifier",
              },
            ],
          },
        },
      ],
    });
    const err = await client.read("Patient", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FhirError);
    const fe = err as FhirError;
    expect(fe.status).toBe(422);
    expect(fe.outcome?.issue[0]?.code).toBe("required");
    expect(fe.message).toMatch(/patient missing identifier/);
  });

  it("error: non-JSON body falls through to truncated rawBody, not an unhelpful bare status", async () => {
    const { client } = makeClient({
      responses: [
        {
          status: 502,
          body: "<html><body>Bad Gateway from edge</body></html>",
          headers: { "content-type": "text/html" },
        },
      ],
    });
    const err = await client.read("Patient", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FhirError);
    expect((err as FhirError).rawBody).toContain("Bad Gateway from edge");
    expect((err as FhirError).message).toMatch(/Bad Gateway from edge/);
  });

  it("update: requires id, PUTs to /:type/:id, no If-Match by default", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update({
      resourceType: "Patient",
      id: "p1",
    } as { resourceType: "Patient"; id: string });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.endsWith("/Patient/p1")).toBe(true);
    expect(calls[0]!.ifMatch).toBeNull();
  });

  it("update: sends If-Match when versionId is provided explicitly", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update(
      { resourceType: "Patient", id: "p1" } as {
        resourceType: "Patient";
        id: string;
      },
      { versionId: "42" },
    );
    expect(calls[0]!.ifMatch).toBe('W/"42"');
  });

  it("update: derives versionId from resource.meta when options.versionId is omitted", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update({
      resourceType: "Patient",
      id: "p1",
      meta: { versionId: "7" },
    } as { resourceType: "Patient"; id: string; meta: { versionId: string } });
    expect(calls[0]!.ifMatch).toBe('W/"7"');
  });

  it("update: explicit { versionId: undefined } suppresses the header even when meta has a value", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update(
      {
        resourceType: "Patient",
        id: "p1",
        meta: { versionId: "7" },
      } as { resourceType: "Patient"; id: string; meta: { versionId: string } },
      { versionId: undefined },
    );
    expect(calls[0]!.ifMatch).toBeNull();
  });

  it("update: passes already-quoted ETags through unchanged", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update(
      { resourceType: "Patient", id: "p1" } as {
        resourceType: "Patient";
        id: string;
      },
      { versionId: 'W/"already-formatted"' },
    );
    expect(calls[0]!.ifMatch).toBe('W/"already-formatted"');
  });
});

describe("FhirClient retry + idempotency", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
  });
  afterEach(() => {
    delete process.env["NODE_ENV"];
  });

  it("create: forwards Idempotency-Key header verbatim", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "DocumentReference", id: "dr1" } }],
    });
    await client.create(
      { resourceType: "DocumentReference" } as { resourceType: "DocumentReference" },
      { idempotencyKey: "idem_abc" },
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.idempotencyKey).toBe("idem_abc");
  });

  it("create: without idempotency key, does NOT retry on 503 (avoids duplicate write)", async () => {
    const { client, fetchImpl } = makeClient({
      responses: [{ status: 503, body: "down" }],
    });
    await expect(
      client.create({ resourceType: "DocumentReference" } as {
        resourceType: "DocumentReference";
      }),
    ).rejects.toThrow(FhirError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("create: with idempotency key, retries 503 until success", async () => {
    const { client, fetchImpl, sleeps } = makeClient({
      responses: [
        { status: 503, body: "down" },
        { status: 503, body: "down" },
        { body: { resourceType: "DocumentReference", id: "dr1" } },
      ],
    });
    const res = await client.create(
      { resourceType: "DocumentReference" } as {
        resourceType: "DocumentReference";
      },
      { idempotencyKey: "idem_retry" },
    );
    expect((res as { id: string }).id).toBe("dr1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2); // one sleep before each retry
  });

  it("create: with idempotency key, gives up after maxAttempts and throws final status", async () => {
    const { client, fetchImpl } = makeClient({
      responses: [{ status: 503, body: "still down" }],
      retry: { maxAttempts: 3 },
    });
    const err = await client
      .create(
        { resourceType: "DocumentReference" } as {
          resourceType: "DocumentReference";
        },
        { idempotencyKey: "idem_giveup" },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FhirError);
    expect((err as FhirError).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("read: retries 429 on idempotent GET and honors Retry-After (seconds)", async () => {
    const { client, fetchImpl, sleeps } = makeClient({
      responses: [
        { status: 429, body: "slow down", headers: { "retry-after": "2" } },
        { body: { resourceType: "Patient", id: "p1" } },
      ],
    });
    await client.read("Patient", "p1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBe(2000); // 2s honoured verbatim
  });

  it("read: non-retryable 4xx (404) returns immediately, no retry", async () => {
    const { client, fetchImpl } = makeClient({
      responses: [{ status: 404, body: { resourceType: "OperationOutcome", issue: [] } }],
    });
    await expect(client.read("Patient", "missing")).rejects.toThrow(FhirError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retry: applies ±20% jitter to computed backoff (Retry-After unaffected)", async () => {
    // Drive random() to 0 and 1 to land at the jitter window edges:
    //   random=0  → multiplier = 1 + 0.2 * (0*2 - 1) = 0.8
    //   random=1  → multiplier = 1 + 0.2 * (1*2 - 1) = 1.2
    // baseDelayMs=100 keeps the math obvious; cap is large enough not
    // to clip the second retry's 200ms base.
    const randoms = [0, 1];
    let i = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const client = new (
      await import("./client")
    ).FhirClient({
      baseUrl: "https://fhir.example/r4",
      getToken: () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => randoms[i++ % randoms.length]!,
    });

    await client
      .read("Patient", "p1")
      .catch((e: unknown) => e);

    // Two retries → two sleeps. First sleep uses random=0 → 100 * 0.8 = 80ms.
    // Second sleep uses random=1 → 200 * 1.2 = 240ms.
    expect(sleeps).toEqual([80, 240]);
  });
});
