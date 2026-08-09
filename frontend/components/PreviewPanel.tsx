"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Download, RefreshCw, Pencil, Eye } from "lucide-react";
import { useChatStore, type PreviewBlocks } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";

// Combines whichever html/css/js blocks the current message has produced
// so far into a single renderable document — an html block with a
// separate css and/or js block for the same site is merged into one page
// (css injected into <head>, js injected before </body>) instead of each
// new block replacing the previous one wholesale, which used to make the
// preview flash to "just the css" or go blank as soon as a second block
// appeared after the html block.
function buildCombinedDoc(blocks: PreviewBlocks): string {
  if (blocks.html) {
    let doc = blocks.html;
    if (blocks.css) {
      const styleTag = `<style>${blocks.css}</style>`;
      doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, `${styleTag}</head>`) : styleTag + doc;
    }
    if (blocks.js) {
      const scriptTag = `<script>${blocks.js}</script>`;
      doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${scriptTag}</body>`) : doc + scriptTag;
    }
    return doc;
  }
  // No html block yet (still streaming, or the AI only produced css/js) —
  // fall back to a minimal shell so there's still something to look at.
  if (blocks.css) {
    return `<!doctype html><html><head><style>${blocks.css}</style></head><body><p style="font-family:sans-serif;color:#888;padding:12px">CSS preview — add HTML to see it applied to real elements.</p></body></html>`;
  }
  if (blocks.js) {
    return `<!doctype html><html><head></head><body><script>${blocks.js}</script></body></html>`;
  }
  return "";
}

const SLOT_LABELS: Record<"html" | "css" | "js", string> = {
  html: "index.html",
  css: "style.css",
  js: "script.js",
};

export default function PreviewPanel() {
  const { previewOpen, previewBlocks, previewFileName, previewMessageId, closePreview, updatePreviewBlock } =
    useChatStore(
      useShallow((s) => ({
        previewOpen: s.previewOpen,
        previewBlocks: s.previewBlocks,
        previewFileName: s.previewFileName,
        previewMessageId: s.previewMessageId,
        closePreview: s.closePreview,
        updatePreviewBlock: s.updatePreviewBlock,
      }))
    );

  // "preview" = the live rendered iframe (default); "edit" = raw source,
  // one tab per slot the current message actually produced (html/css/js).
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const availableSlots = useMemo(
    () => (["html", "css", "js"] as const).filter((slot) => previewBlocks[slot] != null),
    [previewBlocks]
  );
  const [activeSlot, setActiveSlot] = useState<"html" | "css" | "js">("html");
  const [draft, setDraft] = useState("");

  // Switching message or leaving edit mode resets which slot is being
  // edited to whichever the panel is currently titled after.
  useEffect(() => {
    if (availableSlots.length === 0) return;
    if (!availableSlots.includes(activeSlot)) setActiveSlot(availableSlots[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSlots]);

  useEffect(() => {
    setDraft(previewBlocks[activeSlot] ?? "");
  }, [activeSlot, previewMessageId]);

  // Re-syncs the draft with the live block's content when entering edit
  // mode, so a person editing right after new streamed content lands sees
  // the latest code rather than a stale snapshot from an earlier open.
  function enterEditMode() {
    setDraft(previewBlocks[activeSlot] ?? "");
    setMode("edit");
  }

  function applyEditsAndPreview() {
    updatePreviewBlock(activeSlot, draft);
    setMode("preview");
  }

  const doc = useMemo(() => buildCombinedDoc(previewBlocks), [previewBlocks]);
  // Changing the iframe key forces a full remount = a clean re-render,
  // which is what "refresh" should do for a sandboxed live preview.
  const iframeKey = useMemo(() => previewMessageId + ":" + doc.length, [previewMessageId, doc]);

  function download() {
    const blob = new Blob([doc], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = previewFileName || "index.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (!previewOpen) return null;

  return (
    <div className="hidden lg:flex flex-col w-[45%] max-w-[720px] min-w-[360px] h-full bg-visiyon-bg">
      <div className="h-16 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-visiyon-text font-medium truncate">
            {mode === "edit" ? SLOT_LABELS[activeSlot] : previewFileName}
          </span>
          <span className="text-[11px] text-visiyon-text-3 shrink-0 uppercase">
            {mode === "edit"
              ? activeSlot
              : previewFileName.endsWith(".css")
              ? "css"
              : previewFileName.endsWith(".js")
              ? "js"
              : "html"}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {mode === "preview" ? (
            <>
              <button
                key={"refresh-" + iframeKey}
                onClick={() => {
                  /* remount handled by iframe key changing on new code; this
                     button re-forces it even when the code hasn't changed */
                }}
                className="flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                title="Refresh preview"
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={enterEditMode}
                className="flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
                title="Edit code"
              >
                <Pencil size={14} />
              </button>
            </>
          ) : (
            <button
              onClick={applyEditsAndPreview}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium bg-white text-black hover:bg-visiyon-text/85 transition-colors"
              title="Apply edits and show preview"
            >
              <Eye size={13} /> Preview
            </button>
          )}
          <button
            onClick={download}
            className="flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
            title={`Download ${previewFileName}`}
          >
            <Download size={14} />
          </button>
          <button
            onClick={closePreview}
            className="flex items-center justify-center h-8 w-8 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/10 hover:text-visiyon-text transition-colors"
            title="Close preview"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {mode === "edit" && availableSlots.length > 1 && (
        <div className="flex items-center gap-1 px-4 pb-2 shrink-0">
          {availableSlots.map((slot) => (
            <button
              key={slot}
              onClick={() => setActiveSlot(slot)}
              className={`text-[11.5px] px-2.5 py-1 rounded-md transition-colors ${
                activeSlot === slot
                  ? "bg-visiyon-text/15 text-visiyon-text"
                  : "text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/5"
              }`}
            >
              {SLOT_LABELS[slot]}
            </button>
          ))}
        </div>
      )}

      {mode === "preview" ? (
        <div className="flex-1 bg-white">
          <iframe
            key={iframeKey}
            srcDoc={doc}
            title="Live preview"
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="w-full h-full border-0"
          />
        </div>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full bg-[#0d0d0d] text-white/90 text-[13px] leading-relaxed font-mono outline-none resize-none px-4 py-3"
        />
      )}
    </div>
  );
}
