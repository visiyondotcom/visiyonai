"use client";

import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import ChatWindow from "@/components/ChatWindow";
import OnboardingModal from "@/components/OnboardingModal";
import { useChatStore } from "@/lib/store";
import { useRequireAuth } from "@/lib/useAuth";

// Root URL ("/"). This used to redirect straight to /chat (or show the
// login form for logged-out visitors); the chat UI now lives here
// directly, so ai.visiyon.com opens the app itself instead of an extra
// hop through /chat. useRequireAuth still bounces to /login when there's
// no valid session.
export default function RootPage() {
  const { ready, user } = useRequireAuth();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  if (!ready) return null;
  const showOnboarding = !user?.onboardingSeenAt && !onboardingDismissed;
  return (
    <div className="flex bg-visiyon-bg text-visiyon-text h-full min-h-0">
      <Sidebar model={selectedModel || "glm4:9b"} />
      <ChatWindow />
      {showOnboarding && <OnboardingModal onDone={() => setOnboardingDismissed(true)} />}
    </div>
  );
}
