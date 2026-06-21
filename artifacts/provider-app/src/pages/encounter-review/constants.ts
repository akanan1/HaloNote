// Display-string + tone-class maps for the encounter-review page and
// its panels. These are reach-and-grab tables, not business logic —
// keep them flat and stringly-typed so an i18n pass can swap labels
// without touching panel code.
//
// VISIT_LABEL and STATUS_TONE are duplicated in Today.tsx today. A
// future cleanup should move these into a shared location (e.g.
// `@workspace/api-zod/labels`) and import from both pages.

import type {
  ApprovedOrderStatus,
  CodeSystem,
  CodingSectionKey,
  CodingSessionStatus,
  Confidence,
  EncounterStatus,
  NoteStatus,
  OrderPriority,
  OrderType,
  ProblemStatus,
  ProblemSuggestionAction,
  SummaryLanguage,
  TaskCategory,
  VisitType,
  VitalConfidence,
} from "./types";

// Native-script labels so the picker reads correctly to a multilingual
// front-desk staffer or patient peeking over the provider's shoulder.
// English in parens for the provider's clarity.
export const LANGUAGE_OPTIONS: { value: SummaryLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español (Spanish)" },
  { value: "zh", label: "中文 (Chinese)" },
  { value: "vi", label: "Tiếng Việt (Vietnamese)" },
  { value: "ko", label: "한국어 (Korean)" },
  { value: "tl", label: "Tagalog (Filipino)" },
  { value: "ru", label: "Русский (Russian)" },
];

export const VISIT_LABEL: Record<VisitType, string> = {
  new_patient: "New patient",
  established_patient: "Established patient",
  follow_up: "Follow-up",
  annual_physical: "Annual physical",
  hospital_follow_up: "Hospital follow-up",
  procedure: "Procedure",
  telehealth: "Telehealth",
  nursing_facility: "Nursing facility",
  custom: "Custom",
};

export const STATUS_TONE: Record<EncounterStatus, string> = {
  scheduled: "ring-sky-200 bg-sky-50 text-sky-900",
  in_progress: "ring-violet-200 bg-violet-50 text-violet-900",
  completed: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  cancelled:
    "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
};

export const NOTE_STATUS_LABEL: Record<NoteStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  exported: "Exported to EHR",
  "entered-in-error": "Withdrawn",
  active: "Active",
};

export const NOTE_STATUS_TONE: Record<NoteStatus, string> = {
  draft: "ring-amber-200 bg-amber-50 text-amber-900",
  approved: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  exported: "ring-blue-200 bg-blue-50 text-blue-900",
  "entered-in-error":
    "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
  active: "ring-(--color-border) bg-(--color-muted) text-(--color-foreground)",
};

export const CODE_SYSTEM_LABEL: Record<CodeSystem, string> = {
  em: "E&M level",
  cpt: "CPT",
  icd10: "ICD-10",
  modifier: "Modifier",
};

// Ordered: providers scan from "what level" → "what diagnoses" → procedures → modifiers.
export const CODE_SYSTEM_ORDER: CodeSystem[] = ["em", "icd10", "cpt", "modifier"];

export const CONFIDENCE_TONE: Record<Confidence, string> = {
  low: "text-red-700",
  medium: "text-amber-700",
  high: "text-emerald-700",
};

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  lab: "Lab",
  imaging: "Imaging",
  referral: "Referral",
  medication: "Medication",
  procedure: "Procedure",
  followup: "Follow-up",
  instruction: "Patient instruction",
  dme: "DME",
  therapy: "Therapy",
  nursing: "Nursing",
};

export const ORDER_PRIORITY_TONE: Record<OrderPriority, string> = {
  routine:
    "ring-(--color-border) bg-(--color-card) text-(--color-muted-foreground)",
  urgent: "ring-amber-200 bg-amber-50 text-amber-900",
  stat: "ring-red-200 bg-red-50 text-red-900",
};

export const APPROVED_ORDER_STATUS_LABEL: Record<ApprovedOrderStatus, string> =
  {
    approved: "Approved",
    export_ready: "Export ready",
    exported: "Exported",
    cancelled: "Cancelled",
  };

export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  call_patient: "Call patient",
  schedule_followup: "Schedule follow-up",
  send_referral: "Send referral",
  prior_auth: "Prior authorization",
  obtain_records: "Obtain records",
  repeat_labs: "Repeat labs",
  nursing_instruction: "Nursing instruction",
  billing_followup: "Billing follow-up",
  patient_instruction: "Patient instruction",
  other: "Other",
};

export const CONFIDENCE_DOT: Record<VitalConfidence, string> = {
  low: "bg-red-500",
  medium: "bg-amber-500",
  high: "bg-emerald-500",
};

// ---- Coder (Phase 1B) ------------------------------------------------------

export const CODING_SECTION_LABEL: Record<CodingSectionKey, string> = {
  assessment: "Assessment",
  plan: "Plan",
  hpi: "HPI",
  ros: "ROS",
  physical_exam: "Physical Exam",
  procedures: "Procedures",
  orders: "Orders",
  mdm: "MDM",
  time: "Time",
  other: "Other",
};

export const CODING_SESSION_STATUS_LABEL: Record<CodingSessionStatus, string> =
  {
    queued: "Queued",
    extracting: "Extracting codes…",
    ready: "Awaiting review",
    approved: "Provider approved",
    writing: "Writing to EHR…",
    complete: "Sent to EHR",
    failed: "Failed",
  };

export const CODING_SESSION_STATUS_TONE: Record<CodingSessionStatus, string> = {
  queued: "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
  extracting: "ring-violet-200 bg-violet-50 text-violet-900",
  ready: "ring-amber-200 bg-amber-50 text-amber-900",
  approved: "ring-sky-200 bg-sky-50 text-sky-900",
  writing: "ring-violet-200 bg-violet-50 text-violet-900",
  complete: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  failed: "ring-red-200 bg-red-50 text-red-900",
};

export const PROBLEM_STATUS_LABEL: Record<ProblemStatus, string> = {
  active: "Active",
  stable: "Stable",
  worsening: "Worsening",
  improving: "Improving",
  resolved: "Resolved",
};

export const PROBLEM_STATUS_TONE: Record<ProblemStatus, string> = {
  active: "ring-sky-200 bg-sky-50 text-sky-900",
  stable: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  worsening: "ring-red-200 bg-red-50 text-red-900",
  improving: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  resolved: "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
};

export const PROBLEM_ACTION_LABEL: Record<ProblemSuggestionAction, string> = {
  add: "Add to problem list",
  update_status: "Update status",
  resolve: "Mark resolved",
  merge_duplicate: "Merge duplicate",
  flag_uncertain: "Flag for review",
};

export const PROBLEM_ACTION_TONE: Record<ProblemSuggestionAction, string> = {
  add: "ring-sky-200 bg-sky-50 text-sky-900",
  update_status: "ring-violet-200 bg-violet-50 text-violet-900",
  resolve: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  merge_duplicate: "ring-amber-200 bg-amber-50 text-amber-900",
  flag_uncertain: "ring-amber-200 bg-amber-50 text-amber-900",
};
