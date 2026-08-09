import { createHmac, timingSafeEqual } from "crypto";
import type { PrismaClient } from "@prisma/client";

// Talks to Stripe's REST API directly with fetch rather than pulling in the
// stripe SDK — this is a handful of endpoints (checkout session, portal
// session, webhook signature check) and staying dependency-free keeps the
// backend's footprint small.

const STRIPE_API = "https://api.stripe.com/v1";

// ---- Config resolution ----
// Stripe config can come from Admin > Settings > Billing (stored on the
// AppSettings singleton row) or from STRIPE_* env vars. The DB value wins
// when set; a field left empty in the DB falls back to its env var, so an
// operator can mix — e.g. keys from env, plans from the admin UI.
//
// The DB read is cached in-memory for CACHE_TTL_MS so the hot paths
// (checkout, webhook verification, quota lookups) don't hit Postgres on
// every request. admin.ts calls invalidateBillingConfigCache() right
// after a save so a key rotation takes effect immediately instead of
// waiting out the TTL.

type BillingConfig = {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  plans: string | null;
  planQuotas: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: BillingConfig; expiresAt: number } | null = null;

export function invalidateBillingConfigCache(): void {
  cache = null;
}

async function loadConfig(prisma: PrismaClient): Promise<BillingConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  let row: {
    stripeSecretKey: string | null;
    stripePublishableKey: string | null;
    stripeWebhookSecret: string | null;
    stripePlans: string | null;
    stripePlanQuotas: string | null;
  } | null = null;
  try {
    row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        stripeSecretKey: true,
        stripePublishableKey: true,
        stripeWebhookSecret: true,
        stripePlans: true,
        stripePlanQuotas: true,
      },
    });
  } catch {
    // Table/row not reachable (e.g. migration not run yet) — fall back
    // to env vars entirely rather than failing every billing call.
    row = null;
  }

  const value: BillingConfig = {
    secretKey: row?.stripeSecretKey || process.env.STRIPE_SECRET_KEY || null,
    publishableKey: row?.stripePublishableKey || process.env.STRIPE_PUBLISHABLE_KEY || null,
    webhookSecret: row?.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET || null,
    plans: row?.stripePlans || process.env.STRIPE_PLANS || null,
    planQuotas: row?.stripePlanQuotas || process.env.STRIPE_PLAN_QUOTAS || null,
  };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function billingEnabled(prisma: PrismaClient): Promise<boolean> {
  const config = await loadConfig(prisma);
  return Boolean(config.secretKey);
}

async function secretKey(prisma: PrismaClient): Promise<string> {
  const config = await loadConfig(prisma);
  if (!config.secretKey) throw new Error("Billing is not configured (no Stripe secret key set in Admin > Settings or STRIPE_SECRET_KEY)");
  return config.secretKey;
}

// Plans are configured either via Admin > Settings > Billing or the
// STRIPE_PLANS env var so an operator can point them at their own Stripe
// Price IDs without a code change. Format: PLAN_ID:PRICE_ID,PLAN_ID:PRICE_ID
// e.g. "pro:price_123,team:price_456"
export async function getPlans(prisma: PrismaClient): Promise<{ id: string; priceId: string }[]> {
  const config = await loadConfig(prisma);
  const raw = config.plans || "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, priceId] = entry.split(":");
      return { id: id?.trim(), priceId: priceId?.trim() };
    })
    .filter((p) => p.id && p.priceId) as { id: string; priceId: string }[];
}

// Reverse lookup for the webhook handler: given the Stripe Price ID a
// subscription is actually on, find which plans entry it belongs to so we
// can persist a human-readable plan id on the user, not just the raw
// subscription status.
export async function planIdForPriceId(prisma: PrismaClient, priceId: string | undefined | null): Promise<string | null> {
  if (!priceId) return null;
  const plans = await getPlans(prisma);
  return plans.find((p) => p.priceId === priceId)?.id ?? null;
}

