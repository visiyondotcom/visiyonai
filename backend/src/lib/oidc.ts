import { request } from "undici";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// Generic OpenID Connect client — works with any compliant provider
// (Microsoft/Azure AD, Google Workspace, Keycloak, Authentik, Auth0,
// Okta, ...). Configured either from Admin > Settings > Login or from
// OIDC_* env vars.
//
// ---- Config resolution ----
// Same "DB wins, falls back to env" pattern as lib/billing.ts and
// lib/music.ts: config can come from the AppSettings singleton row or
// from OIDC_* env vars. A field left empty in the DB falls back to its
// env var, so an operator can mix. Cached in-memory for CACHE_TTL_MS;
// admin.ts calls invalidateSsoConfigCache() right after a save so a
// client secret rotation takes effect immediately instead of waiting
// out the TTL.

type OidcConfig = {
  enabled: boolean;
  providerName: string;
  issuerUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string;
  redirectUri: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: OidcConfig; expiresAt: number } | null = null;

export function invalidateSsoConfigCache(): void {
  cache = null;
}

async function loadConfig(prisma?: PrismaClient): Promise<OidcConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    ssoEnabled: boolean | null;
    ssoProviderName: string | null;
    ssoIssuerUrl: string | null;
    ssoClientId: string | null;
    ssoClientSecret: string | null;
    ssoScopes: string | null;
    ssoRedirectUri: string | null;
  } | null = null;
  if (prisma) {
    try {
      row = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          ssoEnabled: true,
          ssoProviderName: true,
          ssoIssuerUrl: true,
          ssoClientId: true,
          ssoClientSecret: true,
          ssoScopes: true,
          ssoRedirectUri: true,
        },
      });
    } catch {
      // Table/row not reachable (e.g. migration not run yet) — fall back
      // to env vars entirely rather than failing every auth call.
      row = null;
    }
  }

  const issuerUrl = row?.ssoIssuerUrl || process.env.OIDC_ISSUER_URL || null;
  const clientId = row?.ssoClientId || process.env.OIDC_CLIENT_ID || null;
  const clientSecret = row?.ssoClientSecret || process.env.OIDC_CLIENT_SECRET || null;
  // ssoEnabled is nullable: null means no explicit admin choice has been
  // made yet, so fall back to "credentials are present" — this is what
  // keeps a pre-existing env-var-only setup working right after
  // upgrading, before anyone has touched the new admin panel toggle.
  // Once an admin explicitly sets it true/false, that always wins.
  const enabledFromDb = row?.ssoEnabled ?? Boolean(issuerUrl && clientId && clientSecret);

  const value: OidcConfig = {
    enabled: enabledFromDb && Boolean(issuerUrl && clientId && clientSecret),
    providerName: row?.ssoProviderName || process.env.OIDC_PROVIDER_NAME || "SSO",
    issuerUrl,
    clientId,
    clientSecret,
    scopes: row?.ssoScopes || process.env.OIDC_SCOPES || "openid email profile",
    redirectUri: row?.ssoRedirectUri || process.env.OIDC_REDIRECT_URI || null,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function ssoEnabled(prisma?: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return config.enabled;
}

export async function ssoProviderName(prisma?: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);
  return config.providerName;
}

// Falls back to building the callback URL from the current request's
// origin when neither the DB field nor OIDC_REDIRECT_URI is set.
export async function ssoRedirectUri(prisma: PrismaClient | undefined, fallback: string): Promise<string> {
  const config = await loadConfig(prisma);
  return config.redirectUri || fallback;
}

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

// The discovery document rarely changes — cache it in-process for an hour
// instead of fetching it on every login click. Keyed by issuer so a
// changed issuer URL (from the admin panel) doesn't keep serving a stale
// discovery doc for the old provider.
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

async function discover(issuerUrl: string): Promise<Discovery> {
  const issuer = issuerUrl.replace(/\/$/, "");
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.doc;
  const res = await request(`${issuer}/.well-known/openid-configuration`);
  if (res.statusCode >= 400) throw new Error(`OIDC discovery failed: ${res.statusCode}`);
  const doc = (await res.body.json()) as Discovery;
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

export function generateState(): string {
  return randomBytes(24).toString("hex");
}

export async function buildAuthorizationUrl(prisma: PrismaClient | undefined, state: string, redirectUri: string): Promise<string> {
  const config = await loadConfig(prisma);
  if (!config.issuerUrl || !config.clientId) throw new Error("SSO is not configured");
  const doc = await discover(config.issuerUrl);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

export type SsoProfile = {
  sub: string;
  email: string;
  name?: string;
};

export async function exchangeCodeForProfile(prisma: PrismaClient | undefined, code: string, redirectUri: string): Promise<SsoProfile> {
  const config = await loadConfig(prisma);
  if (!config.issuerUrl || !config.clientId || !config.clientSecret) throw new Error("SSO is not configured");
  const doc = await discover(config.issuerUrl);

  const tokenRes = await request(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });
  if (tokenRes.statusCode >= 400) {
    throw new Error(`OIDC token exchange failed: ${tokenRes.statusCode} ${await tokenRes.body.text()}`);
  }
  const tokenData = (await tokenRes.body.json()) as { access_token: string };

  const userRes = await request(doc.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  });
  if (userRes.statusCode >= 400) {
    throw new Error(`OIDC userinfo failed: ${userRes.statusCode}`);
  }
  const profile = (await userRes.body.json()) as { sub: string; email?: string; name?: string; preferred_username?: string };
  const email = profile.email || profile.preferred_username;
  if (!email) throw new Error("OIDC provider did not return an email or preferred_username claim");

  return { sub: profile.sub, email, name: profile.name || profile.preferred_username };
}
