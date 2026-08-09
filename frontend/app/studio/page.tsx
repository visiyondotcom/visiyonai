"use client";

import { useRequireAuth } from "@/lib/useAuth";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  getStudioProject,
  saveStudioFiles,
  setStudioSubdomain,
  publishStudioProject,
  unpublishStudioProject,
  type StudioProject,
} from "@/lib/api";
import {
  ArrowLeft,
  FilePlus,
  Trash2,
  Save,
  Globe,
  Loader2,
  ExternalLink,
  Code2,
  Eye,
} from "lucide-react";

// Monaco touches `window`/`navigator` at import time, so it can only ever
// run in the browser — loading it during SSR would crash the Next.js
// server render.
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function languageForPath(path: string): string {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".json")) return "json";
  return "plaintext";
}

// Builds a single self-contained HTML document for the preview iframe:
// inlines any local <link rel="stylesheet" href="..."> and
// <script src="..."> the entry HTML references, using the in-editor
// content of that file instead of fetching it (so the preview always
// reflects unsaved edits, not just what's on disk).
function buildPreviewDoc(files: Record<string, string>, entryPath: string): string {
  let html = files[entryPath] ?? "";
  html = html.replace(
    /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href) => {
      const content = files[href.replace(/^\.\//, "")];
      return content !== undefined ? `<style>\n${content}\n</style>` : match;
    }
  );
  html = html.replace(
    /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    (match, src) => {
      const content = files[src.replace(/^\.\//, "")];
      return content !== undefined ? `<script>\n${content}\n</script>` : match;
    }
  );
  return html;
}

export default function StudioPage() {
  const { ready } = useRequireAuth();
  const [project, setProject] = useState<StudioProject | null>(null);
  const [activeFile, setActiveFile] = useState<string>("index.html");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [subdomainInput, setSubdomainInput] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Below `lg` the three columns (files / editor / preview) don't fit side
  // by side, so only one is shown at a time, switched via tabs.
  const [mobilePane, setMobilePane] = useState<"files" | "editor" | "preview">("editor");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getStudioProject().then(({ project }) => {
      setProject(project);
      setSubdomainInput(project.subdomain ?? "");
      const firstHtml = Object.keys(project.files).find((f) => f.endsWith(".html"));
      if (firstHtml) setActiveFile(firstHtml);
    });
  }, []);

  const fileNames = useMemo(() => (project ? Object.keys(project.files).sort() : []), [project]);
  const entryFile = useMemo(
    () => fileNames.find((f) => f === "index.html") ?? fileNames.find((f) => f.endsWith(".html")) ?? "",
    [fileNames]
  );
  const previewDoc = useMemo(
    () => (project && entryFile ? buildPreviewDoc(project.files, entryFile) : ""),
    [project, entryFile]
  );

  function scheduleSave(files: Record<string, string>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await saveStudioFiles(files);
        setSavedAt(new Date());
      } finally {
        setSaving(false);
      }
    }, 800); // debounced — saves shortly after typing stops, not on every keystroke
  }

  function updateFileContent(path: string, content: string) {
    setProject((prev) => {
      if (!prev) return prev;
      const files = { ...prev.files, [path]: content };
      scheduleSave(files);
      return { ...prev, files };
    });
  }

  function handleNewFile() {
    const name = window.prompt("File name (e.g. about.html or css/extra.css):");
    if (!name || !project) return;
    if (project.files[name] !== undefined) return;
    const files = { ...project.files, [name]: "" };
    setProject({ ...project, files });
    setActiveFile(name);
    scheduleSave(files);
  }

  function handleDeleteFile(path: string) {
    if (!project) return;
    if (!window.confirm(`Delete "${path}"?`)) return;
    const files = { ...project.files };
    delete files[path];
    setProject({ ...project, files });
    if (activeFile === path) {
      const next = Object.keys(files)[0];
      if (next) setActiveFile(next);
    }
    scheduleSave(files);
  }

  async function handleSetSubdomain() {
    setPublishError(null);
    try {
      const { project: updated } = await setStudioSubdomain(subdomainInput.trim().toLowerCase());
      setProject(updated);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Could not set subdomain");
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    try {
      if (project?.subdomain !== subdomainInput.trim().toLowerCase()) {
        await handleSetSubdomain();
      }
      const { project: updated } = await publishStudioProject();
      setProject(updated);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    const { project: updated } = await unpublishStudioProject();
    setProject(updated);
  }

  if (!ready || !project) return null;

  return (
    <div className="flex flex-col h-full bg-visiyon-bg text-visiyon-text">
      {/* Below `lg` the three columns don't fit side by side, so only one
          shows at a time, switched via these tabs. */}
      <div className="lg:hidden h-11 shrink-0 flex items-center border-b border-visiyon-border px-2 gap-1">
        <Link href="/" className="p-2 text-visiyon-text-2 hover:text-visiyon-text shrink-0">
          <ArrowLeft size={16} />
        </Link>
        {[
          { key: "files" as const, label: "Files", icon: FilePlus },
          { key: "editor" as const, label: "Editor", icon: Code2 },
          { key: "preview" as const, label: "Preview", icon: Eye },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setMobilePane(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium ${
              mobilePane === key ? "bg-white text-black" : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06]"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 min-h-0">
      {/* File tree */}
      <div className={`${mobilePane === "files" ? "flex" : "hidden"} lg:flex w-full lg:w-56 lg:shrink-0 border-r border-visiyon-border flex-col`}>
        <div className="hidden lg:block px-4 pt-4 pb-2">
          <Link href="/" className="flex items-center gap-1.5 text-[13px] text-visiyon-text-2 hover:text-visiyon-text">
            <ArrowLeft size={14} /> Back to chat
          </Link>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-visiyon-text-2 uppercase tracking-wide">Files</span>
          <button onClick={handleNewFile} title="New file" className="text-visiyon-text-2 hover:text-visiyon-text p-1">
            <FilePlus size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 space-y-0.5">
          {fileNames.map((name) => (
            <div
              key={name}
              className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm cursor-pointer ${
                activeFile === name ? "bg-visiyon-text/10 text-visiyon-text" : "text-visiyon-text-2 hover:bg-visiyon-text/[0.06]"
              }`}
              onClick={() => {
                setActiveFile(name);
                setMobilePane("editor");
              }}
            >
              <span className="truncate">{name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteFile(name);
                }}
                className="opacity-0 group-hover:opacity-100 text-visiyon-text-2 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="px-3 py-2 text-[11px] text-visiyon-text-2 flex items-center gap-1.5">
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Saving...
            </>
          ) : savedAt ? (
            <>
              <Save size={12} /> Saved {savedAt.toLocaleTimeString("en-US")}
            </>
          ) : null}
        </div>
      </div>

      {/* Editor */}
      <div className={`${mobilePane === "editor" ? "flex" : "hidden"} lg:flex flex-1 min-w-0 flex-col`}>
        <div className="h-10 border-b border-visiyon-border flex items-center px-4 text-sm text-visiyon-text-2">
          {activeFile}
        </div>
        <div className="flex-1 min-h-0">
          <MonacoEditor
            key={activeFile}
            height="100%"
            theme="vs-dark"
            path={activeFile}
            language={languageForPath(activeFile)}
            value={project.files[activeFile] ?? ""}
            onChange={(value) => updateFileContent(activeFile, value ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
          />
        </div>
      </div>

      {/* Preview + publish */}
      <div className={`${mobilePane === "preview" ? "flex" : "hidden"} lg:flex w-full lg:w-[38%] lg:min-w-[320px] border-l border-visiyon-border flex-col`}>
        <div className="h-10 border-b border-visiyon-border flex items-center px-4 text-sm text-visiyon-text-2">
          Preview
        </div>
        <div className="flex-1 min-h-0 bg-white">
          <iframe title="preview" className="w-full h-full" sandbox="allow-scripts" srcDoc={previewDoc} />
        </div>
        <div className="border-t border-visiyon-border p-4 space-y-3">
          <div>
            <label className="text-xs text-visiyon-text-2 block mb-1">Subdomain</label>
            <div className="flex items-center gap-1.5">
              <input
                value={subdomainInput}
                onChange={(e) => setSubdomainInput(e.target.value)}
                placeholder="mysite"
                className="flex-1 min-w-0 bg-visiyon-text/[0.06] rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-white/30"
              />
              <span className="text-xs text-visiyon-text-2 whitespace-nowrap">.visiyon.com</span>
            </div>
          </div>
          {publishError && <p className="text-xs text-red-400">{publishError}</p>}
          <button
            onClick={handlePublish}
            disabled={publishing || !subdomainInput.trim()}
            className="w-full flex items-center justify-center gap-2 text-sm font-medium px-3 py-2 rounded-xl bg-white text-black hover:bg-visiyon-text/90 disabled:opacity-50 transition-colors"
          >
            {publishing ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />}
            Publish
          </button>
          {project.publishedAt && project.subdomain && (
            <div className="flex items-center justify-between text-xs text-visiyon-text-2">
              <a
                href={`https://${project.subdomain}.visiyon.com`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 hover:text-visiyon-text"
              >
                {project.subdomain}.visiyon.com <ExternalLink size={11} />
              </a>
              <button onClick={handleUnpublish} className="hover:text-red-400">
                Unpublish
              </button>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
