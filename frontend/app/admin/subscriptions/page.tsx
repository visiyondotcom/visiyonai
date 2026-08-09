"use client";

import { useEffect, useState } from "react";
import { useRequireAdmin } from "@/lib/useAuth";
import {
  adminGetSubscriptions,
  adminGetWastedTokens,
  AdminSubscriptionUser,
  adminListSubscriptionPlans,
  adminCreateSubscriptionPlan,
  adminUpdateSubscriptionPlan,
  adminDeleteSubscriptionPlan,
  SubscriptionPlan,
  SubscriptionPlanInput,
} from "@/lib/api";
import { Plus, Trash2, Pencil } from "lucide-react";

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${on ? "bg-visiyon-accent" : "bg-visiyon-text/15"}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform ${
          on ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
        }`}
      />
    </button>
  );
}

const EMPTY_PLAN: SubscriptionPlanInput = {
  planId: "",
  name: "",
  description: null,
  priceCents: 0,
  currency: "usd",
  interval: "month",
  features: [],
  tokenQuota: null,
  visible: true,
  highlighted: false,
  sortOrder: 0,
};

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const STATUS_COLORS: Record<string, string> = {
  active: "text-green-400",
  trialing: "text-blue-400",
  past_due: "text-yellow-400",
  unpaid: "text-red-400",
  canceled: "text-visiyon-text-3",
};

export default function AdminSubscriptionsPage() {
  const ready = useRequireAdmin();
  const [users, setUsers] = useState<AdminSubscriptionUser[]>([]);
  const [summary, setSummary] = useState<{ plan: string | null; status: string | null; count: number }[]>([]);
  const [wasted, setWasted] = useState<{ totalWastedTokens: number; topUsers: { id: string; email: string; name: string | null; wastedTokens: number }[] }>({
    totalWastedTokens: 0,
    topUsers: [],
  });
  const [loading, setLoading] = useState(true);

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<SubscriptionPlanInput>(EMPTY_PLAN);
  const [featuresText, setFeaturesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    Promise.all([adminGetSubscriptions(), adminGetWastedTokens()])
      .then(([subs, w]) => {
        setUsers(subs.users);
        setSummary(subs.summary);
        setWasted(w);
      })
      .finally(() => setLoading(false));
    refreshPlans();
  }, [ready]);

  function refreshPlans() {
    setPlansLoading(true);
    adminListSubscriptionPlans()
      .then((d) => setPlans(d.plans))
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false));
  }

  function startNewPlan() {
    setPlanError(null);
    setDraft({ ...EMPTY_PLAN, sortOrder: plans.length });
    setFeaturesText("");
    setEditingId("new");
  }

  function startEditPlan(plan: SubscriptionPlan) {
    setPlanError(null);
    const { id, createdAt, updatedAt, ...rest } = plan;
    setDraft(rest);
    setFeaturesText(plan.features.join("\n"));
    setEditingId(plan.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setPlanError(null);
  }

  async function savePlan() {
    setSaving(true);
    setPlanError(null);
    const body: SubscriptionPlanInput = {
      ...draft,
      features: featuresText.split("\n").map((f) => f.trim()).filter(Boolean),
    };
    try {
      if (editingId === "new") {
        const { plan } = await adminCreateSubscriptionPlan(body);
        setPlans((prev) => [...prev, plan].sort((a, b) => a.sortOrder - b.sortOrder));
      } else if (editingId) {
        const { plan } = await adminUpdateSubscriptionPlan(editingId, body);
        setPlans((prev) => prev.map((p) => (p.id === editingId ? plan : p)).sort((a, b) => a.sortOrder - b.sortOrder));
      }
      setEditingId(null);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Could not save plan.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleVisible(plan: SubscriptionPlan) {
    const { plan: updated } = await adminUpdateSubscriptionPlan(plan.id, { visible: !plan.visible });
    setPlans((prev) => prev.map((p) => (p.id === plan.id ? updated : p)));
  }

  async function deletePlan(plan: SubscriptionPlan) {
    if (!confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return;
    await adminDeleteSubscriptionPlan(plan.id);
    setPlans((prev) => prev.filter((p) => p.id !== plan.id));
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>

        {loading ? (
          <div className="text-visiyon-text-3 text-[13px]">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {summary.length === 0 && (
                <div className="rounded-[6px] p-5 col-span-full text-[13px] text-visiyon-text-3">
                  No subscriptions yet.
                </div>
              )}
              {summary.map((s) => (
                <div key={`${s.plan}-${s.status}`} className="rounded-[6px] p-5">
                  <div className="text-[12px] text-visiyon-text-3 capitalize">
                    {s.plan || "unknown"} · <span className={STATUS_COLORS[s.status || ""] || ""}>{s.status}</span>
                  </div>
                  <div className="text-2xl font-semibold mt-1">{formatNumber(s.count)}</div>
                </div>
              ))}
            </div>

            <div className="rounded-[6px] p-5 mb-6">
              <h2 className="text-[14px] font-medium mb-1">Wasted chat tokens</h2>
              <p className="text-[12.5px] text-visiyon-text-3 mb-3">
                Tokens spent on replies that were regenerated, made stale by an edit, or rated thumbs-down.
              </p>
              <div className="text-2xl font-semibold mb-4">{formatNumber(wasted.totalWastedTokens)}</div>
              {wasted.topUsers.length > 0 && (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-visiyon-text-3 text-left border-b border-visiyon-border">
                      <th className="py-2 font-normal">User</th>
                      <th className="py-2 font-normal">Wasted tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wasted.topUsers.map((u) => (
                      <tr key={u.id} className="border-b border-visiyon-border last:border-0">
                        <td className="py-2">{u.name || u.email}</td>
                        <td className="py-2">{formatNumber(u.wastedTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="rounded-[6px] p-5 mb-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-[14px] font-medium">Plans</h2>
                {editingId === null && (
                  <button
                    onClick={startNewPlan}
                    className="flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-full bg-white text-black"
                  >
                    <Plus size={14} /> New plan
                  </button>
                )}
              </div>
              <p className="text-[12.5px] text-visiyon-text-3 mb-4">
                Manage what's offered on the pricing / upgrade page — price, features and visibility. The{" "}
                <code>plan id</code> here must match the id used on the{" "}
                <a href="/admin/settings" className="underline">
                  Settings &gt; Billing &gt; Plans
                </a>{" "}
                field so it maps to the right Stripe price.
              </p>

              {editingId !== null && (
                <div className="border border-visiyon-border rounded-[6px] p-4 mb-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Plan id</label>
                      <input
                        value={draft.planId}
                        onChange={(e) => setDraft({ ...draft, planId: e.target.value })}
                        placeholder="pro"
                        disabled={editingId !== "new"}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Display name</label>
                      <input
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="Pro"
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Description</label>
                    <input
                      value={draft.description ?? ""}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
                      placeholder="For power users who want more of everything"
                      className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                    />
                  </div>

                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Price</label>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={draft.priceCents / 100}
                        onChange={(e) => setDraft({ ...draft, priceCents: Math.round(Number(e.target.value) * 100) })}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Currency</label>
                      <input
                        value={draft.currency}
                        onChange={(e) => setDraft({ ...draft, currency: e.target.value.toLowerCase().slice(0, 3) })}
                        placeholder="usd"
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Interval</label>
                      <select
                        value={draft.interval}
                        onChange={(e) => setDraft({ ...draft, interval: e.target.value as "month" | "year" })}
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                      >
                        <option value="month" className="bg-visiyon-panel">Monthly</option>
                        <option value="year" className="bg-visiyon-panel">Yearly</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Token quota</label>
                      <input
                        type="number"
                        min={0}
                        value={draft.tokenQuota ?? ""}
                        onChange={(e) => setDraft({ ...draft, tokenQuota: e.target.value ? Number(e.target.value) : null })}
                        placeholder="optional"
                        className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11.5px] text-visiyon-text-3 block mb-1">Features (one per line)</label>
                    <textarea
                      value={featuresText}
                      onChange={(e) => setFeaturesText(e.target.value)}
                      rows={4}
                      placeholder={"Unlimited chats\nPriority support\n100k tokens / day"}
                      className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text resize-y"
                    />
                  </div>

                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                      <Toggle on={draft.visible} onClick={() => setDraft({ ...draft, visible: !draft.visible })} />
                      Visible on pricing page
                    </label>
                    <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                      <Toggle on={draft.highlighted} onClick={() => setDraft({ ...draft, highlighted: !draft.highlighted })} />
                      "Most popular" badge
                    </label>
                    <div className="flex items-center gap-2 text-[13px]">
                      Sort order
                      <input
                        type="number"
                        value={draft.sortOrder}
                        onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
                        className="w-16 text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-1 outline-none focus:border-visiyon-text"
                      />
                    </div>
                  </div>

                  {planError && <p className="text-[12px] text-red-400 animate-blink">{planError}</p>}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={savePlan}
                      disabled={saving || !draft.planId || !draft.name}
                      className="text-[13px] font-medium px-4 py-2 rounded-full bg-white text-black disabled:opacity-40"
                    >
                      {saving ? "Saving…" : "Save plan"}
                    </button>
                    <button onClick={cancelEdit} className="text-[13px] px-4 py-2 rounded-full text-visiyon-text-3 hover:text-visiyon-text">
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {plansLoading ? (
                <div className="text-visiyon-text-3 text-[13px]">Loading…</div>
              ) : plans.length === 0 ? (
                <div className="text-[13px] text-visiyon-text-3">No plans yet — add one to populate the pricing page.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {plans.map((plan) => (
                    <div key={plan.id} className="border border-visiyon-border rounded-[6px] p-4 relative">
                      {plan.highlighted && (
                        <span className="absolute -top-2 right-3 text-[10px] font-medium px-2 py-0.5 rounded-full bg-white text-black">
                          Popular
                        </span>
                      )}
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[14px] font-medium">{plan.name}</span>
                        <span className={`text-[11px] ${plan.visible ? "text-green-400" : "text-visiyon-text-3"}`}>
                          {plan.visible ? "Visible" : "Hidden"}
                        </span>
                      </div>
                      <div className="text-[12px] text-visiyon-text-3 font-mono mb-2">{plan.planId}</div>
                      <div className="text-xl font-semibold mb-1">
                        {formatPrice(plan.priceCents, plan.currency)}
                        <span className="text-[12px] font-normal text-visiyon-text-3">/{plan.interval}</span>
                      </div>
                      {plan.description && <p className="text-[12px] text-visiyon-text-3 mb-2">{plan.description}</p>}
                      {plan.features.length > 0 && (
                        <ul className="text-[12px] text-visiyon-text-2 space-y-0.5 mb-3 list-disc list-inside">
                          {plan.features.map((f, i) => (
                            <li key={i}>{f}</li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-3 pt-2 border-t border-visiyon-border mt-2">
                        <button onClick={() => startEditPlan(plan)} className="flex items-center gap-1 text-[12px] text-visiyon-text-3 hover:text-visiyon-text">
                          <Pencil size={12} /> Edit
                        </button>
                        <button onClick={() => toggleVisible(plan)} className="text-[12px] text-visiyon-text-3 hover:text-visiyon-text">
                          {plan.visible ? "Hide" : "Show"}
                        </button>
                        <button onClick={() => deletePlan(plan)} className="flex items-center gap-1 text-[12px] text-visiyon-text-3 hover:text-red-400 ml-auto">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-[6px] p-5">
              <h2 className="text-[14px] font-medium mb-3">Subscribers</h2>
              {users.length === 0 ? (
                <div className="text-[13px] text-visiyon-text-3">No users with a Stripe subscription yet.</div>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-visiyon-text-3 text-left border-b border-visiyon-border">
                      <th className="py-2 font-normal">User</th>
                      <th className="py-2 font-normal">Plan</th>
                      <th className="py-2 font-normal">Status</th>
                      <th className="py-2 font-normal">Renews / ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b border-visiyon-border last:border-0">
                        <td className="py-2">{u.name || u.email}</td>
                        <td className="py-2 capitalize">{u.subscriptionPlan || "—"}</td>
                        <td className={`py-2 ${STATUS_COLORS[u.subscriptionStatus || ""] || ""}`}>
                          {u.subscriptionStatus || "—"}
                        </td>
                        <td className="py-2">{formatDate(u.subscriptionCurrentPeriodEnd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
