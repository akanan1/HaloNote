import { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import { ArrowRight, Heart, ShieldCheck, Zap, Brain, CheckCircle2, ChevronDown } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
// Founder photos lived in the Replit project's `attached_assets/`
// folder, which wasn't included in the source tarball. Until they're
// re-uploaded, point at neutral placeholder URLs so the rest of the
// page renders identically. Drop the real images into
// `public/founders/` and update these refs to restore the originals.
const abdullahPhoto = "/founders/abdullah.jpg";
const asbahiPhoto = "/founders/asbahi.png";

/* ─────────────────────────────── hooks ──────────────────────────── */
function useInView(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

function useCountUp(to: number, from: number, decimals: number, isVisible: boolean, delay = 0) {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (!isVisible) return;
    const duration = 1400;
    let raf: number;
    const timer = setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        setVal(from + (to - from) * eased);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [isVisible, to, from, delay]);
  return decimals ? val.toFixed(decimals) : Math.round(val).toString();
}

/* ─────────────────────────────── reveal ─────────────────────────── */
function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, visible } = useInView();
  return (
    <div ref={ref} style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"} ${className}`}>
      {children}
    </div>
  );
}

/* ─────────────────────── spotlight card (values) ────────────────── */
function SpotlightCard({ color, children, className = "" }: { color: string; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, on: false });
  const handleMove = useCallback((e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: e.clientX - r.left, y: e.clientY - r.top, on: true });
  }, []);
  return (
    <div ref={ref} onMouseMove={handleMove} onMouseLeave={() => setPos(p => ({ ...p, on: false }))}
      className={`relative overflow-hidden rounded-2xl border border-white/8 bg-white/4 p-7 transition-all duration-300 hover:border-white/20 hover:bg-white/7 cursor-default ${className}`}
      style={pos.on ? { background: `radial-gradient(280px circle at ${pos.x}px ${pos.y}px, ${color}22, transparent 70%), rgba(255,255,255,0.04)` } : {}}>
      {children}
    </div>
  );
}

