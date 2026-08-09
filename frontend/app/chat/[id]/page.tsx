"use client";

import { useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ChatWindow from "@/components/ChatWindow";
import { useChatStore } from "@/lib/store";
import { useRequireAuth } from "@/lib/useAuth";

export default function ChatPage() {
  const { ready } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const selectedModel = useChatStore((s) => s.selectedModel);
  if (!ready) return null;
  return (
    <div className="flex bg-visiyon-bg text-visiyon-text h-full min-h-0">
      <Sidebar activeId={params.id} model={selectedModel || "glm4:9b"} />
      <ChatWindow chatId={params.id} />
    </div>
  );
}
