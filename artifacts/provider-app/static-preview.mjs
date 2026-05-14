// Tiny static server for showing the SPA on mobile without a real
// api-server. Three responsibilities:
//   1. Serve dist/* with correct content types and SPA-fallback routing
//   2. Pretend the user is signed in (fake /api/auth/me) so RequireAuth-
//      gated routes (including /dev/sandbox) actually render
//   3. Proxy /api/dev/sandbox-patients to athenahealth's Preview sandbox
//      using the 2-legged client_credentials path, so the /dev/sandbox
//      page shows live patient data on mobile
//
// Usage (from artifacts/provider-app/):
//   node --env-file=../../.env ./static-preview.mjs

import { Buffer } from "node:buffer";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(here, "dist");
const port = Number(process.env.PORT) || 8080;

if (!existsSync(distDir)) {
  console.error(`No dist directory at ${distDir}. Run 'vite build' first.`);
  process.exit(1);
}

const FAKE_USER = {
  id: "usr_static_preview",
  email: "alice@halonote.example",
  displayName: "Dr. Alice Chen",
  role: "admin",
  twoFactorEnabled: false,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Sandbox token cache + Athena calls
// ---------------------------------------------------------------------------

let cachedToken = null; // { value, expiresAt }

async function getSandboxToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const id = process.env.ATHENA_SANDBOX_CLIENT_ID;
  const secret = process.env.ATHENA_SANDBOX_CLIENT_SECRET;
  const scope = process.env.ATHENA_SANDBOX_SCOPE;
  const tokenUrl = process.env.ATHENA_TOKEN_URL;
  if (!id || !secret || !scope || !tokenUrl) {
    throw new Error(
      "Missing ATHENA_SANDBOX_CLIENT_ID / SECRET / SCOPE or ATHENA_TOKEN_URL",
    );
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

async function querySandboxPatients() {
  const practiceId = process.env.ATHENA_SANDBOX_PRACTICE_ID;
  const fhirBase = process.env.ATHENA_FHIR_BASE_URL;
  if (!practiceId || !fhirBase) {
    throw new Error("Missing ATHENA_SANDBOX_PRACTICE_ID / ATHENA_FHIR_BASE_URL");
  }
  const token = await getSandboxToken();
  const url = new URL(`${fhirBase.replace(/\/+$/, "")}/Patient`);
  url.searchParams.set(
    "ah-practice",
    `Organization/a-1.Practice-${practiceId}`,
  );
  url.searchParams.set("name", "Sandboxtest");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Patient search failed: ${res.status} ${await res.text()}`,
    );
  }
  const bundle = await res.json();
  const patients = (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter(Boolean)
    .map((p) => {
      const n = p.name?.[0] ?? {};
      return {
        ehrId: p.id ?? "",
        firstName: Array.isArray(n.given) ? n.given.join(" ") : "",
        lastName: typeof n.family === "string" ? n.family : "",
        dateOfBirth: typeof p.birthDate === "string" ? p.birthDate : "",
        mrn: p.id ?? "",
      };
    });
  return { practiceId, count: patients.length, patients };
}

// ---------------------------------------------------------------------------
// Mock schedule generator
// ---------------------------------------------------------------------------

// Five appointments for today, tied to the real Sandboxtest patient ids
// in Athena Preview Practice 195900. Times are local to whoever's viewing.
function buildMockSchedule() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const slots = [
    { h: 9, m: 0, ehrId: "a-195900.E-60178", display: "Sandboxtest, Donna", reason: "Hypertension follow-up", status: "booked" },
    { h: 9, m: 30, ehrId: "a-195900.E-60181", display: "Sandbox-Test, Anna", reason: "Annual physical", status: "booked" },
    { h: 10, m: 15, ehrId: "a-195900.E-60183", display: "Sandboxtest, Gary", reason: "Diabetes management", status: "booked" },
    { h: 11, m: 0, ehrId: "a-195900.E-60182", display: "Sandbox-Test, Rebecca", reason: "Telehealth — back pain", status: "booked" },
    { h: 14, m: 0, ehrId: "a-195900.E-60184", display: "Sandboxtest, Dorrie", reason: "Medication refill", status: "booked" },
    { h: 14, m: 30, ehrId: "a-195900.E-60180", display: "Sandboxtest, Frankie", reason: "Well-child visit", status: "booked" },
  ];

  return slots.map((s, i) => {
    const start = new Date(today);
    start.setHours(s.h, s.m, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 20);
    return {
      appointmentId: `mock-appt-${today.toISOString().slice(0, 10)}-${i}`,
      start: start.toISOString(),
      end: end.toISOString(),
      status: s.status,
      reason: s.reason,
      patient: { ehrId: s.ehrId, display: s.display },
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendIndex(res) {
  const indexPath = join(distDir, "index.html");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(indexPath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  // --- Stubbed API surface ---
  // /api/auth/me returns a fake user so RequireAuth-wrapped routes render.
  if (path === "/api/auth/me") {
    return sendJson(res, 200, FAKE_USER);
  }
  // Live proxy to Athena Preview sandbox.
  if (path === "/api/dev/sandbox-patients") {
    try {
      const data = await querySandboxPatients();
      return sendJson(res, 200, data);
    } catch (err) {
      console.error("[static-preview] sandbox query failed:", err);
      return sendJson(res, 502, {
        error: "sandbox_query_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Mock today's schedule with five appointments tied to real Sandboxtest
  // patient ids — so the Today page renders with realistic-looking data on
  // mobile without needing the api-server / DB.
  if (path === "/api/schedule/today") {
    return sendJson(res, 200, { data: buildMockSchedule() });
  }
  // Empty arrays for collection endpoints so the SPA's list pages render
  // an empty state instead of an error toast.
  if (
    path === "/api/templates" ||
    path === "/api/patients" ||
    path === "/api/notes"
  ) {
    return sendJson(res, 200, { data: [] });
  }
  // EHR connection status — Settings page asks on mount.
  if (path === "/api/auth/ehr/status") {
    return sendJson(res, 200, { athenahealth: { connected: false } });
  }
  // Stub everything else with a "no real backend" response so the SPA's
  // react-query hooks fail gracefully (empty list / error toast) instead
  // of trying to JSON.parse a fallback HTML.
  if (path.startsWith("/api/")) {
    return sendJson(res, 503, {
      error: "api_not_available_in_static_preview",
    });
  }

  // --- Static assets ---
  const safePath = normalize(path).replace(/^[/\\]+/, "");
  const candidate = join(distDir, safePath);
  if (
    candidate.startsWith(distDir) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    const ext = extname(candidate).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "public, max-age=300",
    });
    return createReadStream(candidate).pipe(res);
  }

  // --- SPA fallback ---
  sendIndex(res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Static preview on http://0.0.0.0:${port}`);
});
