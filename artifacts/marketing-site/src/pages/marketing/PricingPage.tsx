import { useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2, ArrowRight, Loader2, Sparkles, Mic, FileText,
  Users, Building2, ShieldCheck, ChevronDown, Star, Zap, BookOpen,
} from "lucide-react";

/* ─── Analytics stub (wire to Segment / PostHog later) ─── */
function track(event: string, props?: Record<string, unknown>) {
  if (typeof window !== "undefined" && (window as any).analytics) {
    (window as any).analytics.track(event, props);
  }
}

/* ─── Plan metadata, add Stripe price IDs here later ──── */
const PLANS = [
  {
    id: "resident",
    name: "Resident",
    tagline: "For residents, fellows, and trainees",
    monthlyPrice: 29.99,
    annualPrice: 19.99,
    stripePriceIdMonthly: null as string | null,   // TODO: "price_xxx"
    stripePriceIdAnnual: null as string | null,    // TODO: "price_xxx"
    badge: "For trainees",
    highlighted: false,
    icon: BookOpen,
    iconColor: "#0891b2",
    iconBg: "#ecfeff",
    cta: "Request Early Access",
    features: [
      "Ambient recording & AI transcription",
      "AI-generated clinical notes",
      "Basic specialty-aware note formatting",
      "HIPAA-compliant secure storage",
      "PDF / EHR-ready note export",
      "Affordable access for training & clinical workflow support",
    ],
  },
  {
    id: "individual",
    name: "Individual",
    tagline: "For attending physicians",
    monthlyPrice: 99.99,
    annualPrice: 79.99,
    stripePriceIdMonthly: null as string | null,   // TODO: "price_xxx"
    stripePriceIdAnnual: null as string | null,    // TODO: "price_xxx"
    badge: "Most Popular",
    highlighted: true,
    icon: Mic,
    iconColor: "#2563eb",
    iconBg: "#eff6ff",
    cta: "Request Early Access",
    features: [
      "Ambient recording & AI transcription",
      "Structured clinical note generation",
      "15+ specialty support",
      "HIPAA-compliant secure storage",
      "PDF / EHR-ready note export",
      "Style adaptation, learns your phrasing",
      "Priority email support",
    ],
  },
  {
    id: "practice",
    name: "Practice",
    tagline: "For small clinics & group practices",
    monthlyPrice: null,
    annualPrice: null,
    stripePriceIdMonthly: null as string | null,
    stripePriceIdAnnual: null as string | null,
    badge: null as string | null,
    highlighted: false,
    icon: Users,
    iconColor: "#7c3aed",
    iconBg: "#f5f3ff",
    cta: "Contact Sales",
    features: [
      "Everything in Individual",
      "Multi-provider management",
      "Shared templates & preferences",
      "Admin dashboard & visibility",
      "Workflow optimization tools",
      "Halo Coder, ICD-10 & CPT support",
      "Pre-charting & patient prep briefs",
      "Priority support",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For larger groups & health systems",
    monthlyPrice: null,
    annualPrice: null,
    stripePriceIdMonthly: null as string | null,
    stripePriceIdAnnual: null as string | null,
    badge: null,
    highlighted: false,
    icon: Building2,
    iconColor: "#059669",
    iconBg: "#ecfdf5",
    cta: "Contact Sales",
    features: [
      "Everything in Practice",
      "Epic, Cerner & Athena integration",
      "Dedicated deployment assistance",
      "Advanced admin controls & audit logs",
      "BAA + custom data agreements",
      "Concierge onboarding",
      "24/7 priority support",
      "Custom SLA",
    ],
  },
];

const FAQS = [
  {
    q: "Is Halo Note available for individual physicians?",
    a: "Yes. The Individual plan is built specifically for solo physicians and independent practitioners. You can sign up without any organizational approval or IT involvement.",
  },
  {
    q: "What is the Founding Clinicians program?",
    a: "Founding Clinicians are our earliest physician partners, the doctors shaping what Halo Note becomes. They get early access pricing, direct input into the product roadmap, and concierge onboarding. Spots are limited.",
  },
  {
    q: "When does billing begin?",
    a: "During early access, many users are onboarded manually before full self-serve billing is activated. We will always communicate clearly before any charges begin. You will never be billed without notice.",
  },
  {
    q: "Can Halo Note support group practices?",
    a: "Yes. The Practice plan supports multi-provider groups with shared templates, admin visibility, and workflow tooling. For larger organizations or health systems, contact us for an Enterprise discussion.",
  },
  {
    q: "Does Halo Note integrate with EHR systems?",
    a: "Halo Note supports Epic, Cerner, and Athenahealth integrations. Notes can also be exported in formats compatible with any EHR system, even without a direct integration.",
  },
  {
    q: "Is onboarding included?",
    a: "All plans include onboarding support. Founding Clinicians and Enterprise accounts receive concierge onboarding with a dedicated setup session.",
  },
  {
    q: "Is Halo Note HIPAA compliant?",
    a: "Yes. Halo Note is built with HIPAA compliance as a foundation. We sign Business Associate Agreements (BAAs) with all customers. Patient data is encrypted at rest and in transit and never used to train third-party models.",
  },
  {
    q: "Do I need EHR admin approval to use Halo Note?",
    a: "Not for the Individual plan, you can get started independently. EHR integrations for the Practice and Enterprise plans may require IT coordination, and we provide full support for that process.",
  },
];

/* ─── Form schema (reuses existing access_requests table) ── */
const intakeSchema = z.object({
  fullName: z.string().min(2, "Full name is required"),
  email: z.string().email("Please enter a valid email"),
  organizationName: z.string().min(1, "Practice or clinic name is required"),
  specialty: z.string().min(1, "Please select your specialty"),
  practiceType: z.string().min(1, "Please select your practice type"),
  ehrSystem: z.string().min(1, "Please select your EHR"),
  message: z.string().optional(),
});
type IntakeValues = z.infer<typeof intakeSchema>;

const specialties = [
  "Primary Care / Family Medicine",
  "Internal Medicine",
  "Cardiology",
  "Dermatology",
  "Emergency Medicine",
  "Endocrinology",
  "Gastroenterology",
  "Neurology",
  "Obstetrics & Gynecology",
  "Oncology",
  "Orthopedics",
  "Pediatrics",
  "Psychiatry",
  "Pulmonology",
  "Surgery",
  "Urology",
  "Other",
];

const practiceTypes = [
  "Solo Practice",
  "Small Group (2–10 physicians)",
  "Large Group (11–50 physicians)",
  "Hospital / Health System",
  "Academic Medical Center",
  "Urgent Care",
  "Telehealth",
  "Other",
];

const ehrSystems = [
  "Epic",
  "Cerner / Oracle Health",
  "Athenahealth",
  "eClinicalWorks",
  "Allscripts",
  "NextGen",
  "DrChrono",
  "Practice Fusion",
  "None / Paper-based",
  "Other",
];

/* ─── Intake modal ──────────────────────────────────────── */
function IntakeModal({
  open,
  onClose,
  selectedPlan,
  isFounding,
}: {
  open: boolean;
  onClose: () => void;
  selectedPlan: string | null;
  isFounding: boolean;
}) {
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<IntakeValues>({
    resolver: zodResolver(intakeSchema as any),
    defaultValues: {
      fullName: "",
      email: "",
      organizationName: "",
      specialty: "",
      practiceType: "",
      ehrSystem: "",
      message: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: IntakeValues) => {
      const payload = {
        ...data,
        message: [
          isFounding ? "Interested in: Founding Clinicians Program" : `Interested in: ${selectedPlan ?? ""} plan`,
          data.message ? `Note: ${data.message}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
      };
      const res = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Request failed" }));
        throw new Error(err.message || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: () => {
      track("request_demo_submitted", { plan: selectedPlan, founding: isFounding });
      setSubmitted(true);
    },
  });

  function handleClose() {
    onClose();
    setTimeout(() => {
      setSubmitted(false);
      form.reset();
    }, 300);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl p-0" data-testid="modal-intake">
        {submitted ? (
          <div className="p-10 text-center space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-[20px] font-bold text-gray-950 mb-2">You're on the list.</h3>
              <p className="text-[14px] text-gray-500 leading-relaxed">
                We'll reach out within 1–2 business days to walk you through onboarding.
                {isFounding && " As a Founding Clinician, you'll receive priority access."}
              </p>
            </div>
            <Button onClick={handleClose} className="rounded-full bg-black text-white hover:bg-gray-800 px-7 h-10 text-[13px] font-semibold" data-testid="button-modal-close">
              Done
            </Button>
          </div>
        ) : (
          <div>
            <div className={`px-8 pt-8 pb-6 border-b border-gray-100 ${isFounding ? "bg-gradient-to-r from-amber-50 to-orange-50" : "bg-white"}`}>
              {isFounding && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-[11px] font-bold uppercase tracking-wider mb-3">
                  <Star className="w-3 h-3 fill-amber-500 stroke-amber-500" />
                  Founding Clinicians Program
                </div>
              )}
              <DialogHeader>
                <DialogTitle className="text-[20px] font-bold text-gray-950 text-left">
                  {isFounding ? "Join the Founding Cohort" : `Get started with ${selectedPlan}`}
                </DialogTitle>
                <DialogDescription className="text-[14px] text-gray-500 text-left mt-1">
                  {isFounding
                    ? "Tell us about your practice and we'll reach out to set up your concierge onboarding."
                    : "Fill in your details and we'll be in touch within 1–2 business days."}
                </DialogDescription>
              </DialogHeader>
            </div>

            <Form {...form}>
              <form onSubmit={form.handleSubmit((d) => mutation.mutate(d))} className="px-8 pt-6 pb-8 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="fullName" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-gray-700">Full name</FormLabel>
                      <FormControl>
                        <Input placeholder="Dr. Jane Smith" className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="input-full-name" {...field} />
                      </FormControl>
                      <FormMessage className="text-[11px]" />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="email" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-gray-700">Work email</FormLabel>
                      <FormControl>
                        <Input placeholder="you@clinic.com" type="email" className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="input-email" {...field} />
                      </FormControl>
                      <FormMessage className="text-[11px]" />
                    </FormItem>
                  )} />
                </div>

                <FormField control={form.control} name="organizationName" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px] font-medium text-gray-700">Practice or clinic name</FormLabel>
                    <FormControl>
                      <Input placeholder="Riverside Family Medicine" className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="input-organization" {...field} />
                    </FormControl>
                    <FormMessage className="text-[11px]" />
                  </FormItem>
                )} />

                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="specialty" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-gray-700">Specialty</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="select-specialty">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {specialties.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-[11px]" />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="practiceType" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px] font-medium text-gray-700">Practice type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="select-practice-type">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {practiceTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-[11px]" />
                    </FormItem>
                  )} />
                </div>

                <FormField control={form.control} name="ehrSystem" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px] font-medium text-gray-700">Current EHR system</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-10 rounded-xl border-gray-200 text-[13px]" data-testid="select-ehr">
                          <SelectValue placeholder="Select…" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ehrSystems.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-[11px]" />
                  </FormItem>
                )} />

                <FormField control={form.control} name="message" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px] font-medium text-gray-700">Anything you'd like us to know? <span className="text-gray-400 font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="How many providers, current documentation workflow, questions…"
                        className="rounded-xl border-gray-200 text-[13px] resize-none"
                        rows={3}
                        data-testid="textarea-message"
                        {...field}
                      />
                    </FormControl>
                  </FormItem>
                )} />

                {mutation.error && (
                  <p className="text-[12px] text-red-500 bg-red-50 rounded-lg px-3 py-2">
                    {(mutation.error as Error).message}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={mutation.isPending}
                  className="w-full h-11 rounded-full bg-black text-white hover:bg-gray-900 font-semibold text-[14px] transition-all group"
                  data-testid="button-intake-submit"
                >
                  {mutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting…</>
                  ) : (
                    <>{isFounding ? "Join the Founding Cohort" : "Submit Request"}<ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" /></>
                  )}
                </Button>
                <p className="text-center text-[11px] text-gray-400">
                  No payment required. We'll reach out within 1–2 business days.
                </p>
              </form>
            </Form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── ROI Calculator ─────────────────────────────────────── */
function RoiCalculator() {
  const [patients, setPatients] = useState(15);
  const [hourlyRate, setHourlyRate] = useState(200);

  const minPerPatientSaved = 13;
  const workingDaysPerWeek = 5;
  const workingWeeksPerYear = 48;

  const dailyMinsSaved = patients * minPerPatientSaved;
  const dailyHrsSaved = dailyMinsSaved / 60;
  const weeklyHrsSaved = dailyHrsSaved * workingDaysPerWeek;
  const yearlyHrsSaved = weeklyHrsSaved * workingWeeksPerYear;
  const yearlyDollarValue = yearlyHrsSaved * hourlyRate;
  const annualPlanCost = 79.99 * 12;
  const roi = yearlyDollarValue / annualPlanCost;

  const fmt = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${Math.round(n).toLocaleString()}`;

  const metrics = [
    { label: "Hours saved / day", value: dailyHrsSaved.toFixed(1), unit: "hrs", color: "#2563eb" },
    { label: "Hours saved / week", value: weeklyHrsSaved.toFixed(0), unit: "hrs", color: "#7c3aed" },
    { label: "Hours freed / year", value: yearlyHrsSaved.toFixed(0), unit: "hrs", color: "#059669" },
    { label: "Value of time saved", value: fmt(yearlyDollarValue), unit: "/yr", color: "#d97706" },
  ];

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden" data-testid="roi-calculator">
      <div className="px-6 pt-6 pb-5 border-b border-gray-100 space-y-5">
        {/* Patients slider */}
        <div>
          <div className="flex justify-between items-baseline mb-2">
            <label className="text-[13px] font-semibold text-gray-700">Patients seen per day</label>
            <span className="text-[22px] font-black text-gray-950">{patients}</span>
          </div>
          <input
            type="range"
            min={1}
            max={50}
            value={patients}
            onChange={(e) => setPatients(Number(e.target.value))}
            className="w-full accent-blue-600 cursor-pointer"
            data-testid="slider-patients"
          />
          <div className="flex justify-between text-[11px] text-gray-400 mt-1">
            <span>1</span><span>50</span>
          </div>
        </div>

        {/* Hourly rate slider */}
        <div>
          <div className="flex justify-between items-baseline mb-2">
            <label className="text-[13px] font-semibold text-gray-700">Your hourly value estimate</label>
            <span className="text-[22px] font-black text-gray-950">${hourlyRate}/hr</span>
          </div>
          <input
            type="range"
            min={50}
            max={500}
            step={25}
            value={hourlyRate}
            onChange={(e) => setHourlyRate(Number(e.target.value))}
            className="w-full accent-blue-600 cursor-pointer"
            data-testid="slider-hourly-rate"
          />
          <div className="flex justify-between text-[11px] text-gray-400 mt-1">
            <span>$50/hr</span><span>$500/hr</span>
          </div>
        </div>
      </div>

      {/* Output metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 divide-x divide-y divide-gray-100">
        {metrics.map((m) => (
          <div key={m.label} className="px-4 py-4 text-center">
            <div className="text-[22px] font-black" style={{ color: m.color }}>
              {m.value}<span className="text-[13px] font-semibold ml-0.5">{m.unit}</span>
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5 leading-tight">{m.label}</div>
          </div>
        ))}
      </div>

      {/* ROI highlight */}
      <div className="px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-gray-100"
        style={{ background: "linear-gradient(90deg, #f0f9ff 0%, #f5f3ff 100%)" }}>
        <div className="text-center sm:text-left">
          <p className="text-[13px] text-gray-600">
            At <strong>{patients} patients/day</strong>, Halo Note Individual costs{" "}
            <strong>${annualPlanCost.toFixed(0)}/yr</strong> and returns an estimated{" "}
            <strong className="text-blue-700">{fmt(yearlyDollarValue)}</strong> in time value.
          </p>
        </div>
        <div className="flex-shrink-0 px-5 py-2.5 rounded-full text-white text-[13px] font-bold"
          style={{ background: "linear-gradient(135deg, #2563eb, #7c3aed)" }}>
          {roi.toFixed(0)}× ROI
        </div>
      </div>

      <p className="text-center text-[11px] text-gray-400 py-3 px-6">
        Based on ~13 min saved per patient vs. traditional dictation. Time value is an estimate using your hourly rate.
      </p>
    </div>
  );
}

/* ─── FAQ item ───────────────────────────────────────────── */
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        className="w-full flex items-start justify-between gap-4 py-5 text-left group"
        onClick={() => setOpen(!open)}
        data-testid={`faq-${q.slice(0, 20).replace(/\s/g, "-").toLowerCase()}`}
      >
        <span className="text-[15px] font-semibold text-gray-900 group-hover:text-black transition-colors leading-snug">
          {q}
        </span>
        <ChevronDown
          className={`w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <p className="text-[14px] text-gray-500 leading-relaxed pb-5 pr-9">
          {a}
        </p>
      )}
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────── */
export default function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [isFounding, setIsFounding] = useState(false);

  function openModal(planName: string | null, founding = false) {
    setSelectedPlan(planName);
    setIsFounding(founding);
    setModalOpen(true);
    track(founding ? "founding_clinician_clicked" : "pricing_plan_clicked", { plan: planName });
  }

  return (
    <MarketingLayout>
      <SEOMeta
        title="Pricing, Halo Note"
        description="Halo Note plans starting at $19.99/mo for residents and $99.99/mo for attending physicians. Early access pricing available for founding clinicians."
      />

      {/* ── HERO ──────────────────────────────────────────── */}
      <section className="relative pt-32 pb-20 bg-gray-950 text-center px-5 overflow-hidden" data-testid="section-pricing-hero">
        {/* grid overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.035]"
          style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.8) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.8) 1px,transparent 1px)", backgroundSize: "64px 64px" }} />
        {/* ambient glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full pointer-events-none" style={{ background: "radial-gradient(ellipse, rgba(99,102,241,0.18) 0%, transparent 70%)" }} />
        <div className="relative z-10 max-w-2xl mx-auto space-y-5">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/20 bg-white/10 text-gray-200 text-[12px] font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Early Access, Now Open
          </div>
          <h1 className="text-[clamp(2.2rem,5vw,3.5rem)] font-black text-white tracking-tight leading-[1.06]">
            Pricing that scales<br />with your practice.
          </h1>
          <p className="text-[17px] text-gray-400 leading-relaxed max-w-lg mx-auto">
            Built for solo physicians and growing practices. No hidden fees.
            No forced upgrades. Start during early access and lock in founding rates.
          </p>

          {/* Monthly / Annual toggle */}
          <div className="inline-flex items-center gap-1 p-1 rounded-full bg-white/10 border border-white/20 mt-2" data-testid="toggle-billing-period">
            <button
              onClick={() => setAnnual(false)}
              className={`px-5 py-2 rounded-full text-[13px] font-semibold transition-all duration-200 ${!annual ? "bg-white text-gray-900 shadow-sm" : "text-white/50 hover:text-white/80"}`}
              data-testid="button-monthly"
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-5 py-2 rounded-full text-[13px] font-semibold transition-all duration-200 flex items-center gap-2 ${annual ? "bg-white text-gray-900 shadow-sm" : "text-white/50 hover:text-white/80"}`}
              data-testid="button-annual"
            >
              Annual
              <span className="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-full">
                Save 20%
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* ── PLAN CARDS ────────────────────────────────────── */}
      <section className="pb-8 px-5" style={{ background: "linear-gradient(to bottom, #030712 0%, #ffffff 96px)" }} data-testid="section-plans">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6 items-stretch">
            {PLANS.map((plan) => {
              const Icon = plan.icon;
              const price = plan.monthlyPrice
                ? annual
                  ? plan.annualPrice
                  : plan.monthlyPrice
                : null;

              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col rounded-2xl border p-7 transition-all duration-200 ${
                    plan.highlighted
                      ? "border-violet-200 bg-gradient-to-b from-violet-50/60 to-white shadow-lg shadow-violet-100/50 ring-1 ring-violet-200"
                      : "border-gray-200 bg-white hover:shadow-md hover:border-gray-300"
                  }`}
                  data-testid={`card-plan-${plan.id}`}
                >
                  {plan.badge && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      {plan.id === "resident" ? (
                        <span className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-cyan-600 text-white text-[11px] font-bold uppercase tracking-wider shadow-sm">
                          <BookOpen className="w-3 h-3" />
                          {plan.badge}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-violet-600 text-white text-[11px] font-bold uppercase tracking-wider shadow-sm">
                          <Zap className="w-3 h-3 fill-white" />
                          {plan.badge}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Icon + Name */}
                  <div className="flex items-start justify-between mb-5">
                    <div>
                      <div
                        className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
                        style={{ background: plan.iconBg }}
                      >
                        <Icon className="w-5 h-5" style={{ color: plan.iconColor }} />
                      </div>
                      <div className="text-[19px] font-bold text-gray-950">{plan.name}</div>
                      <div className="text-[13px] text-gray-400 mt-0.5">{plan.tagline}</div>
                    </div>
                  </div>

                  {/* Price */}
                  <div className="mb-6">
                    {price !== null ? (
                      <div className="flex items-end gap-1.5">
                        <span className="text-[2.8rem] font-black text-gray-950 leading-none">${price}</span>
                        <span className="text-[14px] text-gray-400 mb-1.5">/ mo</span>
                      </div>
                    ) : (
                      <div className="text-[2rem] font-black text-gray-950 leading-none">Custom</div>
                    )}
                    {price !== null && annual && (
                      <p className="text-[12px] text-emerald-600 font-semibold mt-1">
                        Billed annually · Save ${Math.round((plan.monthlyPrice! - plan.annualPrice!) * 12)}/yr
                      </p>
                    )}
                    {price !== null && !annual && (
                      <p className="text-[12px] text-gray-400 mt-1">per physician</p>
                    )}
                    {price === null && (
                      <p className="text-[12px] text-gray-400 mt-1">Contact us for a quote</p>
                    )}
                  </div>

                  {/* CTA */}
                  <Button
                    className={`w-full h-10 rounded-full text-[13px] font-semibold mb-7 transition-all duration-200 group ${
                      plan.highlighted
                        ? "bg-violet-600 hover:bg-violet-700 text-white shadow-sm hover:shadow-md"
                        : "bg-gray-950 hover:bg-gray-800 text-white"
                    }`}
                    onClick={() => openModal(plan.name)}
                    data-testid={`button-plan-${plan.id}`}
                  >
                    {plan.cta}
                    <ArrowRight className="w-3.5 h-3.5 ml-1.5 group-hover:translate-x-0.5 transition-transform" />
                  </Button>

                  {/* Features */}
                  <ul className="space-y-3 flex-1">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5 text-[13px] text-gray-600 leading-snug">
                        <CheckCircle2
                          className="w-4 h-4 flex-shrink-0 mt-0.5"
                          style={{ color: plan.iconColor }}
                        />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── FOUNDING CLINICIANS ───────────────────────────── */}
      <section className="py-10 bg-white px-5 pb-20" data-testid="section-founding">
        <div className="max-w-5xl mx-auto">
          <div className="relative rounded-2xl overflow-hidden border border-amber-200 bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 p-8 md:p-10">
            <div className="absolute top-0 right-0 w-64 h-64 bg-amber-200/30 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
            <div className="relative flex flex-col md:flex-row md:items-center gap-8">
              <div className="flex-1">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 border border-amber-200 text-amber-800 text-[11px] font-bold uppercase tracking-wider mb-4">
                  <Star className="w-3.5 h-3.5 fill-amber-500 stroke-amber-500" />
                  Founding Clinicians Program
                </div>
                <h2 className="text-[clamp(1.4rem,3vw,2rem)] font-black text-gray-950 tracking-tight leading-tight mb-3">
                  Shape the platform.<br />Lock in founding rates.
                </h2>
                <p className="text-[15px] text-gray-600 leading-relaxed max-w-lg">
                  We're accepting a small cohort of physician partners to co-develop Halo Note
                  with us. Founding Clinicians receive early access pricing, direct input into
                  the product roadmap, and concierge onboarding, with potential for lifetime
                  discount consideration.
                </p>

                <ul className="mt-5 grid sm:grid-cols-2 gap-2.5">
                  {[
                    "Priority onboarding & setup",
                    "Direct access to the product team",
                    "Early access pricing consideration",
                    "Input into roadmap & specialty features",
                    "Concierge support during rollout",
                    "Founding member recognition",
                  ].map((b) => (
                    <li key={b} className="flex items-center gap-2 text-[13px] text-gray-700">
                      <CheckCircle2 className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="md:w-56 flex-shrink-0 text-center">
                <div className="inline-flex flex-col items-center gap-1 mb-5">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-amber-700">Spots available</span>
                  <span className="text-[4rem] font-black text-gray-950 leading-none">47</span>
                  <span className="text-[13px] text-gray-500">of 100 remaining</span>
                </div>
                <Button
                  size="lg"
                  className="w-full h-12 rounded-full bg-gray-950 hover:bg-gray-800 text-white font-semibold text-[14px] shadow-md hover:shadow-lg transition-all group"
                  onClick={() => openModal("Founding Clinicians", true)}
                  data-testid="button-founding-clinicians"
                >
                  Join the Cohort
                  <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
                </Button>
                <p className="text-[11px] text-gray-400 mt-3">No payment required now.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── TRUST STRIP ───────────────────────────────────── */}
      <section className="py-12 border-y border-gray-100 bg-gray-50/60 px-5">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { icon: ShieldCheck, label: "HIPAA Compliant", sub: "BAA available" },
              { icon: FileText, label: "15+ Specialties", sub: "Supported" },
              { icon: Zap, label: "< 60 seconds", sub: "Note generation" },
              { icon: Sparkles, label: "Ambient AI", sub: "No buttons. Just talk." },
            ].map(({ icon: Icon, label, sub }) => (
              <div key={label} className="flex flex-col items-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center shadow-sm">
                  <Icon className="w-5 h-5 text-gray-600" />
                </div>
                <div className="text-[15px] font-bold text-gray-900">{label}</div>
                <div className="text-[12px] text-gray-400">{sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── ROI CALCULATOR ────────────────────────────────── */}
      <section className="py-20 px-5 bg-white" data-testid="section-roi-calculator">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Time is money</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.4rem)] font-black text-gray-950 tracking-tight">
              Calculate your time savings
            </h2>
            <p className="text-gray-500 text-[15px] max-w-lg mx-auto">
              See exactly how much time, and revenue, Halo Note gives back to your practice every year.
            </p>
          </div>
          <RoiCalculator />
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────── */}
      <section className="py-20 px-5 bg-white" data-testid="section-faq">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-12 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Questions</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.4rem)] font-black text-gray-950 tracking-tight">
              Frequently asked questions
            </h2>
          </div>
          <div className="divide-y divide-gray-100 border border-gray-100 rounded-2xl px-6 bg-white shadow-sm">
            {FAQS.map((faq) => (
              <FaqItem key={faq.q} q={faq.q} a={faq.a} />
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ─────────────────────────────────────── */}
      <section className="py-24 md:py-32 bg-gray-950 text-center px-5" data-testid="section-pricing-cta">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/15 bg-white/8 text-white/60 text-[12px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Early Access Open
          </div>
          <h2 className="text-[clamp(2rem,4.5vw,3.2rem)] font-black text-white tracking-tight leading-[1.06]">
            Your practice deserves<br />
            <span className="text-blue-400">better documentation.</span>
          </h2>
          <p className="text-[16px] text-white/50 leading-relaxed max-w-md mx-auto">
            Join physicians who are reclaiming time with their patients, and their evenings.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Button
              size="lg"
              className="h-12 px-9 rounded-full bg-white text-gray-950 hover:bg-gray-100 font-semibold text-[14px] shadow-md transition-all group"
              onClick={() => openModal("Individual", false)}
              data-testid="button-cta-get-started"
            >
              Get Started
              <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 px-9 rounded-full border-white/20 bg-transparent text-white hover:bg-white/10 font-semibold text-[14px] transition-all"
              onClick={() => openModal(null, false)}
              data-testid="button-cta-request-demo"
            >
              Request a Demo
            </Button>
          </div>
          <p className="text-[12px] text-white/30 pt-1">
            No payment required during early access.
          </p>
        </div>
      </section>

      {/* ── INTAKE MODAL ──────────────────────────────────── */}
      <IntakeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        selectedPlan={selectedPlan}
        isFounding={isFounding}
      />
    </MarketingLayout>
  );
}
