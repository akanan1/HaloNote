export interface AthenahealthConfig {
  // FHIR R4 base URL. Confirm against athenahealth's developer documentation
  // for the environment being targeted (sandbox vs. production).
  fhirBaseUrl: string;
  // OAuth2 token endpoint URL.
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  // OAuth2 scope string, if required by the registered application.
  scope?: string;
  fetchImpl?: typeof fetch;
}
