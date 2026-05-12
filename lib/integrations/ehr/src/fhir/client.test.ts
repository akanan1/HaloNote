import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { FhirClient, FhirError } from "./client";

interface FakeCall {
  url: string;
  method: string;
  body: string | null;
}

function makeClient(opts: {
  responses: Array<{
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  }>;
  baseUrl?: string;
}) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
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
    }),
    fetchImpl,
    calls,
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

  it("update: requires id, PUTs to /:type/:id", async () => {
    const { client, calls } = makeClient({
      responses: [{ body: { resourceType: "Patient", id: "p1" } }],
    });
    await client.update({
      resourceType: "Patient",
      id: "p1",
    } as { resourceType: "Patient"; id: string });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.endsWith("/Patient/p1")).toBe(true);
  });
});