// Optional token quota bonus per paid plan, configured the same way as
// plans: "pro:100000,team:500000" as PLAN_ID:dailyTokenQuota. The field is
// still named dailyTokenQuota (kept to avoid a wider rename), but it's
// actually the cap for quota.ts's rolling window (QUOTA_WINDOW_HOURS,
// default 5h), not a calendar day. Covers both chat and image generation —
// see lib/quota.ts IMAGE_TOKEN_COST for how an image's flat cost is
// charged against the same number. Plan values should generally be much
// larger than the DEFAULT_TOKEN_QUOTA free-tier fallback of 5000.
// See lib/quota.ts for how this is merged with the user's group quota (the
// higher of the two wins, so this can only raise a user's limit, never
// lower it below what their group alone provides). A plan with no entry
// here (or billing not configured at all) falls back to the group quota
// unchanged.
export async function planQuota(prisma: PrismaClient, planId: string | null | undefined): Promise<{ dailyTokenQuota: number } | null> {
  if (!planId) return null;
  const config = await loadConfig(prisma);
  const raw = config.planQuotas || "";
  const entry = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [id, tok] = e.split(":");
      return { id: id?.trim(), dailyTokenQuota: Number(tok) };
    })
    .find((e) => e.id === planId);
  if (!entry || Number.isNaN(entry.dailyTokenQuota)) return null;
  return { dailyTokenQuota: entry.dailyTokenQuota };
}

async function stripeRequest(prisma: PrismaClient, path: string, params: Record<string, string>): Promise<any> {
  const key = await secretKey(prisma);
  const body = new URLSearchParams(params);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe request to ${path} failed`);
  }
  return data;
}

async function stripeGet(prisma: PrismaClient, path: string, params: Record<string, string>): Promise<any> {
  const key = await secretKey(prisma);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${STRIPE_API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe request to ${path} failed`);
  }
  return data;
}

// Recent invoices for a customer, for the Billing > Invoices tab. Mapped
// down to just what the UI needs rather than passing Stripe's full object
// through — keeps the frontend decoupled from Stripe's response shape.
export async function listInvoices(prisma: PrismaClient, customerId: string, limit = 24) {
  const data = await stripeGet(prisma, "/invoices", { customer: customerId, limit: String(limit) });
  return (data.data ?? []).map((inv: any) => ({
    id: inv.id as string,
    number: (inv.number as string | null) ?? null,
    status: inv.status as string,
    amountDue: inv.amount_due as number,
    amountPaid: inv.amount_paid as number,
    currency: inv.currency as string,
    created: inv.created as number,
    hostedInvoiceUrl: (inv.hosted_invoice_url as string | null) ?? null,
    invoicePdf: (inv.invoice_pdf as string | null) ?? null,
    periodStart: (inv.period_start as number | null) ?? null,
    periodEnd: (inv.period_end as number | null) ?? null,
  }));
}

export async function ensureStripeCustomer(prisma: PrismaClient, email: string, existingCustomerId?: string | null): Promise<string> {
  if (existingCustomerId) return existingCustomerId;
  const customer = await stripeRequest(prisma, "/customers", { email });
  return customer.id as string;
}

export async function createCheckoutSession(prisma: PrismaClient, opts: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const session = await stripeRequest(prisma, "/checkout/sessions", {
    customer: opts.customerId,
    mode: "subscription",
    "line_items[0][price]": opts.priceId,
    "line_items[0][quantity]": "1",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    // No payment_method_types set on purpose — Checkout automatically
    // offers every recurring-capable method enabled in the Stripe
    // Dashboard for the Price's currency (cards worldwide, plus e.g. SEPA
    // Direct Debit, iDEAL, Bancontact for EUR prices), so European and
    // international cards both just work without extra config here.
    // Currency itself comes from the Price object configured in
    // Admin > Settings > Billing (or STRIPE_PLANS) — use a
    // EUR-denominated Price there for EUR billing.
    locale: "auto", // shows Checkout in the customer's browser language
    billing_address_collection: "auto", // needed for some EU payment methods (SEPA, iDEAL) and VAT
  });
  return session.url as string;
}

export async function createPortalSession(prisma: PrismaClient, customerId: string, returnUrl: string): Promise<string> {
  const session = await stripeRequest(prisma, "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
    locale: "auto",
  });
  return session.url as string;
}

// Verifies Stripe's webhook signature manually (Stripe-Signature header is
// "t=<timestamp>,v1=<hex hmac>"). Avoids needing the SDK's crypto helper.
export async function verifyStripeSignature(prisma: PrismaClient, rawBody: Buffer, signatureHeader: string | undefined): Promise<boolean> {
  const config = await loadConfig(prisma);
  const secret = config.webhookSecret;
  if (!secret || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}
