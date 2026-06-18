import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import {
  Shield, Lock, UserCheck, FileSearch, Building2, Hospital,
  ArrowRight, CheckCircle2, Star, Server, Eye, AlertTriangle,
  RefreshCw, Database, Globe, KeyRound, Cpu, ClipboardCheck,
  ChevronDown, ChevronUp
} from "lucide-react";
import { useState } from "react";

const trustBadges = [
  { label: "HIPAA-Ready Architecture", icon: Shield, color: "#34d399", border: "rgba(52,211,153,0.25)", glow: "rgba(52,211,153,0.08)" },
  { label: "AES-256 + TLS 1.3", icon: Lock, color: "#818cf8", border: "rgba(129,140,248,0.25)", glow: "rgba(129,140,248,0.08)" },
  { label: "SOC 2 Type II (In Progress)", icon: ClipboardCheck, color: "#f59e0b", border: "rgba(245,158,11,0.25)", glow: "rgba(245,158,11,0.08)" },
  { label: "Physician Sign-Off Required", icon: UserCheck, color: "#c084fc", border: "rgba(192,132,252,0.25)", glow: "rgba(192,132,252,0.08)" },
  { label: "7-Year Audit Log Retention", icon: FileSearch, color: "#38bdf8", border: "rgba(56,189,248,0.25)", glow: "rgba(56,189,248,0.08)" },
  { label: "US Data Residency Only", icon: Globe, color: "#34d399", border: "rgba(52,211,153,0.2)", glow: "rgba(52,211,153,0.06)" },
  { label: "BAA Available", icon: ClipboardCheck, color: "#c084fc", border: "rgba(192,132,252,0.2)", glow: "rgba(192,132,252,0.06)" },
  { label: "Zero PHI in Analytics", icon: Eye, color: "#818cf8", border: "rgba(129,140,248,0.2)", glow: "rgba(129,140,248,0.06)" },
];

const stats = [
  { value: "AES-256", label: "Encryption at rest" },
  { value: "TLS 1.3", label: "Encryption in transit" },
  { value: "US-Only", label: "Data residency" },
  { value: "7 years", label: "Audit log retention" },
  { value: "100%", label: "Notes require physician sign-off" },
  { value: "BAA", label: "Available on all plans" },
];

const infrastructure = [
  { label: "Cloud Provider", value: "Amazon Web Services (AWS)", detail: "us-east-1 (primary) · us-west-2 (failover)" },
  { label: "Database", value: "PostgreSQL via AWS RDS", detail: "Multi-AZ deployment, automated backups every 6 hours" },
  { label: "Audio Processing", value: "Isolated pipeline", detail: "Audio buffers purged within 60 seconds of processing" },
  { label: "AI Subprocessor", value: "OpenAI (GPT-4o)", detail: "Zero-retention API agreement; no training on clinical data" },
  { label: "CDN / Edge", value: "AWS CloudFront", detail: "HTTPS-only; HSTS enforced" },
  { label: "Monitoring", value: "AWS CloudWatch + Datadog", detail: "99.9% uptime SLA; PagerDuty alerting for incidents" },
];