/* ──────────────────────── flip card (team) ──────────────────────── */
function TeamFlipCard({ member }: { member: typeof TEAM[0] }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div
      className="relative h-[420px] cursor-pointer"
      style={{ perspective: "1200px" }}
      onMouseEnter={() => setFlipped(true)}
      onMouseLeave={() => setFlipped(false)}
      data-testid={`card-team-${member.name.toLowerCase().replace(/\s/g, "-")}`}
    >
      <div
        className="relative w-full h-full"
        style={{
          transformStyle: "preserve-3d",
          transition: "transform 0.65s cubic-bezier(0.16, 1, 0.3, 1)",
          transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        {/* front */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden border border-gray-100 bg-white shadow-sm" style={{ backfaceVisibility: "hidden" }}>
          <div className="h-64 bg-gray-100"
            style={member.photo ? {
              backgroundImage: `url(${member.photo})`,
              backgroundSize: member.bgSize ?? "cover",
              backgroundPosition: member.bgPosition ?? "center 20%",
              backgroundRepeat: "no-repeat",
            } : { background: `${member.color}18` }}
          >
            {!member.photo && (
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-white font-black text-[24px]" style={{ background: member.color }}>
                  {member.initials}
                </div>
              </div>
            )}
          </div>
          <div className="p-7">
            <p className="text-[19px] font-bold text-gray-950 mb-0.5">{member.name}</p>
            <p className="text-[13px] font-semibold mb-3" style={{ color: member.color }}>{member.title}</p>
          </div>
        </div>
        {/* back */}
        <div
          className="absolute inset-0 rounded-3xl overflow-hidden p-8 flex flex-col justify-center"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", background: `linear-gradient(135deg, ${member.color}18 0%, ${member.color}08 100%)`, border: `1px solid ${member.color}30` }}
        >
          <p className="text-[20px] font-bold text-gray-950 mb-1">{member.name}</p>
          <p className="text-[13px] font-semibold mb-5" style={{ color: member.color }}>{member.title}</p>
          <p className="text-[14px] text-gray-600 leading-relaxed">{member.bio}</p>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────── stat card ─────────────────────────────── */
function StatCard({ stat, delay = 0 }: { stat: typeof STATS[0]; delay?: number }) {
  const { ref, visible } = useInView(0.3);
  const counted = useCountUp(stat.to, stat.from, stat.decimals, visible && stat.countable, delay);
  const display = stat.countable ? `${stat.prefix}${counted}${stat.suffix}` : stat.raw;
  return (
    <div ref={ref}
      className={`group rounded-2xl border border-gray-100 bg-gray-50/60 p-6 hover:bg-white hover:border-gray-200 hover:shadow-xl transition-all duration-300 cursor-default ${visible ? "stat-pop" : "opacity-0"}`}
      style={visible ? { animationDelay: `${delay}ms` } : {}}>
      <div className="text-[2.8rem] font-black leading-none mb-2 tabular-nums group-hover:scale-105 transition-transform duration-200 origin-left" style={{ color: stat.color }}>
        {display}
      </div>
      <p className="text-[12px] text-gray-500 font-medium leading-snug">{stat.label}</p>
    </div>
  );
}

/* ─────────────────────────── word rise ──────────────────────────── */
function WordRise({ text, baseDelay = 0, className = "" }: { text: string; baseDelay?: number; className?: string }) {
  return (
    <span aria-label={text} className={className}>
      {text.split(" ").map((word, i) => (
        <span key={i} className="word-rise inline-block mr-[0.25em]" style={{ animationDelay: `${baseDelay + i * 80}ms` }}>
          {word}
        </span>
      ))}
    </span>
  );
}

/* ─────────────────────── vision tag ─────────────────────── */
function VisionTag({ tag, index }: { tag: typeof VISION_TAGS[0]; index: number }) {
  return (
    <button
      className="relative overflow-hidden px-4 py-2 rounded-full border border-white/20 bg-white/8 text-[13px] font-semibold text-gray-200 backdrop-blur-sm hover:border-white/40 hover:text-white hover:bg-white/15 transition-all duration-200 cursor-default group"
      style={{ transitionDelay: `${index * 30}ms` }}
      data-testid={`tag-vision-${tag.label.toLowerCase().replace(/\s/g, "-")}`}
    >
      <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-500 ease-in-out" />
      {tag.label}
    </button>
  );
}

/* ──────────────────────────── data ──────────────────────────────── */
const STATS = [
  { raw: "15.5h", countable: true, from: 0, to: 15.5, decimals: 1, prefix: "", suffix: "h", label: "Admin tasks per week", color: "#6366f1" },
  { raw: "1 in 3", countable: false, from: 0, to: 0, decimals: 0, prefix: "", suffix: "", label: "Physicians report burnout", color: "#f43f5e" },
  { raw: "54%", countable: true, from: 0, to: 54, decimals: 0, prefix: "", suffix: "%", label: "Time away from patients", color: "#f59e0b" },
  { raw: "< 60s", countable: true, from: 100, to: 60, decimals: 0, prefix: "< ", suffix: "s", label: "Halo Note generation time", color: "#10b981" },
];

const VALUES = [
  { icon: Heart, color: "#f43f5e", title: "Clinician First", body: "Every decision starts with one question: does this make a physician's day better? Not the administrator's. Not the insurer's. The doctor's." },
  { icon: ShieldCheck, color: "#10b981", title: "Trust as Infrastructure", body: "Patient data is sacred. We treat HIPAA compliance not as a checkbox, but as a foundation. Every line of code is written with that weight in mind." },
  { icon: Brain, color: "#8b5cf6", title: "AI That Stays in Its Lane", body: "Halo Note augments clinical judgment, it does not replace it. The physician signs off on every note. The AI does the heavy lifting; the doctor stays in control." },
  { icon: Zap, color: "#f59e0b", title: "Speed Without Sacrifice", body: "We believe fast and accurate are not trade-offs. Halo Note generates notes in under 60 seconds without cutting corners on clinical depth or specialty nuance." },
];

const TEAM = [
  { name: "Abdullah Kanan", title: "Co-Founder & CEO", bio: "Building Halo Note to eliminate the documentation burden in healthcare, shaped by firsthand exposure to clinical workflows and a deep belief that technology should serve clinicians, not burden them.", initials: "AH", color: "#6366f1", photo: abdullahPhoto, bgSize: "110%", bgPosition: "center 12%" },
  { name: "Dr. Redwan Asbahi", title: "Co-Founder & Lead Clinical Advisor", bio: "Board-certified internal medicine physician with 10+ years of experience. Provides clinical guidance ensuring the platform aligns with real-world physician workflows, documentation standards, and patient care priorities.", initials: "RA", color: "#10b981", photo: asbahiPhoto, bgSize: "115%", bgPosition: "center 44%" },
];

const VISION_TAGS = [
  { label: "Ambient Scribing", color: "#6366f1", description: "Halo Note listens passively during patient encounters and generates a complete, structured clinical note, no buttons, no interruptions during the visit." },
  { label: "Medical Coding", color: "#10b981", description: "AI-assisted ICD-10 and CPT code suggestions pulled directly from the visit note, reducing coder workload and minimizing claim denials." },
  { label: "Pre-Charting", color: "#f59e0b", description: "Before the patient walks in, Halo Note surfaces relevant history, labs, and pending items so physicians walk in fully prepared." },
  { label: "Clinical Research", color: "#8b5cf6", description: "Instant access to evidence-based guidance and literature pulled in context with the patient's live presentation and history." },
  { label: "Patient Communication", color: "#f43f5e", description: "AI-drafted after-visit summaries and patient messages written in plain language, reviewed and sent by the physician." },
  { label: "Workflow Automation", color: "#06b6d4", description: "Referrals, orders, and follow-ups triggered automatically from the note, closing the loop without extra clicks or tab-switching." },
];
const AREAS = ["Engineering", "Product", "Clinical / Medicine", "Operations", "Design", "Other"];

/* ────────────────────────── interest form ───────────────────────── */
function InterestFormSection() {
  const [form, setForm] = useState({ name: "", email: "", linkedin: "", area: "", message: "" });
  const [sent, setSent] = useState(false);

  const mutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await apiRequest("POST", "/api/contact/interest", data);
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || "Something went wrong."); }
    },
    onSuccess: () => setSent(true),
  });

  const inputCls = "w-full rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3 text-[14px] text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-400 focus:bg-white transition-all duration-200";

  return (
    <section className="py-28 border-t border-gray-100 px-5 bg-white" data-testid="section-interest-form">
      <div className="max-w-2xl mx-auto">
        <Reveal>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-500 mb-3">Connect</p>
          <h2 className="text-[clamp(1.6rem,3vw,2.4rem)] font-black text-gray-950 tracking-tight leading-tight mb-4">Interested in building with us?</h2>
          <p className="text-[16px] text-gray-500 leading-relaxed mb-10 max-w-xl">Halo Note is still early, but we're always open to connecting with thoughtful people across engineering, product, and medicine who care about improving how healthcare works.</p>
        </Reveal>

        {sent ? (
          <Reveal>
            <div className="flex items-start gap-4 rounded-2xl border border-green-100 bg-green-50/50 p-8">
              <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[15px] font-semibold text-gray-900 mb-1">We got your message.</p>
                <p className="text-[14px] text-gray-500">We'll be in touch if there's a fit. Thanks for reaching out.</p>
              </div>
            </div>
          </Reveal>
        ) : (
          <Reveal delay={100}>
            <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }} className="space-y-4" data-testid="form-interest">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 mb-1.5 uppercase tracking-widest">Name</label>
                  <input name="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Your name" className={inputCls} data-testid="input-interest-name" />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 mb-1.5 uppercase tracking-widest">Email</label>
                  <input name="email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required placeholder="you@example.com" className={inputCls} data-testid="input-interest-email" />
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 mb-1.5 uppercase tracking-widest">LinkedIn or GitHub</label>
                  <input name="linkedin" value={form.linkedin} onChange={e => setForm(f => ({ ...f, linkedin: e.target.value }))} placeholder="linkedin.com/in/you" className={inputCls} data-testid="input-interest-linkedin" />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 mb-1.5 uppercase tracking-widest">Area of Interest</label>
                  <select name="area" value={form.area} onChange={e => setForm(f => ({ ...f, area: e.target.value }))} className={inputCls} data-testid="select-interest-area">
                    <option value="">Select one</option>
                    {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-gray-400 mb-1.5 uppercase tracking-widest">A few words about yourself</label>
                <textarea name="message" value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))} required placeholder="What draws you to this problem? What have you built or done that's relevant?" rows={5} className={inputCls + " resize-none"} data-testid="textarea-interest-message" />
              </div>
              {mutation.isError && <p className="text-[13px] text-red-500">{(mutation.error as Error).message}</p>}
              <div className="pt-1">
                <Button type="submit" disabled={mutation.isPending} className="h-11 px-8 rounded-full bg-gray-950 text-white hover:bg-gray-800 text-[14px] font-semibold transition-all duration-200 shadow-sm hover:shadow-lg hover:-translate-y-0.5" data-testid="button-interest-submit">
                  {mutation.isPending ? "Sending…" : "Send message"}
                </Button>
              </div>
            </form>
          </Reveal>
        )}
      </div>
    </section>
  );
}

