export interface OAuth2Config {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}

export interface AccessToken {
  token: string;
  // ms epoch
  expiresAt: number;
  tokenType: string;
  scope?: string;
}
