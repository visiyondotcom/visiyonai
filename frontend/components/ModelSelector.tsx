"use client";

import { useEffect, useRef, useState } from "react";
import { listModels } from "@/lib/api";
import { ChevronDown, Zap } from "lucide-react";

export default function ModelSelector({
  value,
  onChange,
  compact = false,
  dropUp = false,
}: {
  value: string;
  onChange: (model: string) => void;
  compact?: boolean;
  dropUp?: boolean;
}) {
  const [models, setModels] = useState<{ name: string; parameterSize?: string; family?: string; displayName?: string }[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        if (!value && m.length) onChange(m[0].name);
      })
      .catch(() => setModels([]));
  }, []);

  // This dropdown previously had no outside-click handling at all — it
  // only closed when you picked an option. A document-level listener
  // (rather than a "fixed inset-0" overlay) is used so it keeps working
  // regardless of any transform/backdrop-filter ancestor.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const selected = models.find((m) => m.name === value);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 font-medium rounded-lg hover:bg-visiyon-text/10 transition-colors max-w-[60vw] ${
          compact ? "text-[12.5px] px-2.5 py-1.5 text-visiyon-text-2 hover:text-visiyon-text" : "text-sm px-3 py-1.5"
        }`}
      >
        {selected?.family === "pipe" && <Zap size={13} className="text-visiyon-accent shrink-0" />}
        <span className="truncate">{selected?.displayName || value || "Select model"}</span>
        <ChevronDown size={compact ? 12 : 14} className="shrink-0" />
      </button>
      {open && (
        <div
          className={`menu-popup absolute left-0 w-max min-w-[9rem] max-w-[92vw] border border-visiyon-border bg-visiyon-bg rounded-xl overflow-hidden z-20 ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {models.length === 0 && (
            <div className="px-3 py-3 text-[13px] text-visiyon-text-3">
              No models found — run <code>ollama pull glm4:9b</code> on the server.
            </div>
          )}
          {models.map((m) => (
            <button
              key={m.name}
              onClick={() => {
                onChange(m.name);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2.5 text-[13.5px] hover:bg-visiyon-text/[0.06] flex items-center gap-2 min-w-0"
            >
              <span className="flex items-center gap-1.5 truncate min-w-0">
                {m.family === "pipe" && <Zap size={12} className="text-visiyon-accent shrink-0" />}
                {m.displayName || m.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
