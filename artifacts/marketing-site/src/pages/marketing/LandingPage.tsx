import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { HaloNoteLogoIcon } from "@/components/HaloNoteLogo";
import { SEOMeta } from "@/components/SEOMeta";
import {
  Mic, Receipt, Bot, ClipboardList, Globe, BookOpen,
  ArrowRight, CheckCircle2, Brain, Zap, FileText, Shield,
  Sparkles, LayoutDashboard, Calendar, Users
} from "lucide-react";

const videoFamily = "/family-video.mp4";

/* ─── Hooks ─────────────────────────────────────────────────── */
function useReveal(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry && entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, visible] as const;
}

function useCounter(target: number, duration = 1600, active = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) return;
    let start = 0;
    const step = target / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) { setValue(target); clearInterval(timer); }
      else setValue(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [target, duration, active]);
  return value;
}

/* ─── Data ──────────────────────────────────────────────────── */
const AGENTS = [
  { id: "scribe",      name: "Halo Scribe",      role: "Ambient Documentation",      color: "#3b82f6", icon: Mic,         angle: -90,  capabilities: ["Real-time ambient recording", "36 specialty templates", "Auto-learns your style"] },
  { id: "coder",       name: "Halo Coder",        role: "Medical Coding & Billing",   color: "#7c3aed", icon: Receipt,     angle: -30,  capabilities: ["ICD-10 & CPT extraction", "E/M level optimization", "Documentation gap alerts"] },
  { id: "consult",     name: "Halo Consult",      role: "Clinical AI Assistant",      color: "#10b981", icon: Bot,         angle:  30,  capabilities: ["Specialty-aware Q&A", "Evidence-based guidelines", "Voice interface"] },
  { id: "researcher",  name: "Halo Researcher",   role: "Evidence-Based Medicine",    color: "#6366f1", icon: BookOpen,    angle:  90,  capabilities: ["PubMed & trial search", "Guideline synthesis", "Literature summaries"] },
  { id: "interpreter", name: "Halo Interpreter",  role: "Multilingual Documentation", color: "#f97316", icon: Globe,       angle:  150, capabilities: ["40+ language detection", "Bilingual notes", "Patient-language summaries"] },
  { id: "prechart",    name: "Halo PreChart",     role: "Pre-Visit Intelligence",     color: "#f59e0b", icon: ClipboardList, angle: 210, capabilities: ["EHR-integrated summaries", "Medication review", "Problem list synthesis"] },
];

const RESEARCH_STATS = [
  { stat: "2 hrs", detail: "For every 1 hour of patient care, physicians spend 2 hours on EHR documentation.", source: "Annals of Internal Medicine, 2016" },
  { stat: "54%", detail: "Of physicians report symptoms of burnout, documentation burden is the #1 driver.", source: "Medscape National Physician Burnout Report, 2023" },
  { stat: "15.6 hrs", detail: "Per week spent on paperwork and administrative tasks, taken from patients.", source: "AMA, 2022" },
  { stat: "1 in 4", detail: "Physicians plan to leave medicine within 2–3 years. Burnout is the leading cause.", source: "AMA Physician Health Report, 2023" },
];

/* ─── Agent Network ──────────────────────────────────────────── */
const PILL_HALF_W = 68;
const PILL_HALF_H = 18;
const TOOLTIP_W = 176;
const TOOLTIP_H = 112;
const TT_GAP = 10;

