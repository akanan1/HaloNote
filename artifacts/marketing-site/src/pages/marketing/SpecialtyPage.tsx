import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import {
  ArrowRight, CheckCircle2, Mic, Sparkles, FileText, Activity,
  Heart, Brain, Stethoscope, Code2, Globe, BarChart3,
  Clock, Users, Shield, ChevronRight
} from "lucide-react";

/* ── Specialty configs ──────────────────────────────────────────── */
export const SPECIALTIES = {
  "primary-care": {
    id: "primary-care",
    name: "Primary Care",
    icon: Stethoscope,
    heroColor: "#2563eb",
    gradientFrom: "#1d4ed8",
    gradientTo: "#0891b2",
    badge: "Family Medicine · Internal Medicine · Geriatrics",
    tagline: "Less charting. More care.",
    headline: "Documentation built for the pace of primary care.",
    subheadline: "See 20+ patients a day without spending your evenings on charts. Halo Note handles the documentation, you handle the relationship.",
    stat1: { value: "2.3 hrs", label: "Saved per provider per day" },
    stat2: { value: "36+", label: "Primary care templates" },
    stat3: { value: "< 90s", label: "Note ready after encounter" },
    painPoints: [
      "Finishing charts at 8pm, or midnight",
      "Copy-pasting the same ROS and physical exam every visit",
      "HCC opportunities missed because there's no time to code",
      "Inbox paralysis while patients are waiting in exam rooms",
    ],
    features: [
      {
        icon: Mic,
        title: "Ambient listening, no push to talk",
        desc: "Just see your patient. Halo Note listens to the full encounter and structures the note automatically in your preferred template: SOAP, H&P, Progress Note, or any of 36 specialty formats.",
        color: "#2563eb",
      },
      {
        icon: Code2,
        title: "Automatic ICD-10, CPT, and HCC coding",
        desc: "Halo Coder analyzes every note and surfaces accurate billing codes before you sign. HCC opportunities are flagged with one-click addition, recapturing revenue you're currently leaving behind.",
        color: "#0891b2",
      },
      {
        icon: FileText,
        title: "Pre-visit intelligence from your EHR",
        desc: "Halo PreChart pulls the patient's history, medications, labs, and last encounter from Epic, Cerner, or Athena before the appointment, so you walk in prepared, not scrambling.",
        color: "#7c3aed",
      },
      {
        icon: BarChart3,
        title: "Practice analytics that matter",
        desc: "Track your note volume, average completion time, coding rate, and EHR push success across your entire practice, updated in real time.",
        color: "#059669",
      },
    ],
    templates: ["SOAP Note", "Annual Wellness Visit", "Geriatric Assessment", "Chronic Disease Management", "Preventive Care", "Urgent Care Encounter"],
    quote: {
      text: "I used to stay until 7:30 every night finishing notes. Now I leave within 30 minutes of my last patient. The difference is real.",
      name: "Dr. M.L., Family Medicine",
      city: "Phoenix, AZ",
    },
    seoTitle: "AI Scribe for Primary Care, Halo Note",
    seoDesc: "Halo Note helps family medicine and internal medicine physicians cut charting time by 2+ hours per day with ambient AI documentation, automatic ICD-10 coding, and native EHR integration.",
  },

  "cardiology": {
    id: "cardiology",
    name: "Cardiology",
    icon: Heart,
    heroColor: "#dc2626",
    gradientFrom: "#b91c1c",
    gradientTo: "#9f1239",
    badge: "Interventional · Non-Invasive · Electrophysiology · Heart Failure",
    tagline: "Precision documentation. Zero shortcuts.",
    headline: "Clinical notes as complex as the cases you treat.",
    subheadline: "Cardiology encounters are dense. EF percentages, rhythm interpretations, catheterization findings, Halo Note captures it all, structures it correctly, and pushes it to the chart.",
    stat1: { value: "94/100", label: "Average note quality score" },
    stat2: { value: "13", label: "EHRs with native FHIR push" },
    stat3: { value: "< 90s", label: "Note ready for review" },
    painPoints: [
      "Dictating findings from cath lab, echo, and EKG in separate systems",
      "Missing E/M level opportunities due to documentation gaps",
      "Procedure notes that don't capture the clinical complexity of the case",
      "AF management notes that don't document CHA₂DS₂-VASc and CHADS",
    ],
    features: [
      {
        icon: Mic,
        title: "Captures clinical nuance, not just demographics",
        desc: "Halo Note is trained to recognize cardiology-specific terminology: EF values, rhythm interpretations, stress test results, catheterization findings, valve gradients. The note reflects what happened, completely.",
        color: "#dc2626",
      },
      {
        icon: Activity,
        title: "Note quality scoring with gap detection",
        desc: "Every note receives a 0–100 quality score. The system flags missing elements, risk stratification, medication contraindication notes, procedure indications, before you sign.",
        color: "#9f1239",
      },
      {
        icon: Code2,
        title: "Cardiology-specific CPT and E/M coding",
        desc: "Halo Coder identifies the correct E/M level, procedure codes, and modifier sets for cardiology encounters, echocardiography interpretations, stress tests, device checks, and more.",
        color: "#7c3aed",
      },
      {
        icon: FileText,
        title: "Pre-charting with full cardiac history",
        desc: "Walk into every consult knowing: prior cath results, echo findings, current antithrombotic regimen, implanted device parameters, and last EKG interpretation, pulled directly from the EHR.",
        color: "#0891b2",
      },
    ],
    templates: ["Cardiology Consult", "Echocardiography Report", "Stress Test Interpretation", "Heart Failure Follow-up", "Atrial Fibrillation Management", "Post-Procedure Note", "Device Clinic Note"],
    quote: {
      text: "The note quality score catches things I used to miss under time pressure, missing risk stratification, incomplete medication documentation. It's like having a second set of eyes.",
      name: "Dr. T.O., Interventional Cardiology",
      city: "Houston, TX",
    },
    seoTitle: "AI Scribe for Cardiology, Halo Note",
    seoDesc: "Halo Note generates precise cardiology clinical notes, capturing EF values, rhythm interpretations, and procedure findings, with automatic CPT coding and native Epic/Cerner integration.",
  },

  "psychiatry": {
    id: "psychiatry",
    name: "Psychiatry & Behavioral Health",
    icon: Brain,
    heroColor: "#7c3aed",
    gradientFrom: "#6d28d9",
    gradientTo: "#4c1d95",
    badge: "Psychiatry · Psychology · Therapy · Addiction Medicine",
    tagline: "The room stays present. The chart writes itself.",
    headline: "Behavioral health documentation built with privacy and clinical depth in mind.",
    subheadline: "Mental health sessions require your full attention and a high standard of documentation. Halo Note delivers both, with sensitive data protections that go beyond standard HIPAA requirements.",
    stat1: { value: "45 min", label: "Full session captured" },
    stat2: { value: "40+", label: "Languages for diverse patient populations" },
    stat3: { value: "0", label: "PHI shared with third-party analytics" },
    painPoints: [
      "Writing process notes by hand after every therapy session",
      "DAP and BIRP notes that take longer than the session itself",
      "Risk documentation that needs to be precise and legally defensible",
      "Translated sessions where nuance is lost in manual documentation",
    ],
    features: [
      {
        icon: Shield,
        title: "Sensitive data protections beyond standard HIPAA",
        desc: "Psychiatric notes carry heightened sensitivity. Halo Note applies extra access controls to behavioral health notes: separate role permissions, enhanced audit logging, and configurable disclosure restrictions aligned with 42 CFR Part 2.",
        color: "#7c3aed",
      },
      {
        icon: Mic,
        title: "Full-session ambient capture with MSE structuring",
        desc: "From a 45-minute intake to a 20-minute med check, Halo Note listens and structures the note in your preferred format: DAP, BIRP, GIRP, SOAP, or a full psychiatric evaluation format with MSE.",
        color: "#6d28d9",
      },
      {
        icon: Globe,
        title: "40+ language support for diverse populations",
        desc: "Halo Interpreter translates and structures notes from sessions conducted in Spanish, Mandarin, Arabic, Haitian Creole, and 37 other languages, enabling culturally competent care without documentation barriers.",
        color: "#0891b2",
      },
      {
        icon: Activity,
        title: "Safety plan documentation and risk tracking",
        desc: "Suicidality and safety plan documentation is structured and trackable across visits. Risk stratification, SI/HI status, protective factors, and crisis resources are captured in every session note.",
        color: "#059669",
      },
    ],
    templates: ["DAP Note", "BIRP Note", "GIRP Note", "Psychiatric Evaluation", "Medication Management", "Group Therapy Note", "Safety Plan Documentation", "Substance Use Assessment"],
    quote: {
      text: "I used to write process notes between sessions or after clinic. Now I stay present with my patient the entire 50 minutes. The note is ready before the next one starts.",
      name: "Dr. S.K., Psychiatry",
      city: "Chicago, IL",
    },
    seoTitle: "AI Scribe for Psychiatry & Behavioral Health, Halo Note",
    seoDesc: "Halo Note generates DAP, BIRP, and full psychiatric evaluation notes with sensitive data protections, 40+ language support, and risk documentation, so you stay present with your patient.",
  },
};