/* ──────────────────────────── hero ──────────────────────────────── */
function HeroSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const [orbPos, setOrbPos] = useState({ x: 50, y: 50 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      setOrbPos({ x, y });
    };
    el.addEventListener("mousemove", handler);
    return () => el.removeEventListener("mousemove", handler);
  }, []);

  return (
    <section ref={containerRef} className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-gray-950 px-5" data-testid="section-about-hero">
      {/* cursor glow */}
      <div
        ref={orbRef}
        className="absolute pointer-events-none w-[600px] h-[600px] rounded-full transition-[left,top] duration-700 ease-out"
        style={{ left: `${orbPos.x}%`, top: `${orbPos.y}%`, transform: "translate(-50%,-50%)", background: "radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 70%)" }}
      />
      {/* static ambient orbs */}
      <div className="absolute bottom-0 right-1/4 w-[350px] h-[350px] rounded-full bg-violet-700/10 blur-[90px] pointer-events-none" />

      {/* grid */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.035]"
        style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.8) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.8) 1px,transparent 1px)", backgroundSize: "64px 64px" }} />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/20 bg-white/10 text-gray-200 text-[12px] font-semibold tracking-wide backdrop-blur-sm mb-8 marketing-page-enter" style={{ animationDelay: "0ms" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Our Mission
        </div>

        <h1 className="text-[clamp(2.8rem,6.5vw,5.5rem)] font-black text-white tracking-tight leading-[1.02] mb-6">
          <span className="block overflow-hidden pb-1">
            <WordRise text="Built by physicians," baseDelay={200} />
          </span>
          <span className="block overflow-hidden">
            <WordRise
              text="for physicians."
              baseDelay={320}
              className="bg-gradient-to-r from-indigo-400 via-violet-300 to-indigo-400 bg-clip-text text-transparent"
            />
          </span>
        </h1>

        <div className="word-rise" style={{ animationDelay: "900ms" }}>
          <p className="text-[18px] text-gray-300 leading-relaxed max-w-xl mx-auto">
            Halo Note exists for one reason: to give doctors their time back, through AI that understands the full lifecycle of a clinical encounter.
          </p>
        </div>
      </div>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 animate-bounce text-white/25">
        <ChevronDown className="w-5 h-5" />
      </div>
    </section>
  );
}

