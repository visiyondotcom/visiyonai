import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/jwt.js";
import {
  billingEnabled,
  getPlans,
  ensureStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  verifyStripeSignature,
  planIdForPriceId,
  listInvoices,
} from "../lib/billing.js";
import { dispatchWebhook } from "../lib/webhooks.js";
import { logEvent } from "../lib/logger.js";

export default async function billingRoutes(app: FastifyInstance) {
  // ---- Whether billing is configured at all, and which plans are on offer
  // — the frontend uses this to decide whether to show the Billing section. ----
  app.get("/billing/config", async () => {
    const [enabled, plans] = await Promise.all([billingEnabled(app.prisma), getPlans(app.prisma)]);

    // Admin-customized "you reached the limit" popup copy (Admin >
    // Settings > Usage limits). Public/no-auth on purpose — the modal
    // that shows this text is seen by regular users, not just admins.
    // Null fields fall back to SubscriptionModal's hardcoded English
    // defaults, so an unconfigured deployment looks unchanged.
    let limitPopup: { title: string | null; message: string | null; buttonText: string | null } = {
      title: null,
      message: null,
      buttonText: null,
    };
    try {
      const row = await app.prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { limitPopupTitle: true, limitPopupMessage: true, limitPopupButtonText: true },
      });
      if (row) {
        limitPopup = {
          title: row.limitPopupTitle,
          message: row.limitPopupMessage,
          buttonText: row.limitPopupButtonText,
        };
      }
    } catch {
      // migration not run yet — just fall back to defaults
    }

    return { enabled, plans: plans.map((p) => p.id), limitPopup };
  });

  // ---- Pricing catalog for the public pricing/upgrade UI. Only
  // operator-visible plans are returned (see Admin > Subscriptions >
  // Plans) — hidden ones stay in the DB but never reach the frontend. ----
  app.get("/billing/plans", async () => {
    const plans = await app.prisma.subscriptionPlan.findMany({
      where: { visible: true },
      orderBy: { sortOrder: "asc" },
    });
    return { plans };
  });

  app.get("/billing/status", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId } = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "Not found" });
    return {
      status: user.subscriptionStatus,
      plan: user.subscriptionPlan,
      currentPeriodEnd: user.subscriptionCurrentPeriodEnd,
      hasCustomer: Boolean(user.stripeCustomerId),
    };
  });

  // Creates (or reuses) the Stripe customer for this user, then a Checkout
  // Session for the requested plan, and returns the URL for the frontend
  // to redirect the browser to.
  app.post("/billing/checkout", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId, email } = req.user as { id: string; email: string };
    const { plan } = z.object({ plan: z.string() }).parse(req.body);

    const plans = await getPlans(app.prisma);
    const priceEntry = plans.find((p) => p.id === plan);
    if (!priceEntry) return reply.code(400).send({ error: "Unknown plan" });

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "Not found" });

    try {
      const customerId = await ensureStripeCustomer(app.prisma, email, user.stripeCustomerId);
      if (customerId !== user.stripeCustomerId) {
        await app.prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
      }
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
      const url = await createCheckoutSession(app.prisma, {
        customerId,
        priceId: priceEntry.priceId,
        successUrl: `${frontendUrl}/settings?billing=success`,
        cancelUrl: `${frontendUrl}/settings?billing=cancelled`,
      });
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(app.prisma, "ERROR", "billing", `Checkout session failed for ${email}: ${message}`);
      return reply.code(502).send({ error: message });
    }
  });

  // Stripe's self-serve portal, for managing/cancelling an existing subscription.
  app.post("/billing/portal", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId } = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeCustomerId) return reply.code(400).send({ error: "No billing account yet" });

    try {
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
      const url = await createPortalSession(app.prisma, user.stripeCustomerId, `${frontendUrl}/settings`);
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  app.get("/billing/invoices", { preHandler: requireAuth }, async (req, reply) => {
    if (!(await billingEnabled(app.prisma))) return reply.code(503).send({ error: "Billing is not configured on this server." });
    const { id: userId } = req.user as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeCustomerId) return { invoices: [] };
    try {
      const invoices = await listInvoices(app.prisma, user.stripeCustomerId);
      return { invoices };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  // ---- Stripe webhook receiver ----
  // Needs the raw request body (Buffer) to verify Stripe's signature; see
  // the global content-type parser in index.ts, which stashes it on
  // req.rawBody for every request before JSON-parsing it.
  app.post("/billing/webhook", async (req, reply) => {
    const signature = req.headers["stripe-signature"] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!rawBody || !(await verifyStripeSignature(app.prisma, rawBody, signature))) {
      return reply.code(400).send({ error: "Invalid signature" });
    }

    const event = req.body as { type: string; data: { object: any } };
    const obj = event.data.object;

    try {
      switch (event.type) {
        case "checkout.session.completed":
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const customerId: string = obj.customer;
          const user = await app.prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
          if (user) {
            // Only subscription objects carry line items with a price id;
            // checkout.session.completed doesn't, so the plan gets filled
            // in a moment later by the subscription.created/updated event
            // Stripe sends right after — this just avoids clobbering the
            // existing plan with null in the meantime.
            const priceId: string | undefined = obj.items?.data?.[0]?.price?.id;
            const mappedPlan = await planIdForPriceId(app.prisma, priceId);

            await app.prisma.user.update({
              where: { id: user.id },
              data: {
                stripeSubscriptionId: obj.id?.startsWith("sub_") ? obj.id : user.stripeSubscriptionId,
                subscriptionStatus: obj.status ?? user.subscriptionStatus,
                subscriptionPlan: mappedPlan ?? user.subscriptionPlan,
                subscriptionCurrentPeriodEnd: obj.current_period_end
                  ? new Date(obj.current_period_end * 1000)
                  : user.subscriptionCurrentPeriodEnd,
              },
            });

            if (priceId && !mappedPlan) {
              logEvent(
                app.prisma,
                "WARN",
                "billing",
                `Subscription price ${priceId} for ${user.email} doesn't match any STRIPE_PLANS entry`
              );
            }

            dispatchWebhook(app.prisma, "SUBSCRIPTION_UPDATED", { userId: user.id, status: obj.status, plan: mappedPlan });
          }
          break;
        }
        case "invoice.payment_failed": {
          const customerId: string = obj.customer;
          const user = await app.prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
          if (user) {
            // Mirror Stripe's own subscription status here rather than
            // inventing our own — a failed invoice puts the subscription
            // into "past_due" (or later "unpaid") on Stripe's side too, and
            // the next customer.subscription.updated event will confirm it.
            // Setting it eagerly here means the UI reflects the failure
            // immediately instead of waiting for that follow-up event.
            await app.prisma.user.update({
              where: { id: user.id },
              data: { subscriptionStatus: "past_due" },
            });
            logEvent(app.prisma, "WARN", "billing", `Invoice payment failed for ${user.email}`);
            dispatchWebhook(app.prisma, "SUBSCRIPTION_UPDATED", { userId: user.id, status: "past_due" });
          }
          break;
        }
        case "customer.subscription.deleted": {
          const customerId: string = obj.customer;
          const user = await app.prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
          if (user) {
            await app.prisma.user.update({
              where: { id: user.id },
              data: { subscriptionStatus: "canceled", subscriptionPlan: null },
            });
            dispatchWebhook(app.prisma, "SUBSCRIPTION_UPDATED", { userId: user.id, status: "canceled" });
          }
          break;
        }
        default:
          break; // ignore events we don't act on
      }
    } catch (err) {
      logEvent(app.prisma, "ERROR", "billing", `Webhook handling failed for ${event.type}: ${err}`);
    }

    return { received: true };
  });
}
