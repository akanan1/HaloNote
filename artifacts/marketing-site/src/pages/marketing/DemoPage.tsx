import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import MarketingLayout from "@/components/marketing/MarketingLayout";
import { SEOMeta } from "@/components/SEOMeta";
import {
  Mic, MicOff, Sparkles, CheckCircle2, ArrowRight, FileText,
  Heart, Brain, Stethoscope, Clock, Activity, RotateCcw,
  ChevronRight, Shield, LayoutDashboard, Calendar, Users,
  BarChart3, Network, Edit, Send, Download,
  ClipboardCheck, Tag, Star, RefreshCw, Check, Loader2,
  X, AlertCircle, ChevronDown, ChevronUp, Pencil, Save
} from "lucide-react";
import { HaloNoteLogoIcon } from "@/components/HaloNoteLogo";

/* ── Scenarios ─────────────────────────────────────────────────── */
const SCENARIOS = [
  {
    id: "primary-care",
    specialty: "Primary Care",
    noteType: "SOAP Note",
    icon: Stethoscope,
    color: "#2563eb",
    accentLight: "#eff6ff",
    border: "#bfdbfe",
    patient: "James Okafor",
    patientMeta: "58M · MRN-4821",
    chief: "HTN follow-up + fatigue",
    duration: "12 min encounter",
    date: "Apr 18, 2026",
    transcript: [
      "Good morning Mr. Okafor. How have you been feeling since your last visit?",
      "I've been okay, doctor. Still a bit tired, especially in the afternoons. Blood pressure cuff at home shows around 138 over 86 most days.",
      "Any chest pain, shortness of breath, palpitations?",
      "No chest pain. I do get a little winded going up two flights of stairs but that's been my baseline.",
      "Any changes to your medications? Still taking lisinopril 10mg and atorvastatin 40mg?",
      "Yes, taking them every morning with breakfast. No side effects.",
      "Good. Your LDL came back at 82, TSH 3.2, BMP normal. Blood pressure today is 136 over 84.",
      "Exam: alert and oriented, no acute distress. Cardiovascular, RRR, no murmurs. Lungs clear. No edema. Weight 184 lbs, up 2 lbs.",
    ],
    note: {
      subjective: "James Okafor is a 58-year-old male presenting for hypertension follow-up and fatigue. Reports persistent afternoon fatigue. Home BP averaging 138/86 mmHg. Denies chest pain but notes mild exertional dyspnea on 2-flight stair climb, consistent with baseline. No medication side effects. Adherent to lisinopril 10 mg and atorvastatin 40 mg daily.",
      objective: "BP: 136/84 mmHg · HR: 74 bpm, regular · Wt: 184 lbs (+2 lbs) · BMI: 27.4\n\nGeneral: A&Ox3, no acute distress. CV: RRR, no murmurs/rubs/gallops. Resp: CTA bilaterally. Extremities: No pitting edema.\n\nLabs: LDL 82 mg/dL ✓ · TSH 3.2 mIU/L ✓ · BMP WNL",
      assessment: "1. Essential hypertension, near goal, trending well on current regimen\n2. Hyperlipidemia, controlled (LDL 82 on statin therapy)\n3. Fatigue, thyroid WNL; consider anemia workup vs. sleep quality assessment\n4. Weight, +2 lbs this interval, dietary counseling indicated",
      plan: "• Continue lisinopril 10 mg and atorvastatin 40 mg daily\n• Order CBC → anemia evaluation given persistent fatigue\n• DASH diet + 30 min aerobic exercise 5×/wk counseling\n• Sleep hygiene review; sleep study if fatigue persists beyond 6 wks\n• Repeat BMP + fasting lipid panel in 3 months\n• Return in 3 months or if BP > 150/90 or symptoms worsen",
    },
    noteAlt: {
      subjective: "Mr. Okafor, 58M, returns for routine HTN follow-up. Chief complaint is ongoing afternoon fatigue. Home cuff readings 138/86 mmHg. Exertional dyspnea stable at 2-flight threshold, unchanged from prior visit. Medications well-tolerated; full adherence confirmed. No new complaints.",
      objective: "Vitals: BP 136/84, HR 74 (regular), Weight 184 lb, BMI 27.4.\n\nPhysical exam unremarkable: HEENT normal, CV RRR without murmur, lungs clear A&P, abdomen benign, extremities no edema.\n\nRelevant labs reviewed: LDL 82 (goal achieved), TSH 3.2 (euthyroid), comprehensive metabolic panel normal.",
      assessment: "HTN (I10): Blood pressure trending toward target, maintain current antihypertensive.\nDyslipidemia (E78.5): LDL at goal on atorvastatin 40 mg.\nFatigue (R53.83): Multifactorial; thyroid excluded. Evaluate for anemia. Sleep disorder to consider.\nOverweight (E66.09): Modest weight gain; lifestyle modification reinforced.",
      plan: "1. Continue current antihypertensives, no dose adjustment today\n2. CBC ordered today to rule out anemia\n3. Lifestyle: DASH diet education provided, aerobic exercise prescription 150 min/week\n4. Sleep diary for 4 weeks; referral to sleep medicine if no improvement\n5. Lab follow-up: BMP and lipid panel at 3-month visit\n6. RTC 3 months; sooner PRN for BP > 150/90 or worsening fatigue",
    },
    icd: [
      { code: "I10", label: "Essential Hypertension", selected: true },
      { code: "E78.5", label: "Hyperlipidemia, unspecified", selected: true },
      { code: "R53.83", label: "Other fatigue", selected: true },
    ],
    cpt: [
      { code: "99214", label: "Office Visit E/M Level 4" },
      { code: "93000", label: "EKG interpretation" },
    ],
    quality: 91,
    qualityBreakdown: [
      { label: "HPI Completeness", score: 23, max: 25 },
      { label: "Physical Exam Detail", score: 22, max: 25 },
      { label: "Assessment Logic", score: 23, max: 25 },
      { label: "Plan Specificity", score: 23, max: 25 },
    ],
    emLevel: "99214",
  },
  {
    id: "cardiology",
    specialty: "Cardiology",
    noteType: "Cardiology Consult",
    icon: Heart,
    color: "#dc2626",
    accentLight: "#fef2f2",
    border: "#fecaca",
    patient: "Patricia Chen",
    patientMeta: "67F · MRN-2934",
    chief: "Chest tightness + palpitations",
    duration: "18 min encounter",
    date: "Apr 18, 2026",
    transcript: [
      "Mrs. Chen, tell me about what brought you in today.",
      "I've been having this tightness in my chest. Comes on when I walk fast or climb stairs. Lasts 2–3 minutes then goes away with rest. Also fluttering sensations at night.",
      "How long has this been happening?",
      "About six weeks. Getting more frequent, used to be once or twice a week, now almost every day.",
      "Any shortness of breath, diaphoresis, radiation to arm or jaw?",
      "Sometimes a little short of breath with the tightness. No radiation.",
      "Family history of heart disease?",
      "Father had a heart attack at 62. Brother had bypass at 55.",
      "Exam: BP 148/90, HR 88 irregular. S1/S2 present, no S3 or S4. Mild bilateral ankle swelling. EKG shows afib with RVR.",
    ],
    note: {
      subjective: "Patricia Chen is a 67-year-old female with significant family CAD history presenting with 6-week progressive exertional chest tightness and nocturnal palpitations. Tightness is exertional, resolves with rest, associated with mild dyspnea. No radiation or diaphoresis. Father MI at 62, brother CABG at 55.",
      objective: "BP: 148/90 mmHg · HR: 88 bpm, irregular · SpO2: 97% RA\n\nCV: Irregular rate and rhythm · S1/S2 present · No murmurs, S3, or S4 · 1+ bilateral pitting ankle edema\n\nEKG: Atrial fibrillation with RVR · No acute ST changes",
      assessment: "1. New-onset atrial fibrillation with RVR, rate control + anticoagulation warranted\n2. Exertional chest tightness, high pre-test probability CAD (age/sex/FHx/symptoms)\n3. Hypertension, uncontrolled today (148/90 mmHg)\n4. Bilateral lower extremity edema, early HF vs. venous stasis",
      plan: "• Metoprolol succinate 25 mg daily, rate control AF\n• Apixaban 5 mg BID, CHA₂DS₂-VASc = 4\n• STAT troponin, BNP, CBC, CMP, TSH, lipid panel\n• Stress echocardiogram within 48–72 hrs\n• EP referral, AF management and ablation discussion\n• Echo, LV function + structural assessment\n• ED criteria: CP, worsening dyspnea, syncope",
    },
    noteAlt: {
      subjective: "Mrs. Chen, 67F, presents for new-onset exertional chest tightness × 6 weeks. Symptoms occur with moderate exertion (fast walking, stair climbing), last 2–3 min, resolve with rest. Associated with mild dyspnea. No radiation, no diaphoresis. Palpitations described as fluttering, predominantly nocturnal. Strong family history: father MI 62, brother CABG 55.",
      objective: "Vitals: BP 148/90, HR 88 and irregular, SpO2 97% on room air.\n\nCV exam: Irregularly irregular rhythm; normal S1/S2; no additional heart sounds; no murmurs; 1+ pitting edema bilateral ankles.\n\n12-lead EKG: Atrial fibrillation with rapid ventricular response (~88 bpm). No ST-segment changes. No prior EKG for comparison.",
      assessment: "AF with RVR (I48.91): New diagnosis. Rate control initiated. Anticoagulation indicated by CHA₂DS₂-VASc.\nAngina/Chest pain (R07.9): Exertional pattern with risk factors, cannot exclude ACS or stable CAD without further workup.\nHTN (I10): BP 148/90 despite likely prior treatment.\nEdema (R60.0): Bilateral, early decompensated HF must be excluded.",
      plan: "Rate control: Metoprolol succinate 25 mg PO daily; uptitrate to HR < 80.\nAnticoagulation: Apixaban 5 mg BID started today (CHA₂DS₂-VASc 4).\nUrgent labs: Troponin x2, BNP, CBC, CMP, TSH, fasting lipids.\nImaging: Stress echo within 72 hrs; TTE for EF assessment.\nReferrals: Electrophysiology for AF management; consider catheterization pending stress results.\nReturn to ED: Recurrent angina, presyncope, or worsening edema.",
    },
    icd: [
      { code: "I48.91", label: "Atrial Fibrillation", selected: true },
      { code: "R07.9", label: "Chest Pain, unspecified", selected: true },
      { code: "I10", label: "Essential Hypertension", selected: true },
    ],
    cpt: [
      { code: "99245", label: "Office Consult Level 5" },
      { code: "93010", label: "EKG reading" },
    ],
    quality: 94,
    qualityBreakdown: [
      { label: "HPI Completeness", score: 24, max: 25 },
      { label: "Physical Exam Detail", score: 24, max: 25 },
      { label: "Assessment Logic", score: 23, max: 25 },
      { label: "Plan Specificity", score: 23, max: 25 },
    ],
    emLevel: "99245",
  },
  {
    id: "psychiatry",
    specialty: "Psychiatry",
    noteType: "DAP Note",
    icon: Brain,
    color: "#7c3aed",
    accentLight: "#f5f3ff",
    border: "#ddd6fe",
    patient: "Alex Rivera",
    patientMeta: "34 · MRN-7102",
    chief: "Mood instability + sleep issues",
    duration: "45 min session",
    date: "Apr 18, 2026",
    transcript: [
      "Tell me how things have been going since our last session.",
      "Honestly, pretty rough. I've been having these mood swings again, really energized for a couple days, then crash hard and can't get out of bed.",
      "How long do the elevated periods last?",
      "Maybe three or four days? I get really productive, barely sleep, lots of ideas. Then I just fall. The lows last longer, like a week or two.",
      "Any thoughts of self-harm or suicide during the low periods?",
      "I had passive ideation last week. No plan, no intent, but the thoughts were there. I felt scared by them.",
      "Thank you for telling me that. Are those thoughts there today?",
      "Not right now. I'm actually feeling okay today. But I'm scared about next time.",
      "Let's talk about sleep. During the elevated periods, how many hours are you sleeping?",
      "Three, maybe four hours. And I don't feel tired.",
    ],
    note: {
      subjective: "Alex Rivera (34, they/them) presents for follow-up reporting cyclic mood episodes: hypomanic periods (3–4 days) with elevated energy, decreased sleep need (3–4 hrs), racing thoughts, followed by depressive episodes (1–2 wks) with anhedonia and hypersomnia. Passive SI during most recent depressive episode (no plan, intent, or means). Denies current SI. No substance use or psychotic symptoms.",
      objective: "MSE: Well-groomed, cooperative, engaged. Speech: normal rate/rhythm. Mood: 'okay today.' Affect: euthymic, appropriate range. Thought process: linear, goal-directed. Thought content: no current SI/HI, no delusions, no AVH. Insight: good. Judgment: intact. Cognition: grossly intact.",
      assessment: "Bipolar II disorder (suspected), cyclic hypomanic and depressive episodes with functional impairment. Recent passive SI during depressive phase, ego-dystonic. Sleep-wake disturbance tracking with mood polarity. Low acute risk at this time, patient actively engaged in safety planning.",
      plan: "• Safety plan updated, 3 identified contacts + 988 crisis line if ideation returns\n• Initiate lamotrigine 25 mg daily (titrate per protocol)\n• Weekly therapy, mood charting and trigger identification\n• Daylio mood diary app (daily tracking)\n• Labs: CMP, CBC, TSH baseline prior to next titration\n• Psychoeducation, bipolar spectrum, adherence\n• Return 2 wks, lamotrigine tolerability; sooner if SI recurs",
    },
    noteAlt: {
      subjective: "Mr./Ms. Rivera, 34, returns for follow-up. Interval history significant for mood cycling: hypomania (3–4 day episodes, decreased sleep 3–4 hrs, increased energy, goal-directed activity) alternating with depression (7–14 day episodes, low mood, anhedonia, hypersomnia). Last depressive episode included passive suicidal ideation without plan or intent, patient self-reported as frightening and ego-dystonic. No active SI today. Denies substance use, psychotic symptoms.",
      objective: "Mental Status: Appearance appropriate; behavior cooperative; eye contact good. Speech: normal rate, rhythm, volume. Mood: 'okay today'; Affect: euthymic with full range; congruent. Thought Process: logical, linear, goal-directed; no loose associations. Thought Content: no suicidal or homicidal ideation at this time; no delusions; no perceptual disturbances. Insight: intact. Judgment: intact.",
      assessment: "Bipolar II Disorder (F31.81), Current episode: euthymic. Cycling pattern consistent with Bipolar II spectrum: hypomania (DSM-5 criteria B1–B7 met) alternating with major depressive episodes. Passive SI in depression, heightened risk monitoring warranted. Insomnia (G47.00): phase-shifted with mood cycling.",
      plan: "Safety: Plan reviewed and updated with patient; wallet card provided with 988 and three crisis contacts.\nPharmacotherapy: Lamotrigine 25 mg QD initiated; titration schedule provided in writing.\nPsychotherapy: Weekly CBT focusing on mood monitoring, sleep hygiene, cognitive restructuring.\nMonitoring: Daylio app for daily mood/sleep tracking; patient will email chart at next visit.\nLabs: CMP, CBC, TSH before next titration step.\nNext appointment: 2 weeks. Sooner if suicidal ideation returns or mood destabilizes.",
    },
    icd: [
      { code: "F31.81", label: "Bipolar II Disorder", selected: true },
      { code: "G47.00", label: "Insomnia, unspecified", selected: true },
      { code: "Z91.5", label: "Personal history of self-harm", selected: true },
    ],
    cpt: [
      { code: "90837", label: "Psychotherapy 60 min" },
      { code: "90833", label: "Pharmacologic mgmt add-on" },
    ],
    quality: 88,
    qualityBreakdown: [
      { label: "HPI Completeness", score: 22, max: 25 },
      { label: "MSE Documentation", score: 22, max: 25 },
      { label: "Assessment Logic", score: 22, max: 25 },
      { label: "Plan Specificity", score: 22, max: 25 },
    ],
    emLevel: "90837",
  },
];

