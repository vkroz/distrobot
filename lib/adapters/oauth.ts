import { createHash, randomBytes } from "node:crypto";

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator?: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Query/body param name for the client id (TikTok uses `client_key`). */
  clientIdParam?: string;
  /** How client credentials are sent to the token endpoint. */
  tokenAuth?: "body" | "basic";
  pkce?: boolean;
  extraAuthParams?: Record<string, string>;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(16).toString("base64url");
}

export function readClientCredentials(cfg: OAuthConfig): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[cfg.clientIdEnv];
  const clientSecret = process.env[cfg.clientSecretEnv];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function buildAuthUrl(
  cfg: OAuthConfig,
  clientId: string,
  p: { state: string; redirectUri: string; codeChallenge?: string },
): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set(cfg.clientIdParam ?? "client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(cfg.scopeSeparator ?? " "));
  url.searchParams.set("state", p.state);
  if (p.codeChallenge) {
    url.searchParams.set("code_challenge", p.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

async function tokenRequest(
  cfg: OAuthConfig,
  creds: { clientId: string; clientSecret: string },
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (cfg.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;
    // Some providers (X) still want client_id in the body.
    body.set(cfg.clientIdParam ?? "client_id", creds.clientId);
  } else {
    body.set(cfg.clientIdParam ?? "client_id", creds.clientId);
    body.set("client_secret", creds.clientSecret);
  }
  const res = await fetchImpl(cfg.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as TokenResponse & { data?: TokenResponse };
  // Some providers nest the token under `data`.
  const token = data.access_token ? data : data.data;
  if (!token?.access_token) throw new Error("Token response missing access_token");
  return token;
}

export function refreshToken(
  cfg: OAuthConfig,
  creds: { clientId: string; clientSecret: string },
  refresh: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(cfg, creds, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }), fetchImpl);
}

export function exchangeCode(
  cfg: OAuthConfig,
  creds: { clientId: string; clientSecret: string },
  p: { code: string; redirectUri: string; codeVerifier?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
  });
  if (p.codeVerifier) body.set("code_verifier", p.codeVerifier);
  return tokenRequest(cfg, creds, body, fetchImpl);
}