const securityFeatures = [
  {
    icon: Shield,
    title: "HIPAA-Ready Architecture, From Day One",
    description: "Halo Note is built from the ground up with HIPAA compliance as a design principle, not an afterthought. Our architecture implements all required administrative, physical, and technical safeguards under the HIPAA Security Rule, and we execute a Business Associate Agreement (BAA) with every covered entity customer.",
    points: [
      "BAA executed with all covered entity customers before access is provisioned",
      "Administrative, physical, and technical safeguards fully documented",
      "Internal HIPAA Security Officer role designated",
      "Annual risk assessment and remediation process",
      "Workforce training on HIPAA requirements upon hire and annually",
    ],
    color: "#059669",
    bg: "#ECFDF5",
  },
  {
    icon: Lock,
    title: "End-to-End Encryption for All PHI",
    description: "Every piece of patient data, audio recordings, transcripts, clinical notes, and metadata, is encrypted in transit using TLS 1.3 and encrypted at rest using AES-256. Temporary audio buffers used during ambient recording are purged from memory within 60 seconds of processing completion.",
    points: [
      "TLS 1.3 enforced for all client-server communication; HSTS headers active",
      "AES-256-GCM encryption at rest for all stored data",
      "Audio buffers purged within 60 seconds post-processing; never persisted to disk unencrypted",
      "Database encryption at rest via AWS RDS transparent data encryption",
      "Encryption keys managed via AWS KMS with automatic 12-month rotation",
    ],
    color: "#4F46E5",
    bg: "#EEF2FF",
  },
  {
    icon: Database,
    title: "US-Only Data Residency",
    description: "All PHI and clinical data is stored and processed exclusively within the United States. We use AWS us-east-1 (N. Virginia) as our primary region and us-west-2 (Oregon) for failover. No PHI is ever transferred to, processed in, or accessible from servers outside the United States.",
    points: [
      "Primary region: AWS us-east-1 (N. Virginia)",
      "Failover region: AWS us-west-2 (Oregon)",
      "OpenAI API calls processed under zero-retention agreement, no data leaves US or is retained for training",
      "All CDN edge nodes serving authenticated PHI are US-based",
    ],
    color: "#0891B2",
    bg: "#ECFEFF",
  },
  {
    icon: UserCheck,
    title: "Mandatory Physician Review and Sign-Off",
    description: "Halo Note has a non-negotiable governance model: no AI-generated clinical note can be finalized without explicit physician review and approval. The AI surfaces a draft; the physician owns the final document. This design ensures clinical judgment is never bypassed by automation.",
    points: [
      "Status workflow: Draft → Reviewed → Finalized, each state requires explicit physician action",
      "Edit capability available at every stage; full diff view shows AI vs. physician edits",
      "Finalized notes are cryptographically timestamped and locked against further modification",
      "Clear attribution of physician authorship on every exported or pushed document",
    ],
    color: "#7C3AED",
    bg: "#F5F3FF",
  },
  {
    icon: FileSearch,
    title: "Immutable Audit Logs with 7-Year Retention",
    description: "Every action on a clinical document is logged immutably, creation, view, edit, finalization, export, and EHR push events, with millisecond-precision timestamps and authenticated user attribution. Logs are retained for 7 years to satisfy HIPAA's 6-year retention requirement with buffer.",
    points: [
      "Events logged: create, view, edit, diff, finalize, export, EHR push, delete attempt",
      "Each log entry includes: user ID, timestamp (UTC), IP address, action type, and document ID",
      "Logs are write-once and append-only; cannot be modified or deleted by any user",
      "7-year retention period, exceeding HIPAA's 6-year minimum",
      "Audit log export available in JSON and CSV for compliance reporting",
    ],
    color: "#0891B2",
    bg: "#ECFEFF",
  },
  {
    icon: Building2,
    title: "Multi-Tenant Data Isolation and RBAC",
    description: "Halo Note uses a multi-tenant architecture where each organization's data is logically isolated at the database level. Row-level security policies ensure that no query can ever return data belonging to another organization, even in the event of an application-level bug.",
    points: [
      "Organization-scoped row-level security on all PHI tables",
      "Role-based access control: Physician, Admin, and Staff roles with distinct permission sets",
      "Invite-code onboarding, no self-provisioning without organization admin approval",
      "Session tokens are org-scoped and cryptographically bound to the issuing organization",
    ],
    color: "#D97706",
    bg: "#FFFBEB",
  },
  {
    icon: Cpu,
    title: "AI Subprocessor Controls",
    description: "Our AI capabilities are powered by OpenAI's GPT-4o under a zero-data-retention API agreement, meaning no clinical content submitted via our API is retained by OpenAI or used for model training. All prompts are constructed server-side and never pass through the client browser.",
    points: [
      "Zero-retention API agreement with OpenAI, no PHI is stored or used for training",
      "All AI prompts constructed server-side; clinical content never transmitted via client browser",
      "No third-party analytics tools (e.g., Google Analytics, Mixpanel) receive or process PHI",
      "Subprocessor list published and updated within 30 days of any change",
    ],
    color: "#7C3AED",
    bg: "#F5F3FF",
  },
  {
    icon: RefreshCw,
    title: "Penetration Testing and Vulnerability Management",
    description: "We conduct annual third-party penetration tests against our production environment and remediate critical and high findings within defined SLAs. Our vulnerability disclosure program allows security researchers to responsibly report issues.",
    points: [
      "Annual penetration test by independent third-party security firm",
      "Critical findings: remediated within 48 hours of discovery",
      "High findings: remediated within 7 business days",
      "Continuous automated SAST and dependency vulnerability scanning in CI/CD pipeline",
      "Responsible disclosure program: security@halonote.app",
    ],
    color: "#059669",
    bg: "#ECFDF5",
  },
  {
    icon: Hospital,
    title: "EHR Integration Safety and Authorization",
    description: "Every EHR connection is configured with the minimum required OAuth scopes using the SMART on FHIR authorization framework. Push operations to external EHR systems require explicit physician authorization at the time of action, no automated or background writes occur without user intent.",
    points: [
      "SMART on FHIR OAuth 2.0 for Epic and Cerner connections",
      "Minimum-scope principle, only scopes required for documented functionality are requested",
      "Physician authorization required at the moment of every EHR push",
      "Full audit log of all outbound FHIR write operations",
      "Sandbox connection testing environment available before production activation",
    ],
    color: "#14B8A6",
    bg: "#F0FDFA",
  },
];