function getTooltipAbsoluteStyle(agent: typeof AGENTS[0], CX: number, CY: number, R: number): React.CSSProperties {
  const rad = (agent.angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const ax = CX + R * cosA;
  const ay = CY + R * sinA;

  let left: number;
  let top: number;

  if (cosA >= 0.35) {
    // Right agents → show tooltip to the LEFT (inward towards center)
    left = ax - PILL_HALF_W - TT_GAP - TOOLTIP_W;
    top = ay - TOOLTIP_H / 2;
  } else if (cosA <= -0.35) {
    // Left agents → show tooltip to the RIGHT (inward)
    left = ax + PILL_HALF_W + TT_GAP;
    top = ay - TOOLTIP_H / 2;
  } else if (sinA < 0) {
    // Top agent → show below (towards center)
    left = ax - TOOLTIP_W / 2;
    top = ay + PILL_HALF_H + TT_GAP;
  } else {
    // Bottom agent → show above (towards center)
    left = ax - TOOLTIP_W / 2;
    top = ay - PILL_HALF_H - TT_GAP - TOOLTIP_H;
  }

  // Clamp inside 600×600 container
  left = Math.max(4, Math.min(left, 600 - TOOLTIP_W - 4));
  top  = Math.max(4, Math.min(top,  600 - TOOLTIP_H - 4));

  return { position: "absolute", left, top, zIndex: 60, pointerEvents: "none" };
}

function AgentNetwork() {
  const [active, setActive] = useState<string | null>(null);
  const R  = 200;
  const CX = 300;
  const CY = 300;
  const activeAgent = AGENTS.find((a) => a.id === active);

  return (
    <div className="relative w-full max-w-[600px] mx-auto select-none" style={{ height: 600 }}>
      {/* Animated SVG lines */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 600 600">
        {AGENTS.map((a) => {
          const rad = (a.angle * Math.PI) / 180;
          const x2 = CX + R * Math.cos(rad);
          const y2 = CY + R * Math.sin(rad);
          const isActive = active === a.id;
          return (
            <line
              key={a.id}
              x1={CX} y1={CY} x2={x2} y2={y2}
              stroke={isActive ? a.color : "#e5e7eb"}
              strokeWidth={isActive ? 2 : 1}
              strokeDasharray="6 6"
              style={isActive ? undefined : { animation: "line-dash 1.2s linear infinite" }}
            />
          );
        })}
        <circle cx={CX} cy={CY} r={40} fill="white" stroke="#dbeafe" strokeWidth={1.5} />
      </svg>

      {/* Center logo, gently floating */}
      <div
        className="absolute z-20"
        style={{
          left: CX,
          top: CY,
          transform: "translate(-50%, -50%)",
          animation: "float-gentle 4s ease-in-out infinite",
        }}
      >
        <div
          className="w-16 h-16 rounded-full bg-white flex items-center justify-center"
          style={{
            border: "1.5px solid #bfdbfe",
            boxShadow: "0 4px 20px rgba(79,142,247,0.18), 0 1px 4px rgba(0,0,0,0.06)",
          }}
        >
          <HaloNoteLogoIcon size={36} color="#2663EB" />
        </div>
      </div>

      {/* Agent node pills */}
      {AGENTS.map((agent, idx) => {
        const rad = (agent.angle * Math.PI) / 180;
        const x = CX + R * Math.cos(rad);
        const y = CY + R * Math.sin(rad);
        const Icon = agent.icon;
        const isActive = active === agent.id;
        return (
          <button
            key={agent.id}
            className="absolute flex items-center gap-2.5 bg-white border rounded-full px-3.5 py-2 cursor-pointer"
            style={{
              left: x,
              top: y,
              transform: isActive ? "translate(-50%,-50%) scale(1.07)" : "translate(-50%,-50%) scale(1)",
              borderColor: isActive ? agent.color : "#e5e7eb",
              boxShadow: isActive
                ? `0 0 0 3px ${agent.color}22, 0 8px 24px rgba(0,0,0,0.12)`
                : "0 2px 8px rgba(0,0,0,0.06)",
              animation: `agent-node-pulse ${3 + idx * 0.5}s ease-in-out infinite`,
              transition: "border-color 0.2s, box-shadow 0.2s, transform 0.2s",
              zIndex: isActive ? 50 : 10,
            }}
            onMouseEnter={() => setActive(agent.id)}
            onMouseLeave={() => setActive(null)}
            data-testid={`agent-node-${agent.id}`}
          >
            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: agent.color }}>
              <Icon className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-[13px] font-semibold text-gray-800 whitespace-nowrap">{agent.name}</span>
          </button>
        );
      })}

      {/* Tooltip, rendered at root of container so it never gets clipped */}
      {activeAgent && (
        <div key={activeAgent.id} style={getTooltipAbsoluteStyle(activeAgent, CX, CY, R)}>
          <div style={{ animation: "tooltip-pop 0.18s cubic-bezier(0.34,1.56,0.64,1) both" }}>
            <div
              className="bg-white rounded-xl shadow-2xl border px-3.5 py-3"
              style={{
                width: TOOLTIP_W,
                borderColor: activeAgent.color + "44",
                borderLeftWidth: 3,
                borderLeftColor: activeAgent.color,
              }}
            >
              <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: activeAgent.color }}>
                {activeAgent.role}
              </p>
              <ul className="space-y-1.5">
                {activeAgent.capabilities.map((c) => (
                  <li key={c} className="flex items-start gap-1.5 text-[11px] text-gray-600 leading-snug">
                    <span className="mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: activeAgent.color }} />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Hero product mockup card ──────────────────────────────── */
function HeroProductCard() {
  return (
    <div className="relative select-none">
      {/* Floating recording indicator */}
      <div className="absolute -top-4 -left-3 z-20 flex items-center gap-2 bg-gray-900/95 backdrop-blur-sm border border-white/15 rounded-full px-3.5 py-2 shadow-xl">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
        <span className="text-[12px] font-semibold text-white">Recording · 04:32</span>
      </div>

      {/* Browser frame */}
      <div
        className="rounded-2xl overflow-hidden border border-white/12"
        style={{ boxShadow: "0 30px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)" }}
      >
        {/* Chrome bar */}
        <div className="bg-[#111827] border-b border-white/8 px-4 py-2.5 flex items-center gap-2.5">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/60" />
          </div>
          <div className="flex-1 mx-2 bg-white/8 rounded-md px-3 py-1 text-[10px] text-white/25 font-mono">
            app.halonote.com/notes/new
          </div>
        </div>

        {/* Note content */}
        <div className="bg-[#0a0f1e] p-5 space-y-3">
          {/* Patient / note header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] text-white/30 mb-0.5 font-medium tracking-wide">Maria Santos · Cardiology · Follow-up</div>
              <div className="text-[17px] font-bold text-white">SOAP Note</div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[10px] bg-violet-500/20 text-violet-300 border border-violet-500/25 font-semibold px-2 py-0.5 rounded-full flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5" />AI
              </span>
              <button className="text-[11px] bg-blue-600 text-white font-semibold px-3 py-1 rounded-full hover:bg-blue-500 transition-colors">
                Sign →
              </button>
            </div>
          </div>

          {/* Quality bar */}
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="text-[20px] font-black text-emerald-400 leading-none">91</div>
            <div className="flex-1">
              <div className="text-[10px] font-bold text-emerald-400 mb-1">Note Quality Score</div>
              <div className="w-full bg-white/10 rounded-full h-1">
                <div className="bg-emerald-500 h-1 rounded-full" style={{ width: "91%" }} />
              </div>
            </div>
            <div className="text-[9px] text-emerald-500 font-medium text-right leading-tight">All elements<br />present</div>
          </div>

          {/* SOAP sections */}
          {[
            { label: "S", title: "Subjective", color: "blue" as const,    text: "Patient reports headaches improved from daily to once weekly since medication adjustment last month. Denies dizziness or palpitations." },
            { label: "O", title: "Objective",  color: "violet" as const,  text: "BP: 128/82 mmHg. HR: 74 bpm, regular. Alert, well-appearing, no acute distress." },
            { label: "A", title: "Assessment", color: "amber" as const,   text: "1. Essential HTN, now well-controlled\n2. Chronic headache, resolving with BP optimization" },
          ].map((s) => {
            const borderMap = { blue: "border-blue-500/20", violet: "border-violet-500/20", amber: "border-amber-500/20" };
            const bgMap     = { blue: "bg-blue-500/6",      violet: "bg-violet-500/6",      amber: "bg-amber-500/6" };
            const textMap   = { blue: "text-blue-400",      violet: "text-violet-400",      amber: "text-amber-400" };
            return (
              <div key={s.label} className={`rounded-lg p-3 border ${borderMap[s.color]} ${bgMap[s.color]}`}>
                <div className={`text-[9px] font-black uppercase tracking-widest mb-1 ${textMap[s.color]}`}>{s.label}, {s.title}</div>
                <p className="text-[11px] text-white/50 leading-relaxed whitespace-pre-line">{s.text}</p>
              </div>
            );
          })}

          {/* Code strip */}
          <div className="flex items-center gap-2 flex-wrap pt-0.5">
            <span className="text-[9px] font-bold text-white/25 uppercase tracking-widest">ICD-10</span>
            {["I10", "G43.909"].map((c) => (
              <span key={c} className="font-mono text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/20 px-2 py-0.5 rounded">{c}</span>
            ))}
            <span className="ml-auto font-mono text-[10px] bg-violet-500/15 text-violet-300 border border-violet-500/20 px-2 py-0.5 rounded">99214</span>
          </div>
        </div>
      </div>

      {/* Floating "generated in" badge */}
      <div className="absolute -bottom-4 -right-3 z-20 bg-gray-900/95 backdrop-blur-sm border border-white/15 rounded-xl px-3.5 py-2.5 shadow-xl text-center">
        <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest mb-0.5">Generated in</div>
        <div className="text-[22px] font-black text-white leading-none">84<span className="text-[12px] text-white/40 font-semibold ml-0.5">sec</span></div>
      </div>
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="rounded-2xl overflow-hidden border border-gray-200 shadow-2xl w-full max-w-3xl mx-auto">
      {/* Browser chrome */}
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400" />
          <div className="w-3 h-3 rounded-full bg-amber-400" />
          <div className="w-3 h-3 rounded-full bg-emerald-400" />
        </div>
        <div className="flex-1 mx-2 bg-white rounded-md px-3 py-1.5 text-[11px] text-gray-400 border border-gray-200 font-mono">
          app.halonote.com/notes/1847
        </div>
        <div className="text-[10px] text-gray-400 hidden sm:block">Halo Note · Secure Session</div>
      </div>

      {/* App chrome */}
      <div className="flex bg-white min-h-[480px]">
        {/* Mini sidebar */}
        <div className="w-14 bg-gray-50 border-r border-gray-100 flex flex-col items-center py-4 gap-3 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <HaloNoteLogoIcon size={20} color="white" />
          </div>
          <div className="mt-2 space-y-2">
            {[LayoutDashboard, Mic, Users, FileText, Calendar].map((Icon, i) => (
              <div key={i} className={`w-8 h-8 rounded-lg flex items-center justify-center ${i === 3 ? "bg-blue-100" : "hover:bg-gray-100"}`}>
                <Icon className={`w-4 h-4 ${i === 3 ? "text-blue-600" : "text-gray-400"}`} />
              </div>
            ))}
          </div>
        </div>

        {/* Note content */}
        <div className="flex-1 overflow-auto p-6 space-y-4">
          {/* Note header */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[12px] text-gray-400 mb-1 font-medium">Maria Santos · Follow-up Visit · Cardiology</div>
              <div className="text-[20px] font-bold text-gray-900">SOAP Note</div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px] bg-amber-50 text-amber-700 border border-amber-200 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                Draft
              </span>
              <span className="text-[11px] bg-violet-50 text-violet-700 border border-violet-200 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                AI Generated
              </span>
              <button className="text-[12px] bg-blue-600 text-white font-semibold px-4 py-1.5 rounded-full hover:bg-blue-700 transition-colors">
                Finalize →
              </button>
            </div>
          </div>

          {/* Quality score bar */}
          <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
            <div className="text-[22px] font-black text-emerald-600 leading-none">91</div>
            <div className="flex-1">
              <div className="text-[11px] font-bold text-emerald-700 mb-1">Note Quality Score</div>
              <div className="w-full bg-emerald-100 rounded-full h-1.5">
                <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: "91%" }} />
              </div>
            </div>
            <div className="text-[10px] text-emerald-600 font-medium text-right">
              All key<br />elements present
            </div>
          </div>

          {/* SOAP sections */}
          {[
            {
              label: "S, Subjective",
              color: "blue",
              content: "Patient is a 58-year-old female with a history of hypertension and hyperlipidemia presenting for follow-up after medication adjustment last month. She reports significant improvement in headache frequency, now occurring approximately once weekly compared to daily. Denies dizziness, palpitations, or shortness of breath at rest.",
            },
            {
              label: "O, Objective",
              color: "violet",
              content: "BP: 128/82 mmHg (improved from 152/94). HR: 74 bpm, regular. Weight: 164 lbs (stable). General: Alert, well-appearing, in no acute distress. Cardiovascular: Regular rate and rhythm, no murmurs.",
            },
            {
              label: "A, Assessment",
              color: "amber",
              content: "1. Essential hypertension, now well-controlled on current regimen\n2. Hyperlipidemia, lipids stable on statin therapy\n3. Chronic daily headache, resolving with blood pressure optimization",
            },
            {
              label: "P, Plan",
              color: "emerald",
              content: "Continue lisinopril 20mg daily. Continue atorvastatin 40mg nightly. Labs ordered: BMP, lipid panel, CBC. Return in 3 months or sooner if symptoms recur. Patient counseled on low-sodium diet and daily exercise.",
            },
          ].map((section) => (
            <div key={section.label} className={`border border-${section.color}-100 rounded-xl p-4 bg-${section.color}-50/30`}>
              <div className={`text-[10px] font-black uppercase tracking-widest text-${section.color}-500 mb-2`}>
                {section.label}
              </div>
              <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-line">{section.content}</p>
            </div>
          ))}

          {/* Codes strip */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">ICD-10</div>
            {["I10, Essential HTN", "G43.909, Migraine", "E78.5, Hyperlipidemia"].map((c) => (
              <span key={c} className="text-[11px] bg-blue-50 text-blue-700 font-mono font-semibold px-2.5 py-1 rounded-md border border-blue-100">{c}</span>
            ))}
            <span className="ml-auto text-[11px] text-violet-600 font-semibold">E/M: 99214</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── FAQ data + accordion ───────────────────────────────────── */
const FAQ_ITEMS = [
  {
    q: "Is Halo Note HIPAA compliant?",
    a: "Yes, fully. PHI is encrypted at rest and in transit using AES-256. We sign a Business Associate Agreement (BAA) with every practice, maintain tamper-proof audit logs on every access, and store all data in your organization's isolated database. We never use your clinical data to train AI models.",
  },
  {
    q: "Which EHR systems does it integrate with?",
    a: "Halo Note supports native FHIR R4 push to Epic, Cerner, and Athena Health, notes land directly in the chart. For other systems (AllScripts, eClinicalWorks, NextGen, and 10+ more), we support structured exports and our open API.",
  },
  {
    q: "How accurate is the transcription?",
    a: "We use OpenAI Whisper, achieving over 95% clinical transcription accuracy even with medical terminology, accents, and background noise. The AI automatically identifies and formats clinical terms, drug names, and diagnostic codes. You always review before signing.",
  },
  {
    q: "How long does setup take?",
    a: "Most physicians are live in under 15 minutes. You log in, choose your specialty and note templates, and optionally connect your EHR. No IT department required. Our clinical success team is available if you need help.",
  },
  {
    q: "Does it work for my specialty?",
    a: "Yes. Halo Note ships with 36 specialty-specific templates including Internal Medicine, Cardiology, Psychiatry, Emergency Medicine, Pediatrics, Orthopedics, Family Medicine, Neurology, and more. The AI learns your preferred structure and phrasing within the first few encounters.",
  },
  {
    q: "What happens to my patient data?",
    a: "You own all of it, always. Your notes and patient data are stored in your organization's private, isolated database and are never shared, sold, or used to train models. You can export a full copy of your data at any time.",
  },
  {
    q: "Is there a free trial?",
    a: "Yes. We offer a 14-day free trial for solo practitioners, no credit card required. Group practices and health systems can request a guided live demo and a structured pilot program with our clinical success team.",
  },
  {
    q: "How does pricing work?",
    a: "Plans start at $99/month per physician for solo practitioners, with volume discounts for groups of 3+ and custom enterprise contracts for health systems. All plans include the full AI agent suite, unlimited notes, and EHR integration.",
  },
];

function FAQSection({ visible }: { visible: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="max-w-3xl mx-auto space-y-2">
      {FAQ_ITEMS.map((item, i) => (
        <div
          key={i}
          className={`rounded-2xl border transition-all duration-300 ${open === i ? "border-gray-200 bg-white shadow-sm" : "border-gray-100 bg-gray-50/60 hover:border-gray-200 hover:bg-white"} reveal reveal-delay-${Math.min(i + 1, 4)} ${visible ? "revealed" : ""}`}
          data-testid={`faq-item-${i}`}
        >
          <button
            className="w-full flex items-center justify-between gap-4 px-6 py-5 text-left"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
          >
            <span className="text-[15px] font-semibold text-gray-900">{item.q}</span>
            <span
              className={`flex-shrink-0 w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center transition-transform duration-300 ${open === i ? "rotate-180 bg-gray-100" : "bg-white"}`}
            >
              <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 12 12">
                <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          <div
            className="overflow-hidden transition-all duration-300"
            style={{ maxHeight: open === i ? "200px" : "0px", opacity: open === i ? 1 : 0 }}
          >
            <p className="px-6 pb-5 text-[14px] text-gray-500 leading-relaxed">{item.a}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Animated stat ──────────────────────────────────────────── */
function AnimatedStat({ value, label, active }: { value: string; label: string; active: boolean }) {
  const isNumber = /^[\d.]+/.test(value);
  const numPart = parseFloat(value.match(/[\d.]+/)?.[0] || "0");
  const suffix = value.replace(/[\d.]+/, "");
  const count = useCounter(isNumber ? numPart : 0, 1400, active && isNumber);
  const display = isNumber ? `${count}${suffix}` : value;
  return (
    <div className="px-6 py-8 text-center">
      <div className="text-[2rem] font-black text-gray-950 tracking-tight leading-none mb-1"
        style={{ fontVariantNumeric: "tabular-nums" }}>
        {display}
      </div>
      <div className="text-[13px] text-gray-500">{label}</div>
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────── */
export default function LandingPage() {
  const [heroReady, setHeroReady] = useState(false);
  const [statsRef, statsVisible] = useReveal(0.3);
  const [agentsRef, agentsVisible] = useReveal();
  const [howRef, howVisible] = useReveal();
  const [productRef, productVisible] = useReveal();
  const [comparisonRef, comparisonVisible] = useReveal();
  const [researchRef, researchVisible] = useReveal();
  const [featuresRef, featuresVisible] = useReveal();
  const [faqRef, faqVisible] = useReveal();

  useEffect(() => {
    const t = setTimeout(() => setHeroReady(true), 80);
    return () => clearTimeout(t);
  }, []);

  return (
    <MarketingLayout darkHero>
      <SEOMeta
        title="Halo Note, AI Clinical Team for Physicians"
        description="Six specialized AI agents handling documentation, coding, pre-charting, and research. Built for real clinical workflows."
      />

      {/* ── HERO ─────────────────────────────────────────────────── */}
      <section
        className="relative min-h-screen flex flex-col items-center justify-start pt-36 pb-0 px-5 overflow-hidden"
        data-testid="section-hero"
      >
        {/* Video background, poster fills the gap while video buffers */}
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

        {/* Gradient overlay, light enough to see the video, dark enough for text */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "linear-gradient(to bottom, rgba(3,7,18,0.45) 0%, rgba(3,7,18,0.30) 40%, rgba(3,7,18,0.55) 75%, rgba(3,7,18,0.80) 100%)",
          }}
        />

        {/* Hero content, 2-col on lg+, centered on mobile */}
        <div
          className="relative z-10 w-full max-w-6xl mx-auto transition-all duration-700"
          style={{ opacity: heroReady ? 1 : 0, transform: heroReady ? "translateY(0)" : "translateY(20px)" }}
        >
          <div className="flex flex-col lg:flex-row items-center gap-10 lg:gap-16">
            {/* Left: text content */}
            <div className="flex-1 text-center lg:text-left space-y-6 max-w-2xl lg:max-w-[560px] mx-auto lg:mx-0">
              <div
                className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/20 bg-white/10 backdrop-blur-sm text-[12px] font-medium tracking-wide text-white/80"
                data-testid="badge-hero"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Now in Early Access · Built for Physicians
              </div>

              <h1
                className="text-[clamp(2.4rem,5vw,4.2rem)] font-black tracking-tight leading-[1.04] text-white"
                data-testid="text-hero-headline"
              >
                Your AI clinical team,
                <br />
                built for{" "}
                <span
                  className="italic"
                  style={{
                    background: "linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}
                >
                  real medicine.
                </span>
              </h1>

              <p
                className="text-[17px] md:text-[19px] text-white/65 leading-relaxed"
                data-testid="text-hero-subheadline"
              >
                Six specialized AI agents, handling documentation, coding,
                interpretation, and research, so you can focus entirely on care.
              </p>

              <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3 pt-2">
                <Link href="/request-access">
                  <Button
                    size="lg"
                    className="h-13 px-8 text-[15px] font-semibold rounded-full bg-white text-gray-950 hover:bg-gray-100 shadow-lg transition-all duration-200 group"
                    data-testid="button-hero-request-access"
                  >
                    Request Early Access
                    <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
                  </Button>
                </Link>
                <Link href="/product">
                  <Button
                    size="lg"
                    variant="ghost"
                    className="h-13 px-8 text-[15px] font-medium rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-all"
                    data-testid="button-hero-learn-more"
                  >
                    See how it works
                  </Button>
                </Link>
              </div>

              {/* Trust micro-copy, desktop only */}
              <div className="hidden lg:flex items-center gap-5 pt-2">
                {["HIPAA Compliant", "End-to-End Encrypted", "SOC 2 Ready"].map((t) => (
                  <div key={t} className="flex items-center gap-1.5 text-[12px] text-white/40">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    {t}
                  </div>
                ))}
              </div>
            </div>

            {/* Right: product mockup, desktop only */}
            <div className="hidden lg:block flex-shrink-0 w-[380px] xl:w-[420px] mt-8 lg:mt-0">
              <HeroProductCard />
            </div>
          </div>
        </div>

        {/* Agent network, shown on tablet/sm, hidden on lg+ (product card takes over) */}
        <div className="relative z-10 mt-4 w-full hidden sm:block lg:hidden">
          <AgentNetwork />
        </div>

        {/* Mobile agent pills */}
        <div className="relative z-10 mt-10 flex flex-wrap justify-center gap-2 sm:hidden pb-16">
          {AGENTS.map((a) => {
            const Icon = a.icon;
            return (
              <div key={a.id} className="flex items-center gap-2 bg-white/10 backdrop-blur-sm border border-white/20 rounded-full px-3 py-1.5">
                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: a.color }}>
                  <Icon className="w-2.5 h-2.5 text-white" />
                </div>
                <span className="text-[12px] font-semibold text-white/80">{a.name}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── STATS BAR ─────────────────────────────────────────────── */}
      <section className="border-y border-gray-200 bg-white" data-testid="section-stats">
        <div ref={statsRef} className="max-w-5xl mx-auto px-5">
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-gray-100">
            {[
              { value: "2.1 hrs", label: "Saved per physician daily" },
              { value: "36+", label: "Specialty templates" },
              { value: "90 sec", label: "Note generated" },
              { value: "13", label: "EHR systems integrated" },
            ].map((s, i) => (
              <AnimatedStat key={i} value={s.value} label={s.label} active={statsVisible} />
            ))}
          </div>
        </div>
      </section>

      {/* ── AGENTS SHOWCASE ───────────────────────────────────────── */}
      <section className="py-24 md:py-32" style={{ background: "#f9f8f6" }} data-testid="section-agents">
        <div ref={agentsRef} className={`max-w-5xl mx-auto px-5 reveal ${agentsVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">The Team</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              Six AI specialists.<br />One seamless workflow.
            </h2>
            <p className="text-gray-500 text-[16px] max-w-lg mx-auto leading-relaxed">
              Each agent masters its domain. Together, they cover the full lifecycle of every encounter.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {AGENTS.map((agent, i) => {
              const Icon = agent.icon;
              return (
                <Link
                  key={agent.id}
                  href="/product"
                  className={`block rounded-2xl border border-gray-100 bg-white p-6 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 reveal reveal-delay-${Math.min(i + 1, 4)} ${agentsVisible ? "revealed" : ""}`}
                  data-testid={`agent-showcase-${agent.id}`}
                >
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: agent.color + "22" }}>
                    <Icon className="w-[22px] h-[22px]" style={{ color: agent.color }} />
                  </div>
                  <div className="font-bold text-[15px] text-gray-900 mb-0.5">{agent.name}</div>
                  <div className="text-[12px] text-gray-500 font-medium mb-3">{agent.role}</div>
                  <ul className="space-y-1.5">
                    {agent.capabilities.map((c) => (
                      <li key={c} className="flex items-center gap-2 text-[13px] text-gray-600">
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: agent.color }} />
                        {c}
                      </li>
                    ))}
                  </ul>
                </Link>
              );
            })}
          </div>

          <div className="text-center mt-10">
            <Link href="/product">
              <Button variant="outline" className="rounded-full border-gray-200 text-gray-600 hover:text-gray-900 hover:border-gray-300 h-10 px-7 text-[13px] font-semibold group" data-testid="link-explore-agents">
                Explore all agents
                <ArrowRight className="w-3.5 h-3.5 ml-1.5 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────── */}
      <section className="py-24 md:py-32 bg-white" data-testid="section-demo">
        <div ref={howRef} className={`max-w-5xl mx-auto px-5 reveal ${howVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">How It Works</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              From conversation<br />to chart in three steps.
            </h2>
          </div>

          <div className="grid lg:grid-cols-3 gap-5">
            {[
              {
                num: "01", title: "Ambient Recording", icon: Mic, iconBg: "bg-blue-600",
                body: "Just see your patient. Halo Note captures the encounter silently in the background.",
                preview: (
                  <div className="text-center space-y-3">
                    <div className="text-[32px] font-bold font-mono text-white tracking-wider">04:32</div>
                    <div className="text-[11px] text-white/30">Patient: Maria Santos</div>
                    <div className="flex items-end justify-center gap-[3px] h-8">
                      {[14,24,18,36,20,42,16,32,22,38,26].map((h, j) => (
                        <div key={j} className="w-[3px] rounded-full bg-blue-500" style={{ height: h, opacity: 0.3 + (h / 42) * 0.7 }} />
                      ))}
                    </div>
                  </div>
                ),
                badge: <span className="text-[10px] text-emerald-400 border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 rounded-full flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Live</span>,
              },
              {
                num: "02", title: "Live Transcription", icon: Zap, iconBg: "bg-violet-600",
                body: "Whisper AI identifies speakers, medical terms, and clinical context in real time.",
                preview: (
                  <div className="space-y-2.5 text-[12px]">
                    <div><span className="text-blue-400 font-semibold text-[10px] uppercase tracking-wider">Dr. Patel</span><p className="text-white/60 mt-0.5">How have you been feeling since we adjusted your medication?</p></div>
                    <div><span className="text-emerald-400 font-semibold text-[10px] uppercase tracking-wider">Patient</span><p className="text-white/60 mt-0.5">Much better. Headaches went from daily to once a week.</p></div>
                    <div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" /><span className="text-white/25 text-[10px]">Transcribing...</span></div>
                  </div>
                ),
                badge: <span className="text-[10px] text-violet-400 border border-violet-400/30 bg-violet-400/10 px-2.5 py-1 rounded-full">2 speakers</span>,
              },
              {
                num: "03", title: "Review & Sign", icon: Brain, iconBg: "bg-emerald-600",
                body: "Your complete note, ready to review, edit, and push directly into your EHR.",
                preview: (
                  <div className="space-y-2 text-[12px] bg-white/5 rounded-lg p-3">
                    <div className="font-bold text-white/40 text-[9px] uppercase tracking-wider">SOAP · Cardiology</div>
                    <p className="text-white/70 leading-relaxed">Patient reports significant improvement in headache frequency. Decreased from daily to approx. once weekly. Denies dizziness or nausea.</p>
                    <div className="flex gap-1.5 flex-wrap pt-1">
                      {["I10", "G43.909"].map(c => <span key={c} className="font-mono text-[10px] bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded">{c}</span>)}
                      <span className="font-mono text-[10px] bg-violet-500/20 text-violet-300 px-2 py-0.5 rounded">99214</span>
                    </div>
                  </div>
                ),
                badge: <span className="text-[10px] font-medium text-amber-300 border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 rounded-full flex items-center gap-1"><Sparkles className="w-3 h-3" />AI Generated</span>,
              },
            ].map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={i} className={`rounded-2xl overflow-hidden border border-gray-200 bg-white shadow-sm reveal reveal-delay-${i + 1} ${howVisible ? "revealed" : ""}`} data-testid={`card-preview-${i}`}>
                  <div className="bg-gray-950 p-6 min-h-[200px] flex flex-col justify-between">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-lg ${step.iconBg} flex items-center justify-center`}>
                          <Icon className="w-4 h-4 text-white" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">{step.title}</span>
                      </div>
                      {step.badge}
                    </div>
                    {step.preview}
                  </div>
                  <div className="p-5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">{step.num}</span>
                      <h3 className="text-[15px] font-bold text-gray-900">{step.title}</h3>
                    </div>
                    <p className="text-[13px] text-gray-500 leading-relaxed">{step.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── PRODUCT PREVIEW ───────────────────────────────────────── */}
      <section className="py-24 md:py-32" style={{ background: "#f9f8f6" }} data-testid="section-product">
        <div ref={productRef} className={`max-w-5xl mx-auto px-5 reveal ${productVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">The Product</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              This is what your note<br />looks like afterward.
            </h2>
            <p className="text-gray-500 text-[16px] max-w-md mx-auto leading-relaxed">
              Complete, structured, physician-quality documentation, ready to review and push to your EHR.
            </p>
          </div>
          <ProductPreview />
        </div>
      </section>

      {/* ── COMPARISON ────────────────────────────────────────────── */}
      <section className="py-24 md:py-32 bg-white" data-testid="section-comparison">
        <div ref={comparisonRef} className={`max-w-6xl mx-auto px-5 reveal ${comparisonVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Competitive Landscape</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              Built for the whole chart,<br />not just the transcript.
            </h2>
            <p className="text-gray-500 text-[16px] max-w-xl mx-auto leading-relaxed">
              Every other tool stops at transcription. Halo Note delivers coding, analytics, pre-charting, and 6 specialized agents, in a single workflow.
            </p>
          </div>

          {/* Comparison table */}
          <div className="rounded-2xl border border-gray-100 overflow-hidden shadow-md">
            {/* Header row */}
            <div className="grid grid-cols-4 bg-gray-950 text-white">
              <div className="p-5 text-[11px] font-bold uppercase tracking-widest text-white/25 hidden md:block">Capability</div>
              <div className="p-5 text-center hidden md:block">
                <div className="text-[12px] font-bold text-white/70 leading-tight">Dragon Medical One</div>
                <div className="text-[10px] text-white/35 mt-1">Legacy Dictation</div>
              </div>
              <div className="p-5 text-center hidden md:block">
                <div className="text-[12px] font-bold text-white/70 leading-tight">Nuance DAX / Suki</div>
                <div className="text-[10px] text-white/35 mt-1">Basic AI Scribes</div>
              </div>
              <div className="p-5 text-center bg-blue-600 hidden md:block">
                <div className="text-[13px] font-black text-white leading-tight">✦ Halo Note</div>
                <div className="text-[10px] text-blue-200 mt-1">Full AI Clinical OS</div>
              </div>
              {/* Mobile header */}
              <div className="col-span-4 p-4 md:hidden flex items-center justify-between">
                <span className="text-[11px] text-white/40 uppercase tracking-widest">Comparing 4 platforms</span>
                <span className="text-[11px] font-bold text-blue-300">✦ Halo Note wins</span>
              </div>
            </div>

            {/* Data rows */}
            {[
              {
                capability: "Note completion time",
                dragon: "5–15 min post-visit",
                nuance: "2–4 min review",
                halo: "< 90 sec to review",
                dragonBad: true,
              },
              {
                capability: "Documentation method",
                dragon: "Dictation only",
                nuance: "Ambient recording",
                halo: "Ambient + on-demand",
              },
              {
                capability: "EHR integration",
                dragon: "Dictation embed",
                nuance: "Structured push (limited)",
                halo: "Native FHIR push, 13 EHRs",
                dragonBad: true,
                nuanceMid: true,
              },
              {
                capability: "Medical coding (ICD/CPT)",
                dragon: "Not included",
                nuance: "Not included",
                halo: "ICD-10, CPT, E/M built-in",
                dragonBad: true,
                nuanceBad: true,
              },
              {
                capability: "Specialized AI agents",
                dragon: "None",
                nuance: "None",
                halo: "6 dedicated agents",
                dragonBad: true,
                nuanceBad: true,
              },
              {
                capability: "Pre-visit intelligence",
                dragon: "None",
                nuance: "Limited",
                halo: "Full EHR pre-charting",
                dragonBad: true,
                nuanceMid: true,
              },
              {
                capability: "Note quality scoring",
                dragon: "None",
                nuance: "None",
                halo: "Live 0–100 quality score",
                dragonBad: true,
                nuanceBad: true,
              },
              {
                capability: "Practice analytics",
                dragon: "None",
                nuance: "Basic",
                halo: "Real-time org dashboard",
                dragonBad: true,
                nuanceMid: true,
              },
              {
                capability: "Languages supported",
                dragon: "English only",
                nuance: "English + limited",
                halo: "40+ languages",
                dragonBad: true,
                nuanceMid: true,
              },
              {
                capability: "Transparent pricing",
                dragon: "Contact sales",
                nuance: "Contact sales",
                halo: "Starts at $99/mo",
                dragonBad: true,
                nuanceBad: true,
              },
            ].map((row, i) => (
              <div
                key={i}
                className={`grid grid-cols-4 border-t border-gray-100 ${i % 2 === 0 ? "bg-white" : "bg-gray-50/40"}`}
              >
                <div className="p-4 text-[13px] font-semibold text-gray-800 border-r border-gray-100 hidden md:flex items-center">{row.capability}</div>
                <div className={`p-4 text-center text-[12px] hidden md:flex items-center justify-center ${row.dragonBad ? "text-gray-300" : "text-gray-500"}`}>
                  {row.dragonBad ? <span className="text-gray-300">{row.dragon}</span> : row.dragon}
                </div>
                <div className={`p-4 text-center text-[12px] hidden md:flex items-center justify-center ${row.nuanceBad ? "text-gray-300" : row.nuanceMid ? "text-amber-500" : "text-gray-500"}`}>
                  {row.nuance}
                </div>
                <div className="p-4 text-center text-[13px] font-bold text-blue-700 bg-blue-50/70 hidden md:flex items-center justify-center">{row.halo}</div>
                {/* Mobile row */}
                <div className="col-span-4 p-4 md:hidden">
                  <div className="text-[12px] font-semibold text-gray-700 mb-2">{row.capability}</div>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className={`text-center p-2 rounded-lg bg-gray-50 ${row.dragonBad ? "text-gray-300" : "text-gray-500"}`}><div className="font-medium text-gray-400 mb-1">Dragon</div>{row.dragon}</div>
                    <div className={`text-center p-2 rounded-lg bg-gray-50 ${row.nuanceBad ? "text-gray-300" : row.nuanceMid ? "text-amber-500" : "text-gray-500"}`}><div className="font-medium text-gray-400 mb-1">DAX/Suki</div>{row.nuance}</div>
                    <div className="text-center p-2 rounded-lg bg-blue-50 text-blue-700 font-bold"><div className="font-medium text-blue-400 mb-1">Halo</div>{row.halo}</div>
                  </div>
                </div>
              </div>
            ))}

            {/* Footer note */}
            <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 hidden md:block">
              <p className="text-[11px] text-gray-400 text-center">Competitor data based on publicly available documentation as of Q1 2025. Pricing is approximate. Feature availability may vary by plan.</p>
            </div>
          </div>

          {/* Bottom CTA */}
          <div className="mt-10 text-center">
            <Link href="/demo">
              <Button size="lg" className="rounded-full px-8 h-12 text-[14px] font-bold bg-gray-950 text-white hover:bg-gray-800 transition-all duration-300 group" data-testid="button-comparison-demo">
                See it live, try the sandbox demo
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ── THE DATA ──────────────────────────────────────────────── */}
      <section className="relative py-24 md:py-32 overflow-hidden" data-testid="section-research">
        {/* Video background */}
        <video
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay muted loop playsInline aria-hidden="true"
          src="/crisis-video.mp4"
          style={{ background: "#030712" }}
        />
        {/* Overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, rgba(3,7,18,0.68) 0%, rgba(3,7,18,0.55) 50%, rgba(3,7,18,0.72) 100%)" }}
        />

        <div ref={researchRef} className={`relative z-10 max-w-5xl mx-auto px-5 reveal ${researchVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">Published Research</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-white tracking-tight leading-[1.06]">
              The documentation crisis<br />is not a feeling. It's data.
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {RESEARCH_STATS.map((s, i) => (
              <div
                key={i}
                className={`rounded-2xl p-6 border border-white/15 bg-white/10 backdrop-blur-sm flex flex-col gap-3 hover:bg-white/20 hover:-translate-y-0.5 transition-all duration-300 reveal reveal-delay-${Math.min(i + 1, 4)} ${researchVisible ? "revealed" : ""}`}
                data-testid={`card-stat-${i}`}
              >
                <div className="text-[2.8rem] font-black text-white leading-none tracking-tight">{s.stat}</div>
                <p className="text-[13px] text-white/70 leading-relaxed flex-1">{s.detail}</p>
                <div className="pt-3 border-t border-white/15">
                  <span className="text-[11px] text-white/40 font-medium">{s.source}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── DIFFERENTIATORS ───────────────────────────────────────── */}
      <section className="py-24 md:py-32 bg-white" data-testid="section-features">
        <div ref={featuresRef} className={`max-w-5xl mx-auto px-5 reveal ${featuresVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Why Halo Note</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              Depth over breadth.<br />EHR-native. Clinician-first.
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5 mb-14">
            {[
              { icon: Shield, title: "HIPAA-native", body: "PHI never leaves your encrypted database. End-to-end encryption. Audit logs. You own every note.", color: "#10b981" },
              { icon: Zap, title: "Deep EHR push", body: "Native FHIR R4 push to Epic, Cerner, and Athena. Not export, push. Notes land in your chart.", color: "#3b82f6" },
              { icon: Brain, title: "Learns your style", body: "36 specialty templates. An AI that learns your phrasing, structure, and format from day one.", color: "#7c3aed" },
            ].map((d, i) => {
              const Icon = d.icon;
              return (
                <div key={d.title} className={`rounded-2xl border border-gray-200 bg-white p-8 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 reveal reveal-delay-${i + 1} ${featuresVisible ? "revealed" : ""}`}>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5" style={{ background: d.color + "18" }}>
                    <Icon className="w-6 h-6" style={{ color: d.color }} />
                  </div>
                  <div className="text-[18px] font-bold text-gray-950 mb-2">{d.title}</div>
                  <p className="text-[14px] text-gray-500 leading-relaxed">{d.body}</p>
                </div>
              );
            })}
          </div>

          {/* EHR marquee */}
          <div className="mt-2">
            <p className="text-center text-[12px] font-semibold uppercase tracking-widest text-gray-400 mb-6">Integrates natively with</p>
            <div className="relative overflow-hidden rounded-2xl border border-gray-100 bg-gray-50/60 py-5">
              {/* Fade edges */}
              <div className="pointer-events-none absolute inset-y-0 left-0 w-16 z-10" style={{ background: "linear-gradient(to right, #f9f8f6, transparent)" }} />
              <div className="pointer-events-none absolute inset-y-0 right-0 w-16 z-10" style={{ background: "linear-gradient(to left, #f9f8f6, transparent)" }} />

              <div className="marquee-track">
                {[...["Epic", "Cerner", "Athena Health", "AllScripts", "eClinicalWorks", "Meditech", "NextGen", "DrChrono", "Kareo", "Greenway Health", "ModMed", "Practice Fusion", "Amazing Charts"], ...["Epic", "Cerner", "Athena Health", "AllScripts", "eClinicalWorks", "Meditech", "NextGen", "DrChrono", "Kareo", "Greenway Health", "ModMed", "Practice Fusion", "Amazing Charts"]].map((ehr, i) => (
                  <div key={i} className="flex-shrink-0 mx-3 px-5 py-2.5 rounded-full border border-gray-200 bg-white text-[13px] font-semibold text-gray-600 shadow-sm whitespace-nowrap">
                    {ehr}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────────── */}
      <section className="py-24 md:py-32 bg-white" data-testid="section-faq">
        <div ref={faqRef} className={`max-w-5xl mx-auto px-5 reveal ${faqVisible ? "revealed" : ""}`}>
          <div className="text-center mb-14 space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">FAQ</p>
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-gray-950 tracking-tight leading-[1.06]">
              Questions physicians<br />actually ask us.
            </h2>
            <p className="text-gray-500 text-[16px] max-w-lg mx-auto leading-relaxed">
              Everything you need to know before your first note.
            </p>
          </div>
          <FAQSection visible={faqVisible} />
          <div className="text-center mt-12">
            <Link href="/request-access">
              <Button
                className="h-11 px-8 text-[14px] font-semibold rounded-full bg-gray-950 text-white hover:bg-gray-800 transition-all duration-200 group shadow-sm"
                data-testid="button-faq-cta"
              >
                Still have questions? Talk to us
                <ArrowRight className="w-3.5 h-3.5 ml-2 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ─────────────────────────────────────────────── */}
      <section className="py-28 md:py-40 relative overflow-hidden" data-testid="section-cta">
        {/* Video background */}
        <video
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay muted loop playsInline aria-hidden="true"
          src="/cta-video.mp4"
          style={{ background: "#030712" }}
        />
        {/* Dark overlay, deep enough to keep text legible */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, rgba(3,7,18,0.72) 0%, rgba(3,7,18,0.58) 50%, rgba(3,7,18,0.78) 100%)" }}
        />
        {/* Subtle blue glow on top of overlay */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(37,99,235,0.10) 0%, transparent 70%)" }} />

        <div className="relative max-w-3xl mx-auto px-5 text-center space-y-7">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/15 bg-white/8 text-white/60 text-[12px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Now in Early Access
          </div>
          <h2 className="text-[clamp(2.5rem,5vw,4rem)] font-black text-white tracking-tight leading-[1.06]">
            Your patients want<br />your attention.
            <br />
            <span style={{ color: "#60a5fa" }}>Not your notes.</span>
          </h2>
          <p className="text-[17px] text-white/55 leading-relaxed max-w-lg mx-auto">
            Join physicians who have reclaimed their evenings, their focus, and their love of medicine.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link href="/request-access">
              <Button
                size="lg"
                className="h-13 px-10 text-[15px] font-semibold rounded-full bg-white text-gray-950 hover:bg-gray-100 shadow-md transition-all duration-200 group"
                data-testid="button-cta-request"
              >
                Request Early Access
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
            <Link href="/pricing">
              <Button
                size="lg"
                variant="ghost"
                className="h-13 px-8 text-[15px] font-medium rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all"
                data-testid="button-cta-pricing"
              >
                See pricing
              </Button>
            </Link>
          </div>

          <div className="flex flex-wrap justify-center gap-x-8 gap-y-3 pt-4">
            {["HIPAA Compliant", "SOC 2 Ready", "End-to-End Encryption", "Physician-controlled data"].map((t) => (
              <div key={t} className="flex items-center gap-2 text-[13px] text-white/40">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                {t}
              </div>
            ))}
          </div>
        </div>
      </section>

    </MarketingLayout>
  );
}
