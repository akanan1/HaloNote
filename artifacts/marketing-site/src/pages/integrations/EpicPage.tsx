import { Link } from "wouter";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  FileText,
  KeyRound,
  ShieldCheck,
  Stethoscope,
  Workflow,
} from "lucide-react";

const SCOPES = [
  { code: "openid fhirUser", purpose: "Identify the launching practitioner" },
  { code: "launch/patient offline_access", purpose: "Resume across encounters and refresh long-lived tokens" },
  { code: "patient/Patient.read", purpose: "Pull demographics for the in-context patient" },
  { code: "patient/Encounter.read", purpose: "Anchor the note to the active visit" },
  { code: "patient/Condition.read", purpose: "Surface problem list during scribing" },
  { code: "patient/Observation.read", purpose: "Surface vitals and labs during scribing" },
  { code: "patient/MedicationRequest.read", purpose: "Surface active medications during scribing" },
  { code: "patient/AllergyIntolerance.read", purpose: "Surface allergies during scribing" },
  { code: "patient/DocumentReference.read", purpose: "Show prior visit notes to the physician" },
  { code: "patient/DocumentReference.write", purpose: "Push the signed clinical note back to the chart" },
];

const FEATURES = [
  {
    icon: Workflow,
    title: "SMART on FHIR launch",
    detail:
      "Standalone provider-facing launch and EHR-launched flows on R4. Authorization code with PKCE; rolling refresh tokens for persistent access.",
  },
  {
    icon: KeyRound,
    title: "private_key_jwt confidential client",
    detail:
      "No static client secrets in production. Halo Note authenticates with a signed JWT assertion; the public key is published at https://api.halonote.app/.well-known/jwks.json.",
  },
  {
    icon: FileText,
    title: "DocumentReference write-back",
    detail:
      "Signed notes are written to Epic as FHIR R4 DocumentReference resources, attributed to the launching practitioner and bound to the active Encounter.",
  },
  {
    icon: Stethoscope,
    title: "Chart context at point of scribing",
    detail:
      "Patient demographics, active problems, vitals, medications, and allergies are read live from Epic so the generated note reflects the current chart.",
  },
];

const FACTS = [
  { label: "FHIR version", value: "R4" },
  { label: "SMART scope version", value: "SMART v2" },
  { label: "Client type", value: "Confidential, persistent" },
  { label: "Signing algorithm", value: "ES384" },
  { label: "Audience", value: "Clinicians and administrative users" },
  { label: "Use case", value: "General (ambient clinical documentation)" },
];

const ENDPOINTS = [
  { label: "JWKS (sandbox + production)", value: "https://api.halonote.app/.well-known/jwks.json" },
  { label: "OAuth redirect URI", value: "https://api.halonote.app/api/auth/ehr/callback" },
  { label: "Support", value: "epic-integration@halonote.app" },
];

export default function EpicPage() {
  return (
    <MarketingLayout>
      <SEOMeta
        title="Halo Note for Epic — Ambient AI Clinical Documentation"
        description="Halo Note is a SMART on FHIR application that integrates with Epic to deliver ambient AI-generated clinical notes pushed directly to the chart."
      />

      <div className="bg-gradient-to-b from-slate-50 to-white">
        <section className="mx-auto max-w-5xl px-6 py-20">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            <Activity className="h-3.5 w-3.5" />
            SMART on FHIR · R4 · Confidential client
          </div>
          <h1 className="text-5xl font-semibold tracking-tight text-slate-900">
            Halo Note for Epic
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-600">
            Halo Note is an ambient AI clinical documentation platform. When
            launched from Epic, it listens to the encounter, generates a
            specialty-specific note, and writes the signed note back to the
            patient's chart as a FHIR DocumentReference. Halo Note is purpose-
            built for the bedside clinician — no admin staff in between, no
            export gymnastics.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/request-access"
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Request a sandbox connection
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/security"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Security &amp; HIPAA posture
            </Link>
          </div>
        </section>
      </div>

      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-slate-900">
          How the integration works
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <f.icon className="h-6 w-6 text-blue-600" />
              <h3 className="mt-3 text-base font-semibold text-slate-900">
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {f.detail}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-slate-50">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-slate-900">
            Requested SMART scopes
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Halo Note requests the minimum scope set needed for ambient
            documentation. Each scope is justified by a specific element of
            the generated note. Customers control which scopes are granted at
            their Epic build review.
          </p>
          <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Scope</th>
                  <th className="px-5 py-3 font-medium">Why Halo Note needs it</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SCOPES.map((s) => (
                  <tr key={s.code}>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-800">
                      {s.code}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{s.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">
              Registration facts
            </h2>
            <dl className="mt-6 space-y-3 text-sm">
              {FACTS.map((f) => (
                <div
                  key={f.label}
                  className="flex justify-between gap-4 border-b border-slate-100 pb-2"
                >
                  <dt className="text-slate-500">{f.label}</dt>
                  <dd className="font-medium text-slate-900">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">
              Public endpoints
            </h2>
            <dl className="mt-6 space-y-3 text-sm">
              {ENDPOINTS.map((e) => (
                <div key={e.label}>
                  <dt className="text-slate-500">{e.label}</dt>
                  <dd className="break-all font-mono text-xs text-slate-900">
                    {e.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="bg-slate-900 text-slate-100">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="flex items-start gap-4">
            <ShieldCheck className="mt-1 h-8 w-8 text-emerald-400" />
            <div>
              <h2 className="text-2xl font-semibold">Data handling and HIPAA</h2>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
                Halo Note executes a BAA with every covered-entity customer
                before access is provisioned. All PHI is encrypted in transit
                (TLS 1.3) and at rest (AES-256). Audio buffers are purged
                within 60 seconds of processing. Generated notes always
                require physician sign-off before they are written back to
                Epic. Full HIPAA security and data-handling documentation:
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href="/security"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Security overview
                </Link>
                <Link
                  href="/hipaa-notice"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  HIPAA notice
                </Link>
                <Link
                  href="/baa"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  Business Associate Agreement
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
