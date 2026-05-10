import type { FhirClient } from "../fhir/client";
import type { DocumentReference } from "../fhir/types";
import {
  buildDocumentReference,
  type BuildDocumentReferenceInput,
} from "./builder";

export class DocumentReferencePusher {
  constructor(private readonly client: FhirClient) {}

  async push(input: BuildDocumentReferenceInput): Promise<DocumentReference> {
    const resource = buildDocumentReference(input);
    return this.client.create<DocumentReference>(resource);
  }

  async pushResource(resource: DocumentReference): Promise<DocumentReference> {
    return this.client.create<DocumentReference>(resource);
  }
}