/* ─────────────────────────── page ───────────────────────────────── */
export default function AboutPage() {
  return (
    <MarketingLayout>
      <SEOMeta
        title="About Halo Note, Built by Physicians, for Physicians"
        description="Halo Note was founded to end the documentation crisis in medicine. Learn about our mission, values, and the team building the future of clinical AI."
      />

      <HeroSection />

      {/* ── STATS ──────────────────────────────────── */}
      <section className="py-20 bg-white border-b border-gray-100 px-5" data-testid="section-stats">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
            {STATS.map((s, i) => <StatCard key={s.raw} stat={s} delay={i * 90} />)}
          </div>
        </div>
      </section>

      {/* ── STORY ──────────────────────────────────── */}
      <section className="py-28 border-b border-gray-100 px-5 bg-white" data-testid="section-story">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-16 items-center">
          <Reveal>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-500 mb-4">The Problem We're Solving</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.5rem)] font-black text-gray-950 tracking-tight leading-tight mb-5">
              The documentation burden is breaking medicine.
            </h2>
            <p className="text-[15px] text-gray-500 leading-relaxed mb-4">
              Physicians spend an average of 15.5 hours per week on administrative tasks. More than a third report symptoms of burnout. Many leave the profession early.
            </p>
            <p className="text-[15px] text-gray-500 leading-relaxed">
              We started Halo Note because we believed this didn't have to be the case. The technology to fix it already exists, it just hadn't been built for clinicians with the depth and trust they deserve.
            </p>
          </Reveal>
          <Reveal delay={150}>
            <BarViz />
          </Reveal>
        </div>
      </section>

      {/* ── VALUES ─────────────────────────────────── */}
      <section className="py-28 bg-gray-950 px-5" data-testid="section-values">
        <div className="max-w-4xl mx-auto">
          <Reveal className="text-center mb-16">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-400 mb-3">What We Believe</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.5rem)] font-black text-white tracking-tight">The principles behind every decision.</h2>
          </Reveal>
          <div className="grid sm:grid-cols-2 gap-4">
            {VALUES.map((v, i) => {
              const Icon = v.icon;
              return (
                <Reveal key={v.title} delay={i * 70}>
                  <SpotlightCard color={v.color}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-5 transition-transform duration-300 hover:scale-110" style={{ background: `${v.color}22` }}>
                      <Icon className="w-5 h-5" style={{ color: v.color }} />
                    </div>
                    <p className="text-[17px] font-bold text-white mb-2">{v.title}</p>
                    <p className="text-[14px] text-gray-300 leading-relaxed">{v.body}</p>
                  </SpotlightCard>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── TEAM ───────────────────────────────────── */}
      <section className="py-28 bg-white border-b border-gray-100 px-5" data-testid="section-team">
        <div className="max-w-3xl mx-auto">
          <Reveal className="text-center mb-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-500 mb-3">The Team</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.5rem)] font-black text-gray-950 tracking-tight mb-3">Founders who have lived this problem.</h2>
            <p className="text-[16px] text-gray-500 max-w-lg mx-auto leading-relaxed">Hover a card to learn more about each team member.</p>
          </Reveal>
          <div className="grid sm:grid-cols-2 gap-6 mt-12">
            {TEAM.map((member, i) => (
              <Reveal key={member.name} delay={i * 100}>
                <TeamFlipCard member={member} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── VISION ─────────────────────────────────── */}
      <section className="py-28 bg-gray-950 px-5" data-testid="section-vision">
        <div className="relative max-w-3xl mx-auto text-center">
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[400px] rounded-full bg-indigo-700/15 blur-[80px]" />
          </div>
          <Reveal className="relative z-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-indigo-400 mb-3">The Vision</p>
            <h2 className="text-[clamp(1.6rem,3.5vw,2.5rem)] font-black text-white tracking-tight leading-tight mb-5">
              An AI team for every physician in America.
            </h2>
            <p className="text-[16px] text-gray-300 leading-relaxed max-w-xl mx-auto mb-8">
              Today, Halo Note handles documentation. But our vision is broader, a suite of specialized AI agents covering the full clinical workflow.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {VISION_TAGS.map((tag, i) => (
                <VisionTag key={tag.label} tag={tag} index={i} />
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <InterestFormSection />

      {/* ── CTA ────────────────────────────────────── */}
      <section className="py-28 bg-gray-950 border-t border-white/8 text-center px-5 relative overflow-hidden" data-testid="section-about-cta">
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] rounded-full bg-indigo-700/15 blur-[80px] pointer-events-none" />
        <Reveal className="relative z-10 max-w-xl mx-auto">
          <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-black text-white tracking-tight leading-tight mb-4">
            Join the founding cohort.
          </h2>
          <p className="text-[16px] text-gray-300 leading-relaxed mb-8">
            We're onboarding a small group of founding physicians. Early access, early pricing, and a direct line to the team.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/pricing">
              <Button size="lg" className="h-12 px-9 rounded-full bg-white text-gray-950 hover:bg-gray-100 font-semibold text-[14px] group transition-all duration-200 shadow-lg hover:shadow-2xl hover:-translate-y-0.5" data-testid="button-about-see-pricing">
                See Pricing
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform duration-200" />
              </Button>
            </Link>
            <Link href="/request-access">
              <Button size="lg" variant="outline" className="h-12 px-9 rounded-full border-white/15 bg-transparent text-white hover:bg-white/10 hover:border-white/30 font-semibold text-[14px] transition-all duration-200" data-testid="button-about-request-access">
                Request Access
              </Button>
            </Link>
          </div>
        </Reveal>
      </section>
    </MarketingLayout>
  );
}

/* ── animated bar visualization ─────────────────────────────────── */
function BarViz() {
  const { ref, visible } = useInView(0.3);
  const bars = [
    { label: "Hours spent documenting per week", pct: 78, color: "#6366f1" },
    { label: "Physicians experiencing burnout", pct: 33, color: "#f43f5e" },
    { label: "Clinical time lost to admin", pct: 54, color: "#f59e0b" },
    { label: "Notes done by Halo Note in < 60s", pct: 96, color: "#10b981" },
  ];
  return (
    <div ref={ref} className="rounded-3xl border border-gray-100 bg-gradient-to-br from-gray-50 to-white p-8 space-y-5 shadow-sm">
      {bars.map((bar, i) => (
        <div key={bar.label}>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[12px] text-gray-500 font-medium">{bar.label}</span>
            <span className="text-[12px] font-bold" style={{ color: bar.color }}>{bar.pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000 ease-out"
              style={{ width: visible ? `${bar.pct}%` : "0%", background: bar.color, transitionDelay: `${i * 150}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
