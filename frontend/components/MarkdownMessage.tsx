"use client";

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import "katex/dist/katex.min.css";
import { Download, Eye, Pencil, Code2, Loader2, FileText, Play, Terminal } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { useChatStore } from "@/lib/store";
import { useRouter } from "next/navigation";
import { getStudioProject, saveStudioFiles, runPythonSnippet } from "@/lib/api";
import { GENERATED_FILE_DRAG_MIME } from "@/lib/api";

// Languages the "Run" button executes in the sandbox (see
// backend/src/routes/tools.ts POST /tools/run-python). Deliberately just
// python for now — that's the only language the sandbox executor image
// (sandbox-runner/executor/, python:3.12-slim) can actually run.
const RUNNABLE_LANGUAGES = new Set(["python", "py"]);

// Languages the right-side live preview panel knows how to render.
const PREVIEWABLE_LANGUAGES: Record<string, string> = {
  html: "index.html",
  css: "style.css",
  js: "script.js",
  javascript: "script.js",
};

function downloadCode(value: string, fileName: string) {
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadImage(dataUrl: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `visiyon-image-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Wraps a generated image with a hover overlay offering Download (always)
// and Edit (when the prompt that produced it is known — re-fills the
// composer so the user can tweak and regenerate).
function GeneratedImage({
  src,
  alt,
  imagePrompt,
  onEditImage,
  onOpenImage,
}: {
  src: string;
  alt?: string;
  imagePrompt?: string;
  onEditImage?: (prompt: string) => void;
  onOpenImage?: (src: string, alt: string | undefined, prompt: string | undefined) => void;
}) {
  return (
    <span className="relative inline-block group my-1 max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || "Generated image"}
        role={onOpenImage ? "button" : undefined}
        tabIndex={onOpenImage ? 0 : undefined}
        onClick={onOpenImage ? () => onOpenImage(src, alt, imagePrompt) : undefined}
        onKeyDown={
          onOpenImage
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenImage(src, alt, imagePrompt);
                }
              }
            : undefined
        }
        className={`rounded-lg max-w-full block ${onOpenImage ? "cursor-zoom-in" : ""}`}
      />
      <span data-pdf-exclude className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            downloadImage(src);
          }}
          title="Download"
          className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-visiyon-text backdrop-blur-sm"
        >
          <Download size={14} />
        </button>
        {onEditImage && imagePrompt && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditImage(imagePrompt);
            }}
            title="Edit prompt & regenerate"
            className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-visiyon-text backdrop-blur-sm"
          >
            <Pencil size={14} />
          </button>
        )}
      </span>
    </span>
  );
}

// Extracts the {token} the create_file tool encodes in the download link
// (see BUILTIN_HANDLERS.create_file in backend/src/lib/tools.ts:
// `[safeName](/api/files/token)`) regardless of whether it's served via
// /api/files or bare /files.
function parseGeneratedFileHref(href: string): { token: string } | null {
  const match = href.match(/\/files\/([a-f0-9-]{36})(?:\?|$)/i);
  return match ? { token: match[1] } : null;
}

// Renders a generated-file download link as a small draggable chip instead
// of a plain text link — clicking it still downloads as before, but it can
// also be dragged onto the connected-server file browser panel (see
// ServerFilesPanel) to save it directly there instead.
function GeneratedFileChip({ href, token, label }: { href: string; token: string; label: string }) {
  const [dragging, setDragging] = useState(false);
  return (
    <a
      href={href}
      download
      draggable
      onDragStart={(e) => {
        setDragging(true);
        e.dataTransfer.setData(GENERATED_FILE_DRAG_MIME, JSON.stringify({ token, filename: label }));
        e.dataTransfer.setData("text/plain", label);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={() => setDragging(false)}
      className={`inline-flex items-center gap-1.5 my-0.5 px-2.5 py-1.5 rounded-lg border border-visiyon-border bg-visiyon-text/[0.04] hover:bg-visiyon-text/[0.08] text-[13px] no-underline cursor-grab active:cursor-grabbing transition-opacity ${
        dragging ? "opacity-40" : ""
      }`}
      title="Click to download, or drag onto the server files panel to save it there"
    >
      <FileText size={14} className="text-visiyon-text-3 shrink-0" />
      {label}
    </a>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    import("mermaid").then(async (mermaid) => {
      mermaid.default.initialize({ startOnLoad: false, theme: "dark" });
      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.default.render(id, code);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setSvg("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!svg) return <pre className="text-xs text-visiyon-text-2">{code}</pre>;
  return <div ref={ref} className="my-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlock({
  language,
  value,
  isStreaming,
  messageId,
}: {
  language: string;
  value: string;
  isStreaming?: boolean;
  messageId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ stdout: string; stderr: string; error: string | null } | null>(null);
  const openPreview = useChatStore((s) => s.openPreview);
  const router = useRouter();
  const previewFileName = PREVIEWABLE_LANGUAGES[language];
  const isRunnable = RUNNABLE_LANGUAGES.has(language.toLowerCase());

  // Executes this exact block's code in the isolated sandbox (same
  // container isolation as the run_python tool the AI itself can call —
  // no network, read-only fs, ~8s limit) and shows stdout/stderr inline
  // below the block, terminal-style. One run at a time per block; a new
  // click while one is in flight is a no-op rather than queuing another.
  async function handleRun() {
    if (running) return;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await runPythonSnippet(value);
      setRunResult({ stdout: result.stdout, stderr: result.stderr, error: result.error });
    } catch (err) {
      setRunResult({ stdout: "", stderr: "", error: err instanceof Error ? err.message : "Failed to run script" });
    } finally {
      setRunning(false);
    }
  }

  // Sends this block straight into the user's Studio project (as the file
  // its language maps to — html -> index.html, css -> style.css, js ->
  // script.js — same mapping the right-side preview panel already uses),
  // then jumps to the Studio editor so the result is immediately visible
  // there instead of the user having to copy/paste it in by hand.
  async function handleImportToStudio() {
    if (!previewFileName || importing) return;
    setImporting(true);
    try {
      const { project } = await getStudioProject();
      const files = { ...project.files, [previewFileName]: value };
      await saveStudioFiles(files);
      setImported(true);
      setTimeout(() => setImported(false), 1500);
      router.push("/studio");
    } finally {
      setImporting(false);
    }
  }

  // Auto-open the right-side live preview as soon as a renderable block
  // (html/css/js) appears, then keep pushing updated content in on a
  // throttle (not per-token — that would re-render the iframe's srcDoc
  // on every single token, which is exactly the kind of per-token cost
  // the streaming perf fix above avoids for the chat itself) so the
  // preview keeps visibly catching up while the AI is still generating,
  // instead of opening once and then sitting frozen until the whole
  // block finishes.
  const openedRef = useRef(false);
  const lastPushedLenRef = useRef(0);
  useEffect(() => {
    if (!previewFileName) return;
    if (!openedRef.current) {
      openedRef.current = true;
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
      return;
    }
    if (!isStreaming) {
      // Final push once generation finishes, so the last partial chunk
      // (since the last throttled update) always makes it in.
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
      return;
    }
    // While streaming: only push again once enough new content has come
    // in since the last push, so updates stay throttled instead of firing
    // on every token.
    if (value.length - lastPushedLenRef.current < 40) return;
    const t = setTimeout(() => {
      lastPushedLenRef.current = value.length;
      openPreview(messageId, language, value);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isStreaming]);

  if (language === "mermaid") return <MermaidBlock code={value} />;

  // While a message is still streaming, the code block grows by one token
  // at a time. Re-running Prism's full tokenizer on every token makes each
  // update cost O(block length), so a long block streaming in becomes
  // O(n²) overall and the UI visibly stalls. Render plain, unhighlighted
  // text during the live phase — cheap regardless of length — and only
  // pay for syntax highlighting once, after the message finishes.
  if (isStreaming) {
    return (
      <div className="relative group">
        <pre className="text-[13.5px] leading-relaxed overflow-x-auto">
          <code>{value}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="relative group">
      <div data-pdf-exclude className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isRunnable && (
          <button
            onClick={handleRun}
            disabled={running}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors disabled:opacity-60"
            title="Run this script"
          >
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            Run
          </button>
        )}
        {previewFileName && (
          <button
            onClick={() => openPreview(messageId, language, value)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
            title="Show preview"
          >
            <Eye size={11} /> Preview
          </button>
        )}
        {previewFileName && (
          <button
            onClick={handleImportToStudio}
            disabled={importing}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors disabled:opacity-60"
            title={`Send to Studio as ${previewFileName}`}
          >
            {importing ? <Loader2 size={11} className="animate-spin" /> : <Code2 size={11} />}
            {imported ? "Sent" : "Studio"}
          </button>
        )}
        <button
          onClick={() => downloadCode(value, previewFileName || `snippet.${language || "txt"}`)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
          title={`Download as ${previewFileName || `snippet.${language || "txt"}`}`}
        >
          <Download size={11} />
        </button>
        <button
          onClick={() => {
            copyToClipboard(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-[11px] px-2 py-1 rounded-md bg-visiyon-text/10 hover:bg-visiyon-text/20 transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{ background: "transparent", fontSize: 13.5, padding: 0, margin: 0 }}
        codeTagProps={{ style: { background: "transparent" } }}
      >
        {value}
      </SyntaxHighlighter>
      {isRunnable && (running || runResult) && (
        <div className="mt-2 rounded-lg border border-visiyon-border bg-black/40 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-visiyon-text-2 border-b border-visiyon-border">
            <Terminal size={11} />
            Output
          </div>
          <div className="px-3 py-2 text-[13px] font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto">
            {running && !runResult && <span className="text-visiyon-text-2">Running…</span>}
            {runResult?.stdout && <div>{runResult.stdout}</div>}
            {runResult?.stderr && <div className="text-red-400">{runResult.stderr}</div>}
            {runResult?.error && !runResult.stdout && !runResult.stderr && (
              <div className="text-red-400">{runResult.error}</div>
            )}
            {runResult && !runResult.stdout && !runResult.stderr && !runResult.error && (
              <span className="text-visiyon-text-2">(no output)</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarkdownMessage({
  content,
  isStreaming,
  messageId,
  imagePrompt,
  onEditImage,
  onOpenImage,
}: {
  content: string;
  isStreaming?: boolean;
  messageId: string;
  // The user prompt that produced a generated image in this message, if
  // any — enables the "Edit" button on the image overlay.
  imagePrompt?: string;
  onEditImage?: (prompt: string) => void;
  // Opens the fullscreen viewer (see ImageLightbox) for a generated image.
  onOpenImage?: (src: string, alt: string | undefined, prompt: string | undefined) => void;
}) {
  return (
    <div className="prose-visiyon">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        // react-markdown's default URL sanitizer only allows a fixed list of
        // safe schemes (http, https, mailto, ...) and silently strips
        // anything else — including data: URIs. Generated images are
        // embedded as `![Generated image](data:image/png;base64,...)`
        // (see backend/src/routes/images.ts), so without this override the
        // <img> tag ends up with no src at all and just shows a broken
        // image icon. Keep the default behavior for every other URL type,
        // only special-case data:image/*.
        urlTransform={(url) => (url.startsWith("data:image/") ? url : defaultUrlTransform(url))}
        components={{
          img({ src, alt }) {
            if (!src || typeof src !== "string") return null;
            return (
              <GeneratedImage src={src} alt={alt} imagePrompt={imagePrompt} onEditImage={onEditImage} onOpenImage={onOpenImage} />
            );
          },
          a({ href, children }) {
            const parsed = href && typeof href === "string" ? parseGeneratedFileHref(href) : null;
            if (parsed) {
              const firstChild = React.Children.toArray(children)[0];
              const label = typeof firstChild === "string" ? firstChild : parsed.token;
              return <GeneratedFileChip href={href!} token={parsed.token} label={label} />;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = Boolean(match);
            if (!isBlock) {
              return (
                <code className="bg-visiyon-text/[0.08] px-1.5 py-0.5 rounded text-[13px]" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock
                language={match![1]}
                value={String(children).replace(/\n$/, "")}
                isStreaming={isStreaming}
                messageId={messageId}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
