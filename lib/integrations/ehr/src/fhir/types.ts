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
