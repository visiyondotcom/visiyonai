"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBillingConfig, markOnboardingSeen } from "@/lib/api";
import { X, Check } from "lucide-react";

// Same flat-black, 6px-rounded treatment as the limit-reached popup, shown
// once on a user's first login. Introduces the app and — if billing is
// configured on this server — the available subscription plans, so a new
// user sees pricing before they hit a quota wall.
export default function OnboardingModal({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [plans, setPlans] = useState<string[]>([]);
  const [billingEnabled, setBillingEnabled] = useState(false);

  useEffect(() => {
    getBillingConfig()
      .then((c) => {
        setBillingEnabled(c.enabled);
        setPlans(c.plans);
      })
      .catch(() => {});
  }, []);

  async function dismiss(goToBilling: boolean) {
    try {
      await markOnboardingSeen();
    } catch {
      // best-effort — don't block dismissing the modal on this
    }
    onDone();
    if (goToBilling) router.push("/settings");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md bg-visiyon-bg rounded-[6px] p-6">
        <div className="flex items-start justify-between">
          <h2 className="text-[16px] font-medium text-visiyon-text">Welcome</h2>
          <button
            onClick={() => dismiss(false)}
            className="text-visiyon-text-3 hover:text-visiyon-text transition-colors"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-visiyon-text-2">
          You're starting on the Free plan. You can chat right away — upgrade any time from Settings if you need
          a higher usage limit.
        </p>

        {billingEnabled && plans.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {plans.map((p) => (
              <div
                key={p}
                className="flex items-center gap-2 text-[13px] text-visiyon-text-2 bg-visiyon-text/[0.04] rounded-[6px] px-3 py-2"
              >
                <Check size={13} className="text-visiyon-text-3" />
                <span className="capitalize">{p}</span> plan available
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={() => dismiss(false)}
            className="text-[12.5px] px-3 py-1.5 rounded-[6px] text-visiyon-text-2 hover:text-visiyon-text transition-colors"
          >
            Start chatting
          </button>
          {billingEnabled && (
            <button
              onClick={() => dismiss(true)}
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:bg-visiyon-text/90 transition-colors"
            >
              View plans
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
