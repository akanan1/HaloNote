import { OAuth2TokenProvider } from "../../auth/oauth2";
import { DocumentReferencePusher } from "../../document-reference/pusher";
import { FhirClient } from "../../fhir/client";
import type { AthenahealthConfig } from "./config";

export interface AthenahealthEhrClient {
  fhir: FhirClient;
  auth: OAuth2TokenProvider;
  documentReference: DocumentReferencePusher;
}

export function createAthenahealthClient(
  config: AthenahealthConfig,
): AthenahealthEhrClient {
  const auth = new OAuth2TokenProvider({
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
    fetchImpl: config.fetchImpl,
  });

  const fhir = new FhirClient({
    baseUrl: config.fhirBaseUrl,
    getToken: () => auth.getToken(),
    fetchImpl: config.fetchImpl,
  });

  const documentReference = new DocumentReferencePusher(fhir);

  return { fhir, auth, documentReference };
}
