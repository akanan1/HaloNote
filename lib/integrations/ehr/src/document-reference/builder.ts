import type { CodeableConcept, Coding, DocumentReference } from "../fhir/types";

export interface NoteContent {
  // Provide either raw text (will be base64-encoded) or pre-encoded base64.
  text?: string;
  base64?: string;
  contentType?: string;
  title?: string;
}

export interface BuildDocumentReferenceInput {
  // Patient reference, e.g. "Patient/abc123"
  patient: string;
  // Encounter reference, e.g. "Encounter/xyz789"
  encounter?: string;
  // Practitioner authoring this note, e.g. "Practitioner/p-1"
  author?: string;
  content: NoteContent;
  typeCode?: Coding;
  // US Core profile + Epic require `category`; defaults to "clinical-note".
  category?: CodeableConcept[];
  // Human-readable description / title for the document.
  description?: string;
  status?: DocumentReference["status"];
  docStatus?: DocumentReference["docStatus"];
  // ISO 8601 timestamp; defaults to now.
  date?: string;
}

// LOINC 34109-9 — generic "Note". The previous default of 11506-3
// (Subsequent evaluation note) was wrong for initial visits, H&P, etc.
// and was rejected outright by some Epic tenants. Callers should still
// override `typeCode` with a more specific code when known.
const DEFAULT_TYPE: Coding = {
  system: "http://loinc.org",
  code: "34109-9",
  display: "Note",
};

// US Core DocumentReference profile requires `category`. "clinical-note"
// is the umbrella code for unstructured clinician documentation.
const DEFAULT_CATEGORY: CodeableConcept[] = [
  {
    coding: [
      {
        system:
          "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
        code: "clinical-note",
        display: "Clinical Note",
      },
    ],
  },
];

export function buildDocumentReference(
  input: BuildDocumentReferenceInput,
): DocumentReference {
  const data =
    input.content.base64 ??
    (input.content.text != null
      ? Buffer.from(input.content.text, "utf8").toString("base64")
      : undefined);

  if (!data) {
    throw new Error(
      "DocumentReference content requires either `text` or `base64`.",
    );
  }

  const type = input.typeCode ?? DEFAULT_TYPE;
  const category = input.category ?? DEFAULT_CATEGORY;

  const resource: DocumentReference = {
    resourceType: "DocumentReference",
    status: input.status ?? "current",
    docStatus: input.docStatus ?? "final",
    type: {
      coding: [type],
      ...(type.display ? { text: type.display } : {}),
    },
    category,
    subject: { reference: input.patient },
    date: input.date ?? new Date().toISOString(),
    content: [
      {
        attachment: {
          contentType: input.content.contentType ?? "text/plain",
          data,
          ...(input.content.title ? { title: input.content.title } : {}),
        },
      },
    ],
  };

  if (input.description) {
    resource.description = input.description;
  }
  if (input.author) {
    resource.author = [{ reference: input.author }];
  }
  if (input.encounter) {
    resource.context = { encounter: [{ reference: input.encounter }] };
  }

  return resource;
}
