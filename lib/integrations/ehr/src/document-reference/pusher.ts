import type { FhirClient } from "../fhir/client";
import type { DocumentReference } from "../fhir/types";
import {
  buildDocumentReference,
  type BuildDocumentReferenceInput,
} from "./builder";

export interface PushOptions {
  /**
   * Stable Idempotency-Key for this logical write. Reuse on retry of
   * the same note so the EHR can dedupe; generate a fresh one for a
   * new note. Forwarded verbatim to the FHIR server. Required for any
   * real-EHR push — without it, a transient timeout becomes a duplicate
   * chart row.
   */
  idempotencyKey: string;
}

export class DocumentReferencePusher {
  constructor(private readonly client: FhirClient) {}

  async push(
    input: BuildDocumentReferenceInput,
    options: PushOptions,
  ): Promise<DocumentReference> {
    const resource = buildDocumentReference(input);
    return this.client.create<DocumentReference>(resource, {
      idempotencyKey: options.idempotencyKey,
    });
  }

  async pushResource(
    resource: DocumentReference,
    options: PushOptions,
  ): Promise<DocumentReference> {
    return this.client.create<DocumentReference>(resource, {
      idempotencyKey: options.idempotencyKey,
    });
  }
}
