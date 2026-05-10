import type { Bundle, OperationOutcome, Resource } from "./types";

export type TokenGetter = () => Promise<string> | string;

export interface FhirClientOptions {
  baseUrl: string;
  getToken: TokenGetter;
  fetchImpl?: typeof fetch;
}

export class FhirError extends Error {
  readonly name = "FhirError";
  readonly status: number;
  readonly outcome: OperationOutcome | null;

  constructor(
    message: string,
    status: number,
    outcome: OperationOutcome | null,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.outcome = outcome;
  }
}

export class FhirClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenGetter;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FhirClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    return this.request<T>("GET", `/${resourceType}/${encodeURIComponent(id)}`);
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string | number | boolean> = {},
  ): Promise<Bundle<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const path = `/${resourceType}` + (qs.size ? `?${qs.toString()}` : "");
    return this.request<Bundle<T>>("GET", path);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    return this.request<T>("POST", `/${resource.resourceType}`, resource);
  }

  async update<T extends Resource & { id: string }>(resource: T): Promise<T> {
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
      let outcome: OperationOutcome | null = null;
      try {
        const data = (await res.json()) as Resource;
        if (data.resourceType === "OperationOutcome") {
          outcome = data as OperationOutcome;
        }
      } catch {
        // body wasn't JSON — leave outcome null
      }
      throw new FhirError(
        `FHIR ${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        outcome,
      );
    }

    return (await res.json()) as T;
  }
}