/* ── Component ──────────────────────────────────────────────────── */
export default function SpecialtyPage({ specialty }: { specialty: keyof typeof SPECIALTIES }) {
  const s = SPECIALTIES[specialty];
  if (!s) return null;

  return (
    <MarketingLayout darkHero>
      <SEOMeta title={s.seoTitle} description={s.seoDesc} />

      {/* Hero */}
      <section className="relative overflow-hidden bg-gray-950 pt-32 pb-20 md:pt-44 md:pb-28">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }} />
        <div className="absolute pointer-events-none" style={{
          top: "-15%", left: "50%", transform: "translateX(-50%)",
          width: "900px", height: "600px",
          background: `radial-gradient(ellipse at center, ${s.heroColor}18 0%, transparent 65%)`,
        }} />

        <div className="relative max-w-4xl mx-auto px-5 sm:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border mb-6 text-[11px] font-semibold tracking-wide uppercase"
            style={{ borderColor: `${s.heroColor}40`, background: `${s.heroColor}15`, color: s.heroColor }}>
            <s.icon className="w-3.5 h-3.5" />
            {s.badge}
          </div>

          <h1 className="text-4xl md:text-[3.4rem] font-black text-white tracking-tight leading-[1.06] mb-5">
            {s.headline}
          </h1>
          <p className="text-gray-400 text-[17px] max-w-2xl mx-auto leading-relaxed mb-10">
            {s.subheadline}
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-14">
            <Link href="/demo">
              <Button size="lg" className="rounded-full px-8 h-13 font-bold text-white" style={{ background: `linear-gradient(135deg, ${s.gradientFrom}, ${s.gradientTo})` }} data-testid="button-specialty-demo">
                Try the live demo
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/request-access">
              <Button size="lg" variant="outline" className="rounded-full px-8 h-13 font-semibold border-white/20 text-white hover:bg-white/10" data-testid="button-specialty-access">
                Request early access
              </Button>
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-px bg-white/[0.06] rounded-2xl overflow-hidden border border-white/[0.06] max-w-lg mx-auto">
            {[s.stat1, s.stat2, s.stat3].map((stat, i) => (
              <div key={i} className="flex flex-col items-center gap-1 py-5 px-3 bg-gray-950/80">
                <span className="text-xl font-black text-white">{stat.value}</span>
                <span className="text-[10px] text-gray-500 text-center leading-snug">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Fade */}
      <div className="h-16 w-full" style={{ background: "linear-gradient(to bottom, #030712 0%, #ffffff 100%)" }} />

      {/* Pain points */}
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-5 sm:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-3">The problem</p>
              <h2 className="text-2xl md:text-3xl font-black text-gray-950 leading-tight mb-4">
                What's eating your {s.name.split(" ")[0].toLowerCase()} practice right now.
              </h2>
              <p className="text-gray-500 text-[15px] leading-relaxed">
                Documentation overhead is the #1 driver of physician burnout in {s.name}. These aren't abstract problems, they're the daily reality for most providers.
              </p>
            </div>
            <div className="space-y-3">
              {s.painPoints.map((pain, i) => (
                <div key={i} className="flex items-start gap-3 p-4 rounded-xl bg-gray-50 border border-gray-100">
                  <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-red-400" />
                  </div>
                  <span className="text-[14px] text-gray-700 leading-relaxed">{pain}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 md:py-20 bg-gray-50 border-t border-gray-100">
        <div className="max-w-4xl mx-auto px-5 sm:px-8">
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-3">The solution</p>
          <h2 className="text-2xl md:text-3xl font-black text-gray-950 mb-10">
            How Halo Note solves it, specifically for {s.name}.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {s.features.map((f, i) => (
              <div key={i} className="p-6 rounded-2xl bg-white border border-gray-100 hover:shadow-lg hover:border-gray-200 transition-all duration-300" data-testid={`feature-${i}`}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${f.color}15` }}>
                    <f.icon className="w-4.5 h-4.5" style={{ color: f.color }} />
                  </div>
                  <h3 className="text-[14px] font-bold text-gray-900 leading-snug">{f.title}</h3>
                </div>
                <p className="text-[13px] text-gray-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Templates */}
      <section className="py-16 bg-white border-t border-gray-100">
        <div className="max-w-4xl mx-auto px-5 sm:px-8">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">Templates</p>
              <h2 className="text-xl font-black text-gray-950">{s.name}-specific note formats, built in.</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.templates.map((t, i) => (
                <div key={i} className="px-3 py-1.5 rounded-full border border-gray-200 bg-gray-50 text-[12px] font-medium text-gray-600">
                  {t}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Quote */}
      <section className="py-16 md:py-20 border-t border-gray-100" style={{ background: `linear-gradient(135deg, ${s.gradientFrom}08 0%, ${s.gradientTo}08 100%)` }}>
        <div className="max-w-3xl mx-auto px-5 sm:px-8 text-center">
          <blockquote className="text-xl md:text-2xl font-semibold text-gray-800 leading-relaxed mb-6 italic">
            "{s.quote.text}"
          </blockquote>
          <div className="flex items-center justify-center gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: `${s.heroColor}20` }}>
              <s.icon className="w-4 h-4" style={{ color: s.heroColor }} />
            </div>
            <div className="text-left">
              <div className="text-[13px] font-bold text-gray-800">{s.quote.name}</div>
              <div className="text-[12px] text-gray-400">{s.quote.city}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Other specialties */}
      <section className="py-12 bg-white border-t border-gray-100">
        <div className="max-w-4xl mx-auto px-5 sm:px-8">
          <p className="text-center text-[12px] font-bold uppercase tracking-widest text-gray-400 mb-5">Also built for</p>
          <div className="flex flex-wrap justify-center gap-3">
            {Object.values(SPECIALTIES).filter(sp => sp.id !== s.id).map(sp => (
              <Link key={sp.id} href={`/specialties/${sp.id}`}>
                <div className="flex items-center gap-2 px-4 py-2 rounded-full border border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white transition-all text-[13px] font-medium text-gray-700 cursor-pointer">
                  <sp.icon className="w-3.5 h-3.5 text-gray-500" />
                  {sp.name}
                  <ChevronRight className="w-3 h-3 text-gray-400" />
                </div>
              </Link>
            ))}
            <Link href="/request-access">
              <div className="flex items-center gap-2 px-4 py-2 rounded-full border border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-white transition-all text-[13px] font-medium text-gray-500 cursor-pointer">
                36+ more specialties
                <ChevronRight className="w-3 h-3 text-gray-400" />
              </div>
            </Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative py-24 md:py-32 overflow-hidden">
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${s.gradientFrom} 0%, ${s.gradientTo} 100%)` }} />
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "50px 50px",
        }} />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 text-center text-white">
          <h2 className="text-3xl md:text-4xl font-black mb-5 tracking-tight">
            Ready to reclaim your evenings?
          </h2>
          <p className="text-white/70 text-[17px] mb-10 leading-relaxed max-w-xl mx-auto">
            Join {s.name} providers using Halo Note to finish notes before they leave the office.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/demo">
              <Button size="lg" className="rounded-full px-8 h-14 font-bold bg-white text-gray-950 hover:bg-gray-100 text-[15px]" data-testid="button-specialty-cta-demo">
                Try live demo, no login
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/request-access">
              <Button size="lg" variant="outline" className="rounded-full px-8 h-14 font-semibold border-white/30 text-white hover:bg-white/15 text-[14px]" data-testid="button-specialty-cta-access">
                Request early access
              </Button>
            </Link>
          </div>
          <div className="mt-8 flex items-center justify-center gap-5 flex-wrap">
            {["HIPAA-ready", "BAA included", "30-day onboarding", "No long-term contract"].map((item, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[12px] text-white/60">
                <CheckCircle2 className="w-3.5 h-3.5 text-white/40" />
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
