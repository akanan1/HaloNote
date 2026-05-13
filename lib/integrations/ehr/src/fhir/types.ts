// Minimal subset of FHIR R4 resource types used by this package.
// Extend as additional resources / fields are needed — this is not a
// complete model of the spec.

export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Reference {
  reference?: string;
  display?: string;
}

export interface Identifier {
  system?: string;
  value?: string;
}

export interface Attachment {
  contentType?: string;
  language?: string;
  data?: string;
  url?: string;
  size?: number;
  hash?: string;
  title?: string;
  creation?: string;
}

export interface Resource {
  resourceType: string;
  id?: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    profile?: string[];
  };
}

// FHIR R4 IssueType valueset (http://hl7.org/fhir/ValueSet/issue-type).
// Narrowed to a union so callers can write exhaustive switches when
// surfacing actionable errors to clinicians. Falls back to `string` to
// stay forward-compatible with servers that return unrecognized codes.
export type IssueType =
  | "invalid"
  | "structure"
  | "required"
  | "value"
  | "invariant"
  | "security"
  | "login"
  | "unknown"
  | "expired"
  | "forbidden"
  | "suppressed"
  | "processing"
  | "not-supported"
  | "duplicate"
  | "multiple-matches"
  | "not-found"
  | "deleted"
  | "too-long"
  | "code-invalid"
  | "extension"
  | "too-costly"
  | "business-rule"
  | "conflict"
  | "transient"
  | "lock-error"
  | "no-store"
  | "exception"
  | "timeout"
  | "incomplete"
  | "throttled"
  | "informational"
  | (string & {});

export interface OperationOutcome extends Resource {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "fatal" | "error" | "warning" | "information";
    code: IssueType;
    diagnostics?: string;
    details?: CodeableConcept;
  }>;
}

// DocumentReference.relatesTo.code per the FHIR R4 valueset.
// "replaces" supersedes the target. "appends" extends without overwriting.
// "transforms" / "signs" cover format-conversion and digital-signature cases.
export type DocumentRelationshipType =
  | "replaces"
  | "transforms"
  | "signs"
  | "appends";

export interface DocumentReference extends Resource {
  resourceType: "DocumentReference";
  status: "current" | "superseded" | "entered-in-error";
  docStatus?: "preliminary" | "final" | "amended" | "entered-in-error";
  type?: CodeableConcept;
  category?: CodeableConcept[];
  subject?: Reference;
  date?: string;
  author?: Reference[];
  authenticator?: Reference;
  description?: string;
  content: Array<{
    attachment: Attachment;
    format?: Coding;
  }>;
  context?: {
    encounter?: Reference[];
    period?: { start?: string; end?: string };
    facilityType?: CodeableConcept;
    practiceSetting?: CodeableConcept;
  };
  relatesTo?: Array<{
    code: DocumentRelationshipType;
    target: Reference;
  }>;
}

// FHIR R4 HumanName (http://hl7.org/fhir/datatypes.html#HumanName). Only
// the fields the patient-sync mapper actually reads.
export interface HumanName {
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

export interface Patient extends Resource {
  resourceType: "Patient";
  active?: boolean;
  name?: HumanName[];
  /** ISO 8601 date (YYYY-MM-DD). */
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
  identifier?: Array<
    Identifier & {
      type?: CodeableConcept;
      use?: "usual" | "official" | "temp" | "secondary" | "old";
    }
  >;
}

// Period — used by Appointment, Encounter, etc. Both ends are ISO 8601
// timestamps; both optional per FHIR (start-only = "from then on").
export interface Period {
  start?: string;
  end?: string;
}

// FHIR R4 Appointment — minimal subset we actually read. Schedule
// queries pull these for "what's on this provider's calendar today".
export interface Appointment extends Resource {
  resourceType: "Appointment";
  status:
    | "proposed"
    | "pending"
    | "booked"
    | "arrived"
    | "fulfilled"
    | "cancelled"
    | "noshow"
    | "entered-in-error"
    | "checked-in"
    | "waitlist"
    | (string & {});
  /** ISO 8601 datetime. */
  start?: string;
  /** ISO 8601 datetime. */
  end?: string;
  description?: string;
  comment?: string;
  reasonCode?: CodeableConcept[];
  serviceType?: CodeableConcept[];
  participant: Array<{
    actor?: Reference;
    type?: CodeableConcept[];
    required?: "required" | "optional" | "information-only";
    status: "accepted" | "declined" | "tentative" | "needs-action";
  }>;
}

// FHIR R4 Condition — patient's diagnoses / problem list.
export interface Condition extends Resource {
  resourceType: "Condition";
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  onsetDateTime?: string;
  recordedDate?: string;
}

// FHIR R4 MedicationRequest — prescriptions / orders.
export interface MedicationRequest extends Resource {
  resourceType: "MedicationRequest";
  status?:
    | "active"
    | "on-hold"
    | "cancelled"
    | "completed"
    | "entered-in-error"
    | "stopped"
    | "draft"
    | "unknown"
    | (string & {});
  intent?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  subject?: Reference;
  authoredOn?: string;
  dosageInstruction?: Array<{ text?: string }>;
}

// FHIR R4 AllergyIntolerance.
export interface AllergyIntolerance extends Resource {
  resourceType: "AllergyIntolerance";
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  type?: "allergy" | "intolerance";
  category?: Array<"food" | "medication" | "environment" | "biologic">;
  criticality?: "low" | "high" | "unable-to-assess";
  code?: CodeableConcept;
  patient?: Reference;
  reaction?: Array<{
    manifestation?: CodeableConcept[];
    severity?: "mild" | "moderate" | "severe";
    description?: string;
  }>;
}

export interface Bundle<T extends Resource = Resource> extends Resource {
  resourceType: "Bundle";
  type: string;
  total?: number;
  entry?: Array<{
    fullUrl?: string;
    resource?: T;
  }>;
}
