import type { Bundle, OperationOutcome, Resource } from "./types";

export type TokenGetter = () => Promise<string> | string;

export interface FhirClientOptions {
  baseUrl: string;
  getToken: TokenGetter;
  fetchImpl?: typeof fetch;
}

export type SearchParams = Record<
  string,
  string | number | boolean | Array<string | number | boolean>
>;

const RESOURCE_TYPE_RE = /^[A-Z][A-Za-z]+$/;

export class FhirError extends Error {
  override readonly name = "FhirError";
  readonly status: number;
  readonly outcome: OperationOutcome | null;
  readonly rawBody: string | null;

  constructor(
    message: string,
    status: number,
    outcome: OperationOutcome | null,
    rawBody: string | null = null,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.outcome = outcome;
    this.rawBody = rawBody;
  }
}

function assertResourceType(resourceType: string): void {
  if (!RESOURCE_TYPE_RE.test(resourceType)) {
    throw new Error(`Invalid FHIR resourceType: ${resourceType}`);
  }
}

export class FhirClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenGetter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FhirClientOptions) {
    const trimmed = opts.baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error(
        `FhirClient baseUrl must start with http:// or https:// (got ${opts.baseUrl}).`,
      );
    }
    if (!/^https:\/\//i.test(trimmed) && process.env["NODE_ENV"] === "production") {
      throw new Error(
        `FhirClient baseUrl must be HTTPS in production (got ${trimmed}).`,
      );
    }
    this.baseUrl = trimmed;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    assertResourceType(resourceType);
    return this.request<T>("GET", `/${resourceType}/${encodeURIComponent(id)}`);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: SearchParams = {},
  ): Promise<Bundle<T>> {
    assertResourceType(resourceType);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        // FHIR allows repeated query params (e.g. `_include`, `code`).
        for (const item of v) qs.append(k, String(item));
      } else {
        qs.append(k, String(v));
      }
    }
    const path = `/${resourceType}` + (qs.size ? `?${qs.toString()}` : "");
    return this.request<Bundle<T>>("GET", path);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    assertResourceType(resource.resourceType);
    return this.request<T>("POST", `/${resource.resourceType}`, resource);
  }

  async update<T extends Resource & { id: string }>(resource: T): Promise<T> {
    assertResourceType(resource.resourceType);
    return this.request<T>(
      "PUT",
      `/${resource.resourceType}/${encodeURIComponent(resource.id)}`,
      resource,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      accept: "application/fhir+json",
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/fhir+json";
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Read once, then try JSON. Non-JSON proxy errors (502 HTML pages,
      // plain text gateway timeouts) used to surface as a bare status code
      // with no diagnostic detail.
      const raw = await res.text().catch(() => "");
      let outcome: OperationOutcome | null = null;
      if (raw) {
        try {
          const data = JSON.parse(raw) as Resource;
          if (data.resourceType === "OperationOutcome") {
            outcome = data as OperationOutcome;
          }
        } catch {
          // not JSON
        }
      }
      const detail = outcome
        ? summarizeOutcome(outcome)
        : raw
          ? truncate(raw, 200)
          : "";
      throw new FhirError(
        `FHIR ${method} ${path} failed: ${res.status} ${res.statusText}` +
          (detail ? ` — ${detail}` : ""),
        res.status,
        outcome,
        raw || null,
      );
    }

    return (await res.json()) as T;
  }
}

function summarizeOutcome(outcome: OperationOutcome): string {
  const first = outcome.issue[0];
  if (!first) return "";
  const parts = [first.severity, first.code, first.diagnostics].filter(Boolean);
  return parts.join(" / ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
