import type { Bundle, OperationOutcome, Resource } from "./types";

export type TokenGetter = () => Promise<string> | string;

export interface RetryPolicy {
  /** Total attempts including the first. Default 4. */
  maxAttempts: number;
  /** Initial backoff in ms; doubles each attempt up to maxDelayMs. Default 250. */
  baseDelayMs: number;
  /** Cap for backoff in ms. Default 5000. */
  maxDelayMs: number;
}

export interface FhirClientOptions {
  baseUrl: string;
  getToken: TokenGetter;
  fetchImpl?: typeof fetch;
  /** Override the retry policy for idempotent requests. */
  retry?: Partial<RetryPolicy>;
  /** Sleep helper, injectable for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Source of randomness for backoff jitter. Returns a value in [0, 1).
   * Injectable so tests can pin the schedule deterministically. Defaults
   * to Math.random.
   */
  random?: () => number;
}

export type SearchParams = Record<
  string,
  string | number | boolean | Array<string | number | boolean>
>;

export interface UpdateOptions {
  /**
   * Optimistic-concurrency token. When set, the client sends an
   * `If-Match: W/"<versionId>"` header. Epic enforces this on some
   * resources; without it, concurrent edits race and the loser
   * silently overwrites the winner.
   */
  versionId?: string;
}

export interface CreateOptions {
  /**
   * Caller-supplied idempotency key forwarded as the `Idempotency-Key`
   * header. Required for any clinically-significant write (DocumentReference,
   * Observation, etc.) so the EHR server can dedupe a retried POST. Must
   * be stable across retries of the *same* logical write — callers
   * typically persist it alongside the row that triggered the push.
   *
   * Presence of this header also makes the POST eligible for automatic
   * transport-level retry on 429/503; without it, POSTs are not retried
   * (a duplicate write would silently corrupt the chart).
   */
  idempotencyKey?: string;
}

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

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

// Methods that are safe to retry without an explicit idempotency token.
// POST is intentionally excluded: a duplicate POST without server-side
// dedupe creates a duplicate resource. POST becomes retryable only when
// the caller supplied an Idempotency-Key.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

// ±20% jitter on the exponential backoff. Without jitter, N clients that
// all saw the same 503 wake up at the same millisecond and re-thunder
// the recovering server. The window is symmetric around the computed
// backoff so the expected wait is unchanged.
const JITTER_RATIO = 0.2;

export class FhirClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenGetter;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

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
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  async read<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
  ): Promise<T> {
    assertResourceType(resourceType);
    return this.request<T>(
      "GET",
      `/${resourceType}/${encodeURIComponent(id)}`,
    );
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

  async create<T extends Resource>(
    resource: T,
    options: CreateOptions = {},
  ): Promise<T> {
    assertResourceType(resource.resourceType);
    const extra = options.idempotencyKey
      ? { "idempotency-key": options.idempotencyKey }
      : undefined;
    return this.request<T>(
      "POST",
      `/${resource.resourceType}`,
      resource,
      extra,
    );
  }

  /**
   * PUT a resource. Pass `options.versionId` to send `If-Match` for
   * optimistic concurrency — either read the version off `meta.versionId`
   * of a fresh GET, or use whatever value the server returned on the
   * previous create/update.
   *
   * If `versionId` is omitted but the resource's own `meta.versionId`
   * is set, we use that as a convenience — the common path in app code
   * is `client.update({ ...readBack, body: edited })` which already
   * carries the version. Pass `{ versionId: undefined }` explicitly to
   * suppress the header for that one call.
   */
  async update<T extends Resource & { id: string }>(
    resource: T,
    options: UpdateOptions = {},
  ): Promise<T> {
    assertResourceType(resource.resourceType);
    const versionId =
      "versionId" in options
        ? options.versionId
        : resource.meta?.versionId;
    return this.request<T>(
      "PUT",
      `/${resource.resourceType}/${encodeURIComponent(resource.id)}`,
      resource,
      versionId ? { "if-match": formatETag(versionId) } : undefined,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      accept: "application/fhir+json",
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/fhir+json";
    }

    // A POST is retryable iff the caller supplied an Idempotency-Key —
    // that's the contract that lets the EHR server collapse a retry
    // into the original write instead of duplicating the chart row.
    const retryable =
      IDEMPOTENT_METHODS.has(method) || !!headers["idempotency-key"];

    let lastResponse: Response | null = null;
    let lastRaw = "";
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.ok) return (await res.json()) as T;

      const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!transient || !retryable || attempt === this.retry.maxAttempts) {
        lastResponse = res;
        lastRaw = await res.text().catch(() => "");
        break;
      }

      // Honour Retry-After when present (seconds or HTTP-date); otherwise
      // exponential backoff capped at maxDelayMs, with ±20% jitter so a
      // herd of retrying clients doesn't re-DoS the recovering server.
      // Drain the body before sleeping so the socket can be returned to
      // the pool.
      await res.text().catch(() => "");
      const headerWait = parseRetryAfter(res.headers.get("retry-after"));
      const base = Math.min(
        this.retry.maxDelayMs,
        this.retry.baseDelayMs * 2 ** (attempt - 1),
      );
      // Retry-After is a server directive — honour it verbatim. Only
      // apply jitter to our own computed backoff.
      const wait =
        headerWait ?? base * (1 + JITTER_RATIO * (this.random() * 2 - 1));
      await this.sleep(Math.max(0, Math.round(wait)));
    }

    // Build the failure error from the final response.
    const res = lastResponse!;
    const raw = lastRaw;
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
}

// Retry-After is either delta-seconds (integer) or an HTTP-date. Returns
// the wait in ms, or null when absent / unparseable.
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// FHIR ETags are weak: W/"<versionId>". Be defensive — accept either a
// bare versionId from the caller or an already-quoted ETag.
function formatETag(versionId: string): string {
  if (versionId.startsWith("W/") || versionId.startsWith('"')) {
    return versionId;
  }
  return `W/"${versionId}"`;
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
