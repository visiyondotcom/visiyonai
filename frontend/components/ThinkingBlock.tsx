"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, Globe, Wrench, Brain, AlertTriangle } from "lucide-react";
import type { ThinkingStep } from "@/lib/store";

const ICONS: Record<string, typeof Brain> = {
  rag: Search,
  websearch: Globe,
  tool: Wrench,
  reasoning: Brain,
};

function StepIcon({ type, status }: { type: string; status: ThinkingStep["status"] }) {
  const Icon = status === "error" ? AlertTriangle : ICONS[type] ?? Brain;
  return (
    <Icon
      size={13}
      className={status === "error" ? "text-red-400" : status === "start" ? "text-visiyon-text-3 animate-pulse" : "text-visiyon-text-3"}
    />
  );
}

// Shows what the assistant did (RAG lookups, web search, tool calls) and
// thought (the model's own chain-of-thought, for reasoning-capable models)
// while producing a reply — collapsed by default, like Claude/ChatGPT's
// "Thought for Xs" block. Live during streaming (ticking timer, steps
// appearing one by one), then frozen once the reply is done and persisted.
// Always shown, even when nothing special happened (no RAG/search/tools,
// no reasoning field) — expanding it then just confirms that, rather than
// the block silently not appearing at all.
export default function ThinkingBlock({
  steps,
  reasoning,
  isLive,
}: {
  steps?: ThinkingStep[] | null;
  reasoning?: string | null;
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const hasContent = (steps && steps.length > 0) || !!reasoning;

  const startedAt = useMemo(() => {
    const first = steps && steps[0];
    return first ? new Date(first.at).getTime() : Date.now();
  }, [steps && steps[0]?.at]);

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000))), 500);
    return () => clearInterval(t);
  }, [isLive, startedAt]);

  // Once streaming stops, freeze the timer at whatever it last read instead
  // of continuing to tick — that's the final "thought for Xs" figure.
  useEffect(() => {
    if (!isLive && steps && steps.length > 0) {
      const last = steps[steps.length - 1];
      setElapsed(Math.max(1, Math.round((new Date(last.at).getTime() - startedAt) / 1000)));
    }
  }, [isLive, steps, startedAt]);

  return (
    <div className="mb-3 pb-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-0 py-1 text-[12.5px] text-visiyon-text-2 hover:text-visiyon-text transition-colors"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className={isLive ? "visiyon-shimmer-text" : ""}>
          {isLive ? "Thinking" : "Thought"}
          {elapsed > 0 ? ` (${elapsed}s)` : ""}
        </span>
      </button>
      {expanded && (
        <div className="ml-1 pl-3 pb-3 space-y-2 text-[12.5px] text-visiyon-text-2 italic border-l-2 border-visiyon-border">
          {hasContent ? (
            <>
              {steps && steps.length > 0 && (
                <ul className="space-y-1.5 not-italic">
                  {steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-0.5">
                        <StepIcon type={s.type} status={s.status} />
                      </span>
                      <span>
                        {s.label}
                        {s.detail && (
                          <span className="block text-[11.5px] text-visiyon-text-3 mt-0.5 break-words">
                            {s.detail.length > 300 ? s.detail.slice(0, 300) + "…" : s.detail}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {reasoning && (
                <div className="whitespace-pre-wrap border-t border-visiyon-border/60 pt-2">
                  {reasoning}
                </div>
              )}
            </>
          ) : (
            <div>
              {isLive
                ? "Working on a reply — no searches, tools, or reasoning needed."
                : "Answered directly — no searches, tools, or reasoning used."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
