"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  getBillingConfig,
  getBillingStatus,
  getBillingPlans,
  getTodayUsage,
  createCheckoutSession,
  getMe,
  SubscriptionPlan,
  LimitPopupCopy,
} from "@/lib/api";
import { formatResetRelative } from "@/lib/format";

// Paid tiers shown here come straight from the backend-managed plan
// catalog (Admin > Subscriptions > Plans) via getBillingPlans(), so what's
// displayed in this picker is always in sync with what an admin configures
// there — no numbers hardcoded on the frontend to drift out of date.
type Tier = {
  id: string;
  name: string;
  price: string;
  period: string;
  perks: string[];
  popular?: boolean;
};

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

function planToTier(plan: SubscriptionPlan): Tier {
  const perks = [...plan.features];
  if (plan.tokenQuota != null) perks.push(`${plan.tokenQuota.toLocaleString()} tokens / 5h`);
  return {
    id: plan.planId,
    name: plan.name,
    price: formatPrice(plan.priceCents, plan.currency),
    period: `/ ${plan.interval}`,
    perks,
    popular: plan.highlighted,
  };
}

// resetAt is only passed when the modal was opened because the user
// actually hit their quota (see ChatWindow) — the manual "Upgrade" button
// in the header opens this same modal with no resetAt, in which case the
// limit-hit copy below is skipped entirely and just the plain picker shows.
export default function SubscriptionModal({ onClose, resetAt }: { onClose: () => void; resetAt?: string | null }) {
  const [loading, setLoading] = useState(true);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [availablePlans, setAvailablePlans] = useState<string[]>([]);
  const [paidTiers, setPaidTiers] = useState<Tier[]>([]);
  const [currentPlan, setCurrentPlan] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [dailyQuota, setDailyQuota] = useState<number | null>(null);
  const [windowHours, setWindowHours] = useState<number>(5);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popupCopy, setPopupCopy] = useState<LimitPopupCopy>({ title: null, message: null, buttonText: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [config, plansRes, status, usage, me] = await Promise.all([
          getBillingConfig(),
          getBillingPlans().catch(() => ({ plans: [] as SubscriptionPlan[] })),
          getBillingStatus().catch(() => null),
          getTodayUsage().catch(() => null),
          getMe().catch(() => null),
        ]);
        if (cancelled) return;
        setBillingEnabled(config.enabled);
        setAvailablePlans(config.plans || []);
        setPopupCopy(config.limitPopup || { title: null, message: null, buttonText: null });
        setPaidTiers(
          [...plansRes.plans].sort((a, b) => a.sortOrder - b.sortOrder).map(planToTier)
        );
        setCurrentPlan(status?.plan || null);
        setDailyQuota(usage?.dailyTokenQuota ?? null);
        if (usage?.windowHours) setWindowHours(usage.windowHours);
        // Only an actual ADMIN role counts as unrestricted — a regular
        // account with no group quota configured is still just "Free".
        setIsAdmin(me?.role === "ADMIN");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(planId: string) {
    setError(null);
    setCheckingOut(planId);
    try {
      const { url } = await createCheckoutSession(planId);
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || "Failed to start checkout.");
      setCheckingOut(null);
    }
  }

  const currentPlanLabel = isAdmin ? "Unlimited (Admin)" : currentPlan || "Free";
  const currentLimitLabel = isAdmin
    ? "None — unrestricted"
    : dailyQuota == null
    ? "None — unrestricted"
    : `${dailyQuota.toLocaleString()} tokens / ${windowHours}h`;

  // The Free tier's real limit is whatever the signed-in free-plan user's
  // actual quota resolves to (group override or the server's default token
  // quota) — reuse dailyQuota rather than a hardcoded number that can drift
  // out of sync with what's actually enforced.
  const freeTier: Tier = {
    id: "free",
    name: "Free",
    price: "€0",
    period: "",
    perks: [`${(dailyQuota ?? 5000).toLocaleString()} tokens / ${windowHours}h`],
  };
  const tiers: Tier[] = [freeTier, ...paidTiers];

  // Title/message only render when resetAt is set, i.e. the modal was
  // triggered by an actual 429 quota rejection — the manual Upgrade button
  // has no resetAt and just shows the plain plan picker below.
  const isLimitHit = Boolean(resetAt);
  const title = isLimitHit ? popupCopy.title || "You've reached your usage limit" : "Choose your subscription";
  const resetSuffix = resetAt ? ` More budget frees up ${formatResetRelative(resetAt)}.` : "";
  const message = isLimitHit
    ? (popupCopy.message || "Upgrade your plan to keep chatting, or wait for your limit to reset.") + resetSuffix
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-visiyon-bg rounded-[6px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <h2 className="text-[19px] font-medium text-visiyon-text">{title}</h2>
          <button onClick={onClose} className="text-visiyon-text-3 hover:text-visiyon-text transition-colors" title="Close">
            <X size={18} />
          </button>
        </div>

        {message && <p className="text-[13px] leading-relaxed text-visiyon-text-2 mb-5">{message}</p>}

        <div className="border border-visiyon-border rounded-[6px] px-4 py-3 flex items-center justify-between mb-6">
          <div>
            <div className="text-[12.5px] text-visiyon-text-3">Current plan</div>
            <div className="text-[12.5px] text-visiyon-text-3 mt-1">Usage limit</div>
          </div>
          <div className="text-right">
            <div className="text-[13.5px] font-medium text-visiyon-text">{currentPlanLabel}</div>
            <div className="text-[13.5px] font-medium text-visiyon-text mt-1">{currentLimitLabel}</div>
          </div>
        </div>

        {error && <p className="text-[12.5px] text-red-400 mb-4 animate-blink">{error}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {tiers.map((tier) => {
            const isCurrent = (currentPlan || "free").toLowerCase() === tier.id;
            const isConfigured = tier.id === "free" || availablePlans.includes(tier.id);
            const canChoose = billingEnabled && isConfigured && !isCurrent && !isAdmin;
            // Admin-customized button text (with {plan} substituted) only
            // applies to the actual "choose this plan" state — the
            // Current/Redirecting/Not available states keep their own copy
            // regardless, since a custom "Choose {plan}" string wouldn't
            // make sense there.
            const chooseLabel = (popupCopy.buttonText || "Choose {plan}").replace("{plan}", tier.name);

            return (
              <div
                key={tier.id}
                className={`relative border rounded-[6px] p-4 flex flex-col ${
                  tier.popular ? "border-visiyon-text" : "border-visiyon-border"
                }`}
              >
                {tier.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-white text-black text-[10.5px] font-medium px-2.5 py-1 rounded-full">
                    Most popular
                  </span>
                )}
                <div className="text-center">
                  <div className="text-[14px] font-medium text-visiyon-text">{tier.name}</div>
                  <div className="mt-1 text-[22px] font-semibold text-visiyon-text leading-tight">
                    {tier.price}
                    {tier.period && <span className="text-[13px] font-normal text-visiyon-text-3"> {tier.period}</span>}
                  </div>
                </div>
                <div className="mt-4 space-y-1 text-center flex-1">
                  {tier.perks.map((perk) => (
                    <div key={perk} className="text-[12.5px] text-visiyon-text-2">
                      {perk}
                    </div>
                  ))}
                </div>
                <button
                  disabled={loading || isCurrent || !canChoose || checkingOut === tier.id}
                  onClick={() => choose(tier.id)}
                  className={`mt-4 w-full text-[13px] font-medium px-4 py-2 rounded-[6px] transition-colors ${
                    isCurrent
                      ? "bg-visiyon-text/10 text-visiyon-text-3 cursor-default"
                      : canChoose
                      ? "bg-white text-black hover:bg-visiyon-text/85"
                      : "bg-visiyon-text/5 text-visiyon-text-3 cursor-not-allowed"
                  }`}
                >
                  {isCurrent
                    ? "Current plan"
                    : checkingOut === tier.id
                    ? "Redirecting…"
                    : !isConfigured || !billingEnabled
                    ? "Not available"
                    : chooseLabel}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
