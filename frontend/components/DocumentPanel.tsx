"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

import { useEffect, useRef, useState } from "react";
import {
  listDocuments,
  uploadDocument,
  deleteDocument,
  attachDocument,
  detachDocument,
  DocumentSummary,
} from "@/lib/api";
import { Paperclip, X, FileText, Loader2, CheckCircle2, XCircle, Trash2 } from "lucide-react";

function statusIcon(status: DocumentSummary["status"]) {
  switch (status) {
    case "READY":
      return <CheckCircle2 size={13} className="text-emerald-400" />;
    case "FAILED":
      return <XCircle size={13} className="text-red-400" />;
    default:
      return <Loader2 size={13} className="animate-spin text-visiyon-text-3" />;
  }
}

export default function DocumentPanel({
  chatId,
  ensureChatId,
  attachedIds,
  onAttachedChange,
  asMenuItem,
  onOpened,
  onClosed,
}: {
  chatId?: string;
  // Creates the chat on first use and returns its id — lets a document be
  // attached even before any message has been sent, instead of requiring
  // "send a message first".
  ensureChatId: () => Promise<string>;
  attachedIds: string[];
  onAttachedChange: (ids: string[]) => void;
  // Rendered as a full-width labelled row inside the "+" dropdown instead
  // of the icon-only circular button used elsewhere.
  asMenuItem?: boolean;
  // Called right when this panel's own popover opens, so the parent "+"
  // dropdown can close itself and hand off to this one.
  onOpened?: () => void;
  // Called when this panel's own popover closes, so the parent "+" dropdown
  // can hand control back and show the other menu items again.
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      setDocs(await listDocuments());
    } catch {
      /* not logged in yet */
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  // Poll while any document is still processing so status flips to READY live.
  useEffect(() => {
    if (!open) return;
    const hasPending = docs.some((d) => d.status === "PENDING" || d.status === "PROCESSING");
    if (!hasPending) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [docs, open]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const doc = await uploadDocument(file);
        setDocs((prev) => [doc, ...prev]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function toggleAttach(doc: DocumentSummary) {
    const isAttached = attachedIds.includes(doc.id);
    if (isAttached) {
      const id = chatId ?? (await ensureChatId());
      await detachDocument(id, doc.id);
      onAttachedChange(attachedIds.filter((id) => id !== doc.id));
    } else {
      const id = await ensureChatId();
      await attachDocument(id, doc.id);
      onAttachedChange([...attachedIds, doc.id]);
    }
  }

  return (
    <div className="relative">
      {asMenuItem ? (
        <button
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onOpened?.();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
        >
          <Paperclip size={15} /> Documents{attachedIds.length > 0 ? ` (${attachedIds.length})` : ""}
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 p-2.5 rounded-xl border transition-colors ${
            attachedIds.length > 0 ? "border-visiyon-text text-visiyon-text" : "border-visiyon-border text-visiyon-text-2"
          }`}
          title="Attach documents"
        >
          <Paperclip size={16} />
          {attachedIds.length > 0 && <span className="text-[11px] font-medium">{attachedIds.length}</span>}
        </button>
      )}

      {open && (
        <div
          className={`menu-popup absolute w-80 max-h-[70vh] overflow-y-auto z-30 bg-visiyon-bg rounded-2xl shadow-2xl ${
            asMenuItem ? "bottom-0 left-0" : "bottom-full left-0 mb-2"
          }`}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13.5px] font-medium">Documents</span>
            <button
              onClick={() => {
                setOpen(false);
                onClosed?.();
              }}
              className="text-visiyon-text-3 hover:text-visiyon-text"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-3 border-b border-visiyon-border">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full text-[13px] font-medium py-2 rounded-xl border border-dashed border-visiyon-border hover:border-visiyon-text transition-colors disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "+ Upload PDF, DOCX, TXT, MD, CSV"}
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {docs.length === 0 && (
              <p className="text-[12.5px] text-visiyon-text-3 px-4 py-4">No documents uploaded yet.</p>
            )}
            {docs.map((d) => {
              const attached = attachedIds.includes(d.id);
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-visiyon-text/[0.04] group"
                >
                  <FileText size={14} className="text-visiyon-text-3 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate">{d.filename}</div>
                    <div className="flex items-center gap-1 text-[11px] text-visiyon-text-3">
                      {statusIcon(d.status)}
                      {d.status === "FAILED" ? d.error || "Failed" : d.status.toLowerCase()}
                    </div>
                  </div>
                  {d.status === "READY" && (
                    <button
                      onClick={() => toggleAttach(d)}
                      className={`text-[11px] px-2 py-1 rounded-full border shrink-0 transition-colors ${
                        attached
                          ? "bg-white text-black border-visiyon-text"
                          : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                      }`}
                    >
                      {attached ? "Attached" : "Attach"}
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete "${d.filename}"?`, confirmLabel: "Delete", danger: true })) {
                        await deleteDocument(d.id);
                        setDocs((prev) => prev.filter((x) => x.id !== d.id));
                        onAttachedChange(attachedIds.filter((id) => id !== d.id));
                      }
                    }}
                    className="hidden group-hover:block text-visiyon-text-3 hover:text-red-400 shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