const faq = [
  {
    q: "Will Halo Note sign a Business Associate Agreement (BAA)?",
    a: "Yes. We execute a BAA with every covered entity customer before access to PHI is provisioned. Contact our team via the request access form and we will send a BAA for review within one business day."
  },
  {
    q: "Is my clinical data used to train AI models?",
    a: "No. We operate under a zero-data-retention agreement with our AI subprocessor (OpenAI). No clinical content you submit is retained beyond the immediate API call, and none of your data is ever used to train AI models."
  },
  {
    q: "Where is patient data stored geographically?",
    a: "All PHI is stored and processed exclusively within the United States on AWS infrastructure (us-east-1 primary, us-west-2 failover). No data is ever transferred outside US jurisdiction."
  },
  {
    q: "What certifications does Halo Note hold?",
    a: "We are currently pursuing SOC 2 Type II certification (audit in progress, expected completion Q3 2025). Our architecture is HIPAA-ready and we operate under a formal HIPAA compliance program with a designated Security Officer."
  },
  {
    q: "How long are audit logs retained?",
    a: "Audit logs are retained for 7 years, one year beyond HIPAA's 6-year minimum requirement. Logs are immutable (write-once, append-only) and can be exported by your organization administrator for compliance reporting."
  },
  {
    q: "Can I get a security review or questionnaire completed?",
    a: "Yes. We regularly complete vendor security questionnaires for hospital systems and large practices. Submit your questionnaire or request a security review meeting via our request access form."
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-100 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-5 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-[15px] font-semibold text-gray-800 pr-4">{q}</span>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
      </button>
      {open && (
        <div className="px-6 pb-5">
          <p className="text-[14px] text-gray-500 leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  );
}

export default function SecurityPage() {
  return (
    <MarketingLayout darkHero>
      <SEOMeta
        title="Security & Compliance, Halo Note"
        description="Halo Note is built with HIPAA-ready architecture, AES-256 encryption, US-only data residency, 7-year audit logs, and SOC 2 Type II in progress. Patient data deserves uncompromising protection."
      />

      {/* Dark Hero */}
      <section className="relative overflow-hidden bg-gray-950">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }} />
        <div className="absolute pointer-events-none" style={{
          top: "-10%", left: "50%", transform: "translateX(-50%)",
          width: "820px", height: "520px",
          background: "radial-gradient(ellipse at center, rgba(16,185,129,0.13) 0%, transparent 70%)",
        }} />

        <div className="relative max-w-5xl mx-auto px-5 sm:px-8 lg:px-10 pt-36 pb-20 md:pt-44 md:pb-24 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 text-[12px] font-semibold tracking-wide uppercase mb-8" data-testid="badge-security">
            <Shield className="w-3.5 h-3.5" />
            Security &amp; Compliance
          </div>

          <h1 className="text-4xl md:text-[3.6rem] font-black tracking-[-0.03em] leading-[1.06] mb-6 text-white" data-testid="text-security-headline">
            Patient data deserves<br />
            <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              uncompromising protection.
            </span>
          </h1>

          <p className="text-[17px] text-gray-400 max-w-2xl mx-auto mb-12 leading-relaxed">
            HIPAA-ready from day one. AES-256 encryption. US-only data residency. SOC 2 Type II in progress. 7-year audit retention. BAA on every plan.
          </p>

          {/* Trust badge grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10" data-testid="trust-badges">
            {trustBadges.map((badge, i) => (
              <div
                key={i}
                className="flex flex-col items-center gap-3 p-4 rounded-2xl border transition-all duration-300 hover:-translate-y-0.5"
                style={{ borderColor: badge.border, background: badge.glow }}
                data-testid={`trust-badge-${i}`}
              >
                <badge.icon className="w-5 h-5" style={{ color: badge.color }} />
                <span className="text-[11px] font-semibold text-gray-300 text-center leading-snug">{badge.label}</span>
              </div>
            ))}
          </div>

          {/* Stats bar */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-white/[0.06] rounded-2xl overflow-hidden border border-white/[0.06]">
            {stats.map((s, i) => (
              <div key={i} className="flex flex-col items-center gap-1 py-5 px-3 bg-gray-950/80">
                <span className="text-lg font-black text-white tracking-tight">{s.value}</span>
                <span className="text-[10px] text-gray-500 text-center leading-snug">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Fade */}
      <div className="h-16 w-full" style={{ background: "linear-gradient(to bottom, #030712 0%, #ffffff 100%)" }} />

      {/* Infrastructure specs */}
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center">
              <Server className="w-4 h-4 text-gray-500" />
            </div>
            <div>
              <div className="text-[16px] font-bold text-gray-900">Infrastructure Specifications</div>
              <div className="text-[12px] text-gray-400">For enterprise security reviewers and procurement teams</div>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-100 overflow-hidden">
            {infrastructure.map((item, i) => (
              <div key={i} className={`grid grid-cols-1 md:grid-cols-3 gap-2 px-5 py-4 ${i % 2 === 0 ? "bg-white" : "bg-gray-50/50"} ${i > 0 ? "border-t border-gray-100" : ""}`}>
                <div className="text-[12px] font-bold text-gray-500 uppercase tracking-wide pt-0.5">{item.label}</div>
                <div className="text-[13px] font-semibold text-gray-800">{item.value}</div>
                <div className="text-[12px] text-gray-400">{item.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security Features */}
      <section className="pb-16 md:pb-24 bg-white">
        <div className="max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 space-y-4">
          <h2 className="text-2xl font-black text-gray-950 mb-8">Security controls in depth</h2>
          {securityFeatures.map((feature, i) => (
            <div key={i} className="group p-7 md:p-8 rounded-2xl bg-[#FAFAF7] border border-gray-100 hover:bg-white hover:shadow-lg hover:border-gray-200/80 transition-all duration-500" data-testid={`section-security-${i}`}>
              <div className="flex items-start gap-4 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: feature.bg }}>
                  <feature.icon className="w-5 h-5" style={{ color: feature.color }} />
                </div>
                <h3 className="text-[17px] md:text-[19px] font-bold text-[#1a1a2e] pt-1.5">{feature.title}</h3>
              </div>
              <p className="text-[14px] text-gray-500 leading-relaxed mb-5 ml-14">
                {feature.description}
              </p>
              <ul className="space-y-2.5 ml-14">
                {feature.points.map((point, j) => (
                  <li key={j} className="flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: feature.color }} />
                    <span className="text-[13px] text-gray-600 leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-20 bg-gray-50 border-t border-gray-100">
        <div className="max-w-3xl mx-auto px-5 sm:px-8">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-black text-gray-950 mb-3">Common security questions</h2>
            <p className="text-gray-500 text-[15px]">For procurement teams, IT departments, and compliance officers.</p>
          </div>
          <div className="space-y-3">
            {faq.map((item, i) => (
              <FaqItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative py-24 md:py-32 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] via-[#252545] to-[#1a1a2e]" />
        <div className="absolute top-[-30%] left-[40%] w-[400px] h-[400px] bg-[#059669]/[0.1] rounded-full blur-[120px]" />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 lg:px-10 text-center text-white">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.08] border border-white/[0.1] text-[13px] font-medium text-gray-300 mb-8">
            <Star className="w-4 h-4 text-[#F59E0B]" />
            Security Review Available
          </div>
          <h2 className="text-3xl md:text-[2.75rem] font-bold mb-6 tracking-[-0.02em]">
            Need a security questionnaire completed?
          </h2>
          <p className="text-gray-400 mb-12 leading-relaxed text-[17px]">
            We complete vendor security questionnaires, CAIQ assessments, and custom security reviews for hospital systems and large practices. Our security team responds within one business day.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/request-access">
              <Button size="lg" className="bg-white text-[#1a1a2e] hover:bg-gray-100 font-bold px-10 h-14 text-[15px] rounded-full shadow-[0_4px_20px_rgba(255,255,255,0.15)] hover:shadow-[0_6px_30px_rgba(255,255,255,0.2)] transition-all duration-500 group" data-testid="button-security-cta">
                Request Access + BAA
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform duration-300" />
              </Button>
            </Link>
            <a href="mailto:security@halonote.app">
              <Button size="lg" variant="outline" className="border-white/20 text-white hover:bg-white/10 font-semibold px-8 h-14 text-[15px] rounded-full" data-testid="button-security-email">
                security@halonote.app
              </Button>
            </a>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
