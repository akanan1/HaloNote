import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import {
  Mic, FileText, UserCog, Receipt, Mail, FileOutput,
  FolderOpen, Hospital, ShieldCheck, ArrowRight, Star
} from "lucide-react";

const videoFamily = "/family-video.mp4";

const capabilities = [
  {
    icon: Mic,
    title: "Ambient Recording & Transcription",
    description: "Halo Note captures patient encounters in real time using ambient listening technology. Our AI transcription engine recognizes medical terminology, handles multiple speakers, and supports multilingual conversations, so you can focus on the patient, not on typing.",
    color: "#4F46E5",
    bg: "#EEF2FF",
    tag: "Core",
  },
  {
    icon: FileText,
    title: "Personalized Note Generation",
    description: "Every clinician documents differently. Halo Note generates structured clinical notes (SOAP, H&P, Progress Notes, and more) that adapt to your preferred format, section emphasis, and documentation depth, producing first drafts that feel like your own writing.",
    color: "#7C3AED",
    bg: "#F5F3FF",
    tag: "AI-Powered",
  },
  {
    icon: UserCog,
    title: "Clinician Style Profiles",
    description: "Upload sample notes, set language substitutions, configure ROS preferences, physical exam templates, and assessment plan formats. Halo Note learns your documentation style and applies it consistently across every encounter.",
    color: "#DB2777",
    bg: "#FDF2F8",
    tag: "Personalization",
  },
  {
    icon: Receipt,
    title: "Coding Support",
    description: "Automatically extract ICD-10 and CPT codes from generated notes. Halo Note's coding engine analyzes clinical content to suggest appropriate billing codes and E/M levels, helping reduce missed revenue and coding errors.",
    color: "#D97706",
    bg: "#FFFBEB",
    tag: "Revenue",
  },
  {
    icon: Mail,
    title: "After-Visit Summaries",
    description: "Generate clear, patient-friendly after-visit summaries from clinical notes with a single click. Summaries are written in plain language, covering diagnoses, treatment plans, medications, and follow-up instructions.",
    color: "#059669",
    bg: "#ECFDF5",
    tag: "Patient Care",
  },
  {
    icon: FileOutput,
    title: "Referral Letters",
    description: "Create professional referral letters from clinical note content automatically. Letters include relevant history, findings, and referral reasoning, formatted and ready to send to specialists or other providers.",
    color: "#0891B2",
    bg: "#ECFEFF",
    tag: "Communication",
  },
  {
    icon: FolderOpen,
    title: "Patient Charts & Encounter History",
    description: "Access a unified view of each patient's encounters, notes, vitals, care team, and pre-chart summaries. Halo Note organizes all clinical data in one place, providing continuity of care at a glance.",
    color: "#6366F1",
    bg: "#EEF2FF",
    tag: "Records",
  },
  {
    icon: Hospital,
    title: "EHR Integration Foundation",
    description: "Halo Note is designed with EHR connectivity in mind. Configure connections to supported systems, and push finalized notes directly into the patient record, reducing double-entry and streamlining your workflow.",
    color: "#14B8A6",
    bg: "#F0FDFA",
    tag: "Integration",
  },
  {
    icon: ShieldCheck,
    title: "Physician Note Governance",
    description: "No AI-generated note is finalized without explicit physician review and sign-off. Full audit trails, addendum support, and version tracking give you complete control and accountability over every document.",
    color: "#059669",
    bg: "#ECFDF5",
    tag: "Governance",
  },
];

export default function ProductPage() {
  return (
    <MarketingLayout darkHero>
      <SEOMeta
        title="Halo Note, AI Clinical Documentation for Physicians"
        description="Ambient AI scribing, specialty-aware note generation, medical coding support, and EHR integration. Built for the full clinical workflow."
      />
      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Video background */}
        <video
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
          src={videoFamily}
          style={{ background: "#030712" }}
        />
        {/* Gradient overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: "linear-gradient(to bottom, rgba(3,7,18,0.55) 0%, rgba(3,7,18,0.40) 50%, rgba(3,7,18,0.70) 100%)",
          }}
        />

        <div className="relative z-10 max-w-4xl mx-auto px-5 sm:px-8 lg:px-10 pt-32 pb-20 md:pt-40 md:pb-24 text-center">
          <p className="text-[12px] font-semibold text-blue-300 uppercase tracking-[0.15em] mb-5">Capabilities</p>
          <h1
            className="text-4xl md:text-[3.5rem] font-bold tracking-[-0.03em] leading-[1.08] mb-6 text-white"
            data-testid="text-product-headline"
          >
            Everything You Need to{" "}
            <span className="bg-gradient-to-r from-[#60a5fa] via-[#a78bfa] to-[#60a5fa] bg-clip-text text-transparent">Document Smarter</span>
          </h1>
          <p className="text-[17px] text-white/60 max-w-2xl mx-auto leading-relaxed">
            Halo Note combines ambient AI, personalized note generation, and clinical workflow tools, all built around the way physicians actually work.
          </p>
        </div>

        <style>{`
          @keyframes float {
            0%, 100% { transform: translateY(0px) scale(1); }
            50% { transform: translateY(-30px) scale(1.02); }
          }
        `}</style>
      </section>

      {/* Dark → white fade bridge */}
      <div className="h-24 w-full" style={{ background: "linear-gradient(to bottom, #030712 0%, #ffffff 100%)" }} />

      {/* Capabilities */}
      <section className="pt-0 pb-16 md:pb-24 bg-white">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 lg:px-10">
          <div className="space-y-5">
            {capabilities.map((cap, i) => (
              <div
                key={i}
                className="group flex flex-col md:flex-row gap-7 items-start p-8 md:p-9 rounded-2xl bg-[#FAFAF7] border border-gray-100 hover:bg-white hover:shadow-lg hover:border-gray-200/80 transition-all duration-500"
                data-testid={`section-capability-${i}`}
              >
                <div className="flex-shrink-0 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: cap.bg }}>
                    <cap.icon className="w-6 h-6" style={{ color: cap.color }} />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-xl md:text-[22px] font-bold text-[#1a1a2e]">{cap.title}</h2>
                    <span className="hidden sm:inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider" style={{ color: cap.color, background: cap.bg }}>{cap.tag}</span>
                  </div>
                  <p className="text-[15px] text-gray-500 leading-relaxed">{cap.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative py-24 md:py-32 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] via-[#252545] to-[#1a1a2e]" />
        <div className="absolute top-[-30%] left-[40%] w-[400px] h-[400px] bg-[#4F46E5]/[0.12] rounded-full blur-[120px]" style={{ animation: 'float 8s ease-in-out infinite' }} />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 lg:px-10 text-center text-white">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.08] border border-white/[0.1] text-[13px] font-medium text-white/70 mb-8">
            <Star className="w-4 h-4 text-[#F59E0B]" />
            Early Access Available
          </div>
          <h2 className="text-3xl md:text-[2.75rem] font-bold mb-6 tracking-[-0.02em]">
            Ready to See It in Action?
          </h2>
          <p className="text-gray-400 mb-12 leading-relaxed text-[17px]">
            Request early access and discover how Halo Note can transform your documentation workflow.
          </p>
          <Link href="/request-access">
            <Button size="lg" className="bg-white text-[#1a1a2e] hover:bg-gray-100 font-bold px-10 h-14 text-[15px] rounded-full shadow-[0_4px_20px_rgba(255,255,255,0.15)] hover:shadow-[0_6px_30px_rgba(255,255,255,0.2)] transition-all duration-500 group" data-testid="button-product-cta">
              Request Early Access
              <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform duration-300" />
            </Button>
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