const NAV_ITEMS = [
  { icon: LayoutDashboard, label: "Dashboard" },
  { icon: Mic, label: "Audio", active: true },
  { icon: FileText, label: "Notes" },
  { icon: Users, label: "Patients" },
  { icon: Calendar, label: "Schedule" },
  { icon: Network, label: "Agents" },
  { icon: BarChart3, label: "Analytics" },
];

type Phase = "idle" | "recording" | "transcribing" | "generating" | "done";
type EhrStatus = "idle" | "connecting" | "syncing" | "pushed";
type NoteStatus = "draft" | "signing" | "signed";

export default function DemoPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcriptLines, setTranscriptLines] = useState(0);
  const [noteSection, setNoteSection] = useState(0);
  const [showICD, setShowICD] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [recSecs, setRecSecs] = useState(0);

  // Interactivity states
  const [noteStatus, setNoteStatus] = useState<NoteStatus>("draft");
  const [ehrStatus, setEhrStatus] = useState<EhrStatus>("idle");
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [noteOverrides, setNoteOverrides] = useState<Record<string, string>>({});
  const [regenSection, setRegenSection] = useState<string | null>(null);
  const [icdStates, setIcdStates] = useState<Record<string, boolean>>({});
  const [qualityExpanded, setQualityExpanded] = useState(false);
  const [activeNavItem, setActiveNavItem] = useState("Audio");
  const [navToast, setNavToast] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scenario = SCENARIOS.find(s => s.id === selectedId);
  const sectionKeys = ["subjective", "objective", "assessment", "plan"] as const;
  const sectionLabels = ["Subjective", "Objective", "Assessment", "Plan"];
  const sectionColors = ["#2563eb", "#0891b2", "#dc2626", "#059669"];

  function resetDemo() {
    setPhase("idle");
    setTranscriptLines(0);
    setNoteSection(0);
    setShowICD(false);
    setShowQuality(false);
    setSelectedId(null);
    setRecSecs(0);
    setNoteStatus("draft");
    setEhrStatus("idle");
    setEditingSection(null);
    setEditDraft("");
    setNoteOverrides({});
    setRegenSection(null);
    setIcdStates({});
    setQualityExpanded(false);
    setActiveNavItem("Audio");
    if (timerRef.current) clearTimeout(timerRef.current);
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  }

  function startDemo(id: string) {
    resetDemo();
    setSelectedId(id);
    setPhase("recording");
  }

  // Recording timer
  useEffect(() => {
    if (phase === "recording") {
      setRecSecs(0);
      recTimerRef.current = setInterval(() => setRecSecs(s => s + 1), 1000);
      timerRef.current = setTimeout(() => {
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        setPhase("transcribing");
      }, 3200);
    }
    return () => { if (recTimerRef.current) clearInterval(recTimerRef.current); };
  }, [phase]);

  // Transcript streaming
  useEffect(() => {
    if (!scenario || phase !== "transcribing") return;
    const total = scenario.transcript.length;
    let count = 0;
    const tick = () => {
      count++;
      setTranscriptLines(count);
      if (count < total) {
        timerRef.current = setTimeout(tick, 450 + Math.random() * 330);
      } else {
        timerRef.current = setTimeout(() => setPhase("generating"), 700);
      }
    };
    timerRef.current = setTimeout(tick, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [phase, scenario]);

  // Note generation
  useEffect(() => {
    if (phase !== "generating") return;
    let s = 0;
    const tick = () => {
      s++;
      setNoteSection(s);
      if (s < 4) {
        timerRef.current = setTimeout(tick, 700);
      } else {
        timerRef.current = setTimeout(() => setShowICD(true), 500);
        timerRef.current = setTimeout(() => { setShowQuality(true); setPhase("done"); }, 1100);
      }
    };
    timerRef.current = setTimeout(tick, 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [phase]);

  // Sign note handler
  function handleSign() {
    if (noteStatus !== "draft") return;
    setNoteStatus("signing");
    setTimeout(() => setNoteStatus("signed"), 1600);
  }

  // Push to EHR handler
  function handlePushEHR() {
    if (ehrStatus !== "idle") return;
    setEhrStatus("connecting");
    setTimeout(() => setEhrStatus("syncing"), 1000);
    setTimeout(() => setEhrStatus("pushed"), 2200);
  }

  // Regenerate a section
  function handleRegen(key: string) {
    if (regenSection) return;
    setRegenSection(key);
    setTimeout(() => {
      if (scenario) {
        const alt = (scenario.noteAlt as Record<string, string>)[key];
        setNoteOverrides(prev => ({ ...prev, [key]: alt }));
      }
      setRegenSection(null);
    }, 1300);
  }

  // Edit section
  function startEdit(key: string) {
    const current = noteOverrides[key] ?? (scenario?.note as Record<string, string>)[key] ?? "";
    setEditDraft(current);
    setEditingSection(key);
  }

  function saveEdit() {
    if (!editingSection) return;
    setNoteOverrides(prev => ({ ...prev, [editingSection]: editDraft }));
    setEditingSection(null);
  }

  // ICD toggle
  function toggleICD(code: string) {
    setIcdStates(prev => ({ ...prev, [code]: !(prev[code] ?? true) }));
  }

  // Nav click toast
  function handleNavClick(label: string) {
    if (label === "Audio") { setActiveNavItem(label); return; }
    setActiveNavItem(label);
    setNavToast(label);
    setTimeout(() => setNavToast(null), 2200);
  }

  const recStr = [Math.floor(recSecs / 60), recSecs % 60].map(n => n.toString().padStart(2, "0")).join(":");

  const selectedICDCount = scenario
    ? scenario.icd.filter(c => icdStates[c.code] !== false).length
    : 0;

  return (
    <MarketingLayout>
      <SEOMeta
        title="Live Sandbox Demo, Halo Note"
        description="Experience Halo Note's AI clinical documentation live. Pick a specialty, watch the ambient recording, and see a structured note generated in under 90 seconds."
      />

      {/* Hero */}
      <section className="relative bg-gray-950 pt-28 pb-12 md:pt-36 md:pb-14 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: "radial-gradient(ellipse 900px 500px at 50% 0%, rgba(59,130,246,0.11) 0%, transparent 70%)"
        }} />
        <div className="relative max-w-3xl mx-auto px-5 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-blue-500/25 bg-blue-500/10 text-blue-300 text-[12px] font-semibold tracking-wide uppercase mb-5">
            <Activity className="w-3.5 h-3.5" />
            Interactive Sandbox Demo
          </div>
          <h1 className="text-3xl md:text-[2.8rem] font-black text-white tracking-tight leading-[1.06] mb-4">
            See the full app, not a slideshow.
          </h1>
          <p className="text-gray-400 text-[16px] max-w-xl mx-auto leading-relaxed mb-3">
            Pick a clinical specialty. Watch the AI generate a note inside the real interface. Then edit, regenerate, sign, and push to EHR, all live.
          </p>
          <div className="flex items-center justify-center gap-2 text-[12px] text-gray-500">
            <Shield className="w-3.5 h-3.5 text-emerald-500" />
            All demo data is fictional. No PHI collected or stored.
          </div>
        </div>
      </section>

      {/* Demo workspace */}
      <section className="bg-gray-100 py-8 md:py-10">
        <div className="max-w-7xl mx-auto px-4">

          {/* Scenario selector */}
          {phase === "idle" && (
            <div>
              <p className="text-center text-[12px] font-bold uppercase tracking-widest text-gray-400 mb-5">Choose a clinical scenario to begin</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                {SCENARIOS.map(s => (
                  <button
                    key={s.id}
                    onClick={() => startDemo(s.id)}
                    className="group text-left p-6 rounded-2xl border-2 bg-white hover:shadow-xl transition-all duration-300 hover:-translate-y-1"
                    style={{ borderColor: s.border }}
                    data-testid={`scenario-${s.id}`}
                  >
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: s.accentLight }}>
                        <s.icon className="w-5 h-5" style={{ color: s.color }} />
                      </div>
                      <div>
                        <div className="text-[14px] font-bold text-gray-900">{s.specialty}</div>
                        <div className="text-[11px] text-gray-400">{s.duration}</div>
                      </div>
                    </div>
                    <div className="space-y-1 mb-4">
                      <div className="text-[13px] font-semibold text-gray-800">{s.patient}</div>
                      <div className="text-[12px] text-gray-500">CC: {s.chief}</div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold group-hover:gap-2 transition-all" style={{ color: s.color }}>
                      <Mic className="w-3.5 h-3.5" />
                      Start encounter
                      <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* APP CHROME */}
          {phase !== "idle" && scenario && (
            <div className="rounded-2xl overflow-hidden border border-gray-300 shadow-2xl" style={{ height: "76vh", minHeight: 560 }}>

              {/* Window chrome bar */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-200 border-b border-gray-300 flex-shrink-0">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-yellow-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
                <div className="flex-1 mx-4 bg-gray-300/80 rounded-md py-1 px-3 text-[11px] text-gray-500 font-mono text-center truncate">
                  app.halonote.app / audio / new-encounter
                </div>
                <div className="text-[11px] text-gray-400 flex items-center gap-1.5 flex-shrink-0">
                  <Shield className="w-3 h-3 text-emerald-500" />
                  HIPAA encrypted
                </div>
              </div>

              <div className="flex h-full" style={{ height: "calc(76vh - 44px)" }}>

                {/* SIDEBAR */}
                <aside className="w-[196px] flex-shrink-0 bg-gray-950 flex-col border-r border-white/[0.06] hidden md:flex relative">
                  <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2.5">
                      <HaloNoteLogoIcon size={28} color="#2563eb" />
                      <div>
                        <div className="text-[13px] font-bold text-white">Halo Note</div>
                        <div className="text-[9px] text-gray-500">Medical Scribe</div>
                      </div>
                    </div>
                  </div>

                  {phase === "recording" && (
                    <div className="mx-3 mt-3 px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                        </span>
                        <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Recording</span>
                        <span className="ml-auto text-[10px] font-mono text-red-400">{recStr}</span>
                      </div>
                      <div className="text-[10px] text-gray-600">{scenario.patient.split(",")[0]}</div>
                    </div>
                  )}

                  <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
                    {NAV_ITEMS.map(item => (
                      <button
                        key={item.label}
                        onClick={() => handleNavClick(item.label)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors text-left ${
                          activeNavItem === item.label
                            ? "bg-blue-600/20 text-blue-300 border border-blue-500/20"
                            : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
                        }`}
                        data-testid={`nav-${item.label.toLowerCase()}`}
                      >
                        <item.icon className="w-3.5 h-3.5 flex-shrink-0" />
                        {item.label}
                        {item.label === "Audio" && phase === "recording" && (
                          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                        )}
                      </button>
                    ))}
                  </nav>

                  {/* Nav toast */}
                  {navToast && (
                    <div className="absolute bottom-16 left-2 right-2 bg-gray-800 border border-white/10 rounded-xl px-3 py-2.5 text-[11px] text-gray-300 z-10 shadow-xl">
                      <div className="font-semibold text-white mb-0.5">{navToast}</div>
                      <div className="text-gray-500">Available in the full app →</div>
                    </div>
                  )}

                  <div className="px-3 py-3 border-t border-white/[0.06]">
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.04]">
                      <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">DR</div>
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-gray-300 truncate">Dr. Rashid</div>
                        <div className="text-[9px] text-gray-600">{scenario.specialty}</div>
                      </div>
                    </div>
                  </div>
                </aside>

                {/* MAIN AREA */}
                <div className="flex-1 flex flex-col bg-white min-w-0">

                  {/* Patient header */}
                  <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 bg-gray-50/80 flex-shrink-0 flex-wrap gap-y-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-bold text-gray-900">{scenario.patient}</span>
                        <span className="text-[11px] text-gray-400">{scenario.patientMeta}</span>
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[11px] font-medium">{scenario.noteType}</span>
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold" style={{ background: scenario.accentLight, color: scenario.color }}>
                          {scenario.specialty}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5">CC: {scenario.chief} · {scenario.date}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all ${
                          noteStatus === "signed"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : noteStatus === "signing"
                            ? "bg-blue-50 text-blue-600 border-blue-200"
                            : phase === "done"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-gray-100 text-gray-500 border-gray-200"
                        }`}
                        data-testid="status-badge"
                      >
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          noteStatus === "signed" ? "bg-emerald-500"
                          : noteStatus === "signing" ? "bg-blue-500 animate-pulse"
                          : phase === "done" ? "bg-amber-500"
                          : "bg-gray-400"
                        }`} />
                        {noteStatus === "signed" ? "Signed & Finalized"
                          : noteStatus === "signing" ? "Signing…"
                          : phase === "done" ? "Draft, Ready to Review"
                          : "Generating…"}
                      </div>
                      {showQuality && (
                        <button
                          onClick={() => setQualityExpanded(v => !v)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold border border-emerald-200 hover:bg-emerald-100 transition-colors"
                          data-testid="badge-quality"
                        >
                          <Star className="w-3 h-3" />
                          {scenario.quality}/100
                          {qualityExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Toolbar */}
                  {phase === "done" && (
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-white flex-shrink-0 flex-wrap">
                      {/* Sign Note */}
                      {noteStatus === "draft" && (
                        <Button
                          size="sm"
                          onClick={handleSign}
                          className="h-7 text-[12px] gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3"
                          data-testid="button-sign-note"
                        >
                          <ClipboardCheck className="w-3.5 h-3.5" />
                          Sign Note
                        </Button>
                      )}
                      {noteStatus === "signing" && (
                        <Button size="sm" disabled className="h-7 text-[12px] gap-1.5 bg-emerald-600 text-white rounded-lg px-3 opacity-80">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Signing…
                        </Button>
                      )}
                      {noteStatus === "signed" && (
                        <Button size="sm" disabled className="h-7 text-[12px] gap-1.5 bg-emerald-700 text-white rounded-lg px-3">
                          <Check className="w-3.5 h-3.5" />
                          Signed ✓
                        </Button>
                      )}

                      {/* Edit */}
                      {noteStatus !== "signed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => startEdit("subjective")}
                          className="h-7 text-[12px] gap-1.5 rounded-lg px-3"
                          data-testid="button-edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </Button>
                      )}

                      {/* Push to EHR */}
                      {ehrStatus === "idle" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handlePushEHR}
                          className="h-7 text-[12px] gap-1.5 rounded-lg px-3"
                          data-testid="button-push-ehr"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Push to EHR
                        </Button>
                      )}
                      {ehrStatus === "connecting" && (
                        <Button size="sm" variant="outline" disabled className="h-7 text-[12px] gap-1.5 rounded-lg px-3 text-blue-600">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Connecting to Epic…
                        </Button>
                      )}
                      {ehrStatus === "syncing" && (
                        <Button size="sm" variant="outline" disabled className="h-7 text-[12px] gap-1.5 rounded-lg px-3 text-blue-600">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Syncing note…
                        </Button>
                      )}
                      {ehrStatus === "pushed" && (
                        <Button size="sm" variant="outline" disabled className="h-7 text-[12px] gap-1.5 rounded-lg px-3 text-emerald-600 border-emerald-300 bg-emerald-50">
                          <Check className="w-3.5 h-3.5" />
                          Pushed to Epic ✓
                        </Button>
                      )}

                      <Button size="sm" variant="ghost" className="h-7 text-[12px] gap-1.5 rounded-lg px-3 text-gray-500">
                        <Download className="w-3.5 h-3.5" />
                        Export
                      </Button>

                      <div className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-400">
                        <Tag className="w-3.5 h-3.5" />
                        E/M: <span className="font-bold text-gray-700">{scenario.emLevel}</span>
                      </div>

                      <button onClick={resetDemo} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 transition-colors ml-1" data-testid="button-reset">
                        <RotateCcw className="w-3 h-3" />
                        Reset
                      </button>
                    </div>
                  )}

                  {/* Quality expanded panel */}
                  {qualityExpanded && showQuality && (
                    <div className="px-4 py-3 border-b border-gray-100 bg-emerald-50/60 flex-shrink-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] font-bold text-emerald-700 flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5" />
                          Quality Score Breakdown, {scenario.quality}/100
                        </div>
                        <button onClick={() => setQualityExpanded(false)} className="text-gray-400 hover:text-gray-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {scenario.qualityBreakdown.map(q => (
                          <div key={q.label}>
                            <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                              <span>{q.label}</span>
                              <span className="font-bold text-gray-700">{q.score}/{q.max}</span>
                            </div>
                            <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(q.score / q.max) * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Content */}
                  <div className="flex-1 flex overflow-hidden">

                    {/* Transcript panel */}
                    <div className="w-[42%] flex-shrink-0 border-r border-gray-100 flex flex-col overflow-hidden" data-testid="panel-transcript">
                      <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-shrink-0">
                        <div className="flex items-center gap-2">
                          {phase === "recording" ? (
                            <>
                              <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                              </span>
                              <span className="text-[12px] font-bold text-red-600">Recording</span>
                              <span className="text-[11px] font-mono text-red-400">{recStr}</span>
                            </>
                          ) : (
                            <>
                              <MicOff className="w-3.5 h-3.5 text-gray-400" />
                              <span className="text-[12px] font-semibold text-gray-600">Encounter Transcript</span>
                            </>
                          )}
                        </div>
                        {phase !== "recording" && (
                          <button onClick={resetDemo} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 transition-colors" data-testid="button-reset-transcript">
                            <RotateCcw className="w-3 h-3" />
                            Reset
                          </button>
                        )}
                      </div>

                      {phase === "recording" ? (
                        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 bg-white">
                          <AnimatedWaveform color={scenario.color} />
                          <div className="text-center space-y-1.5">
                            <div className="text-[13px] font-semibold text-gray-700">Ambient listening active</div>
                            <div className="text-[12px] text-gray-400">Speak naturally with your patient</div>
                            <div className="flex items-center justify-center gap-1.5 text-[11px] text-gray-400 mt-1">
                              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                              Audio clear · Good signal
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-white" data-testid="transcript-content">
                          {scenario.transcript.slice(0, transcriptLines).map((line, i) => (
                            <div key={i} className={`text-[12px] leading-relaxed ${i % 2 === 0 ? "pl-1" : "pr-1"}`}>
                              <div className={`px-3 py-2 rounded-xl ${i % 2 === 0
                                ? "bg-blue-50 text-gray-700 ml-3 rounded-tl-sm"
                                : "bg-gray-50 text-gray-600 mr-3 rounded-tr-sm"}`}>
                                <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-0.5">
                                  {i % 2 === 0 ? "DR. RASHID" : "PATIENT"}
                                </div>
                                {line}
                              </div>
                            </div>
                          ))}
                          {phase === "transcribing" && transcriptLines < scenario.transcript.length && (
                            <div className="px-3 py-2 ml-4">
                              <div className="flex gap-1">
                                {[0, 150, 300].map(d => (
                                  <span key={d} className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Note panel */}
                    <div className="flex-1 flex flex-col overflow-hidden bg-white" data-testid="panel-note">
                      <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center gap-2 flex-shrink-0">
                        <FileText className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-[12px] font-semibold text-gray-600">
                          {phase === "generating" || phase === "done" ? scenario.noteType : "Note, Awaiting Transcript"}
                        </span>
                        {phase === "generating" && (
                          <div className="flex items-center gap-1.5 ml-auto text-[11px] text-blue-600 animate-pulse">
                            <Sparkles className="w-3 h-3" />
                            Halo Scribe writing…
                          </div>
                        )}
                        {phase === "done" && noteStatus !== "signed" && (
                          <div className="ml-auto text-[10px] text-gray-400">Click ✏️ on any section to edit · ↻ to regenerate</div>
                        )}
                      </div>

                      {(phase === "generating" || phase === "done") ? (
                        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="note-content">
                          {sectionLabels.map((label, i) => {
                            const key = sectionKeys[i];
                            const text = noteOverrides[key] ?? (scenario.note as Record<string, string>)[key];
                            const isRegen = regenSection === key;
                            const isEditing = editingSection === key;
                            const visible = noteSection > i;
                            if (!visible) return null;

                            return (
                              <div key={label} className="group">
                                {/* Section header */}
                                <div className="flex items-center gap-2 mb-1.5">
                                  <div className="text-[9px] font-black uppercase tracking-widest" style={{ color: sectionColors[i] }}>
                                    {label}
                                  </div>
                                  <div className="flex-1 h-px bg-gray-100" />
                                  {/* Per-section actions */}
                                  {phase === "done" && noteStatus !== "signed" && !isEditing && (
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={() => handleRegen(key)}
                                        disabled={!!regenSection}
                                        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-blue-600 transition-colors px-2 py-0.5 rounded hover:bg-blue-50 disabled:opacity-40"
                                        data-testid={`regen-${key}`}
                                        title="Regenerate this section"
                                      >
                                        <RefreshCw className={`w-3 h-3 ${isRegen ? "animate-spin" : ""}`} />
                                        {isRegen ? "Rewriting…" : "Regenerate"}
                                      </button>
                                      <button
                                        onClick={() => startEdit(key)}
                                        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-700 transition-colors px-2 py-0.5 rounded hover:bg-gray-50"
                                        data-testid={`edit-${key}`}
                                        title="Edit this section"
                                      >
                                        <Pencil className="w-3 h-3" />
                                        Edit
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Section content */}
                                {isRegen ? (
                                  <div className="text-[12px] text-gray-400 italic flex items-center gap-2 animate-pulse py-2">
                                    <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                                    Halo Scribe rewriting {label.toLowerCase()}…
                                  </div>
                                ) : isEditing ? (
                                  <div>
                                    <textarea
                                      value={editDraft}
                                      onChange={e => setEditDraft(e.target.value)}
                                      className="w-full text-[12px] leading-relaxed text-gray-700 font-mono border border-blue-300 rounded-lg p-3 resize-none bg-blue-50/30 focus:outline-none focus:ring-2 focus:ring-blue-200"
                                      rows={6}
                                      data-testid={`textarea-${key}`}
                                    />
                                    <div className="flex gap-2 mt-1.5">
                                      <button
                                        onClick={saveEdit}
                                        className="flex items-center gap-1.5 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
                                        data-testid={`save-${key}`}
                                      >
                                        <Save className="w-3 h-3" />
                                        Save
                                      </button>
                                      <button
                                        onClick={() => setEditingSection(null)}
                                        className="text-[11px] text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                                        data-testid={`cancel-${key}`}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-[12px] leading-relaxed text-gray-600 whitespace-pre-line">
                                    {text}
                                    {noteOverrides[key] && (
                                      <span className="ml-2 inline-flex items-center gap-0.5 text-[9px] font-bold text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-full">
                                        <RefreshCw className="w-2.5 h-2.5" />edited
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {phase === "generating" && noteSection < 4 && (
                            <div className="flex items-center gap-2 text-[11px] text-gray-400 animate-pulse">
                              <div className="w-1 h-3 rounded-full bg-blue-400 animate-bounce" />
                            </div>
                          )}

                          {/* Coding */}
                          {showICD && (
                            <div className="mt-2 pt-3 border-t border-gray-100 space-y-3" data-testid="coding-section">
                              <div className="grid grid-cols-2 gap-3">
                                {/* ICD-10 */}
                                <div>
                                  <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1">
                                    <Tag className="w-2.5 h-2.5" /> ICD-10
                                    <span className="ml-auto text-gray-400 font-normal normal-case tracking-normal">
                                      {selectedICDCount}/{scenario.icd.length} active
                                    </span>
                                  </div>
                                  {scenario.icd.map((item) => {
                                    const active = icdStates[item.code] !== false;
                                    return (
                                      <button
                                        key={item.code}
                                        onClick={() => toggleICD(item.code)}
                                        className={`w-full flex items-center gap-1.5 mb-1.5 text-[11px] text-left px-2 py-1.5 rounded-lg transition-all ${
                                          active
                                            ? "bg-gray-50 hover:bg-gray-100"
                                            : "bg-red-50/50 opacity-60 hover:opacity-80"
                                        }`}
                                        data-testid={`icd-${item.code}`}
                                        title={active ? "Click to deselect from billing" : "Click to reactivate"}
                                      >
                                        {active
                                          ? <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                                          : <X className="w-3 h-3 text-red-400 flex-shrink-0" />
                                        }
                                        <span className={`font-bold text-gray-700 ${!active && "line-through"}`}>{item.code}</span>
                                        <span className={`text-gray-400 truncate ${!active && "line-through"}`}>{item.label}</span>
                                      </button>
                                    );
                                  })}
                                  {phase === "done" && (
                                    <div className="text-[9px] text-gray-400 mt-1 px-2">↑ Click codes to toggle billing inclusion</div>
                                  )}
                                </div>

                                {/* CPT */}
                                <div>
                                  <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-1">
                                    <Tag className="w-2.5 h-2.5" /> CPT
                                  </div>
                                  {scenario.cpt.map((item, i) => (
                                    <div key={i} className="flex items-center gap-1.5 mb-1.5 text-[11px] px-2 py-1.5 rounded-lg bg-gray-50">
                                      <CheckCircle2 className="w-3 h-3 text-blue-500 flex-shrink-0" />
                                      <span className="font-bold text-gray-700">{item.code}</span>
                                      <span className="text-gray-400 truncate">{item.label}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Quality bar (inline) */}
                          {showQuality && !qualityExpanded && (
                            <div
                              className="mt-1 p-3 rounded-xl border border-emerald-200 bg-emerald-50/60 cursor-pointer hover:bg-emerald-50 transition-colors"
                              onClick={() => setQualityExpanded(true)}
                              data-testid="quality-bar"
                            >
                              <div className="flex items-center justify-between mb-1.5">
                                <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
                                  <Activity className="w-3 h-3" />
                                  Note Quality Score
                                </div>
                                <div className="text-[14px] font-black text-emerald-700">
                                  {scenario.quality}<span className="text-[10px] text-emerald-500">/100</span>
                                </div>
                              </div>
                              <div className="w-full h-1.5 bg-emerald-100 rounded-full overflow-hidden">
                                <div className="h-full bg-emerald-500 rounded-full transition-all duration-1000" style={{ width: `${scenario.quality}%` }} />
                              </div>
                              <div className="text-[9px] text-emerald-600 mt-1">Click to see breakdown →</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
                          <div className="w-12 h-12 rounded-2xl bg-gray-50 flex items-center justify-center border border-gray-100">
                            <Clock className="w-6 h-6 text-gray-300" />
                          </div>
                          <p className="text-[13px] text-gray-400 max-w-[200px] leading-relaxed">
                            {phase === "recording"
                              ? "Note will be generated after the encounter ends"
                              : "Waiting for transcript to complete…"}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Done CTA */}
          {phase === "done" && scenario && (
            <div className="mt-5 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50 p-5 flex flex-col md:flex-row items-center gap-5 max-w-4xl mx-auto" data-testid="cta-after-demo">
              <div className="flex-1 text-center md:text-left">
                <div className="text-[11px] font-bold text-blue-600 uppercase tracking-wider mb-1">
                  {noteStatus === "signed" ? "Note signed and finalized" : ehrStatus === "pushed" ? "Note pushed to Epic" : "Your note is ready to sign"}
                </div>
                <h3 className="text-[16px] font-black text-gray-950 mb-1.5">This is your workflow, every encounter.</h3>
                <p className="text-[12px] text-gray-500 leading-relaxed">
                  Edit sections, regenerate prose, toggle billing codes, sign, and push to your EHR. All of it. No typing. No templates. No after-hours charting.
                </p>
              </div>
              <div className="flex flex-col gap-2 flex-shrink-0 min-w-[170px]">
                <Link href="/request-access">
                  <Button size="lg" className="rounded-full px-5 h-10 font-bold bg-blue-600 hover:bg-blue-700 text-white w-full text-[13px]" data-testid="button-request-access-demo">
                    Request Early Access <ArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
                <button onClick={resetDemo} className="text-[12px] text-gray-400 hover:text-gray-600 transition-colors text-center">
                  Try another specialty →
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Feature strip */}
      <section className="py-14 bg-white border-t border-gray-100">
        <div className="max-w-4xl mx-auto px-5">
          <p className="text-center text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-8">Everything you just used is the real product</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { icon: Mic, label: "Ambient recording", desc: "No push-to-talk. No dictation. Just speak." },
              { icon: Sparkles, label: "AI note generation", desc: "SOAP, H&P, DAP, BIRP, any format, any specialty" },
              { icon: RefreshCw, label: "Section regeneration", desc: "One click to rephrase any section of the note" },
              { icon: Activity, label: "Quality scoring", desc: "Live completeness grade before you sign" },
            ].map((item, i) => (
              <div key={i} className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center border border-gray-100">
                  <item.icon className="w-5 h-5 text-gray-500" />
                </div>
                <div className="text-[13px] font-semibold text-gray-800">{item.label}</div>
                <div className="text-[12px] text-gray-400 leading-snug">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}

/* ── Animated waveform ──────────────────────────────────────────── */
function AnimatedWaveform({ color }: { color: string }) {
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: 28 }, () => 20 + Math.random() * 60)
  );
  useEffect(() => {
    const id = setInterval(() => {
      setHeights(Array.from({ length: 28 }, () => 20 + Math.random() * 60));
    }, 180);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-[3px] h-14">
      {heights.map((h, i) => (
        <div key={i} className="w-1.5 rounded-full transition-all duration-150"
          style={{ height: `${h}%`, backgroundColor: color, opacity: 0.5 + (h / 100) * 0.5 }} />
      ))}
    </div>
  );
}
