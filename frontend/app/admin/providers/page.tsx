"use client";

import { askConfirm } from "@/components/PromptDialog";
import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  AiProvider,
  AiProviderType,
} from "@/lib/api";
import { Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle, Power } from "lucide-react";

const TYPE_LABELS: Record<AiProviderType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  openai_compatible: "OpenAI-compatible (custom)",
};

// Any OpenAI/Anthropic-compatible service can be plugged in this way —
// Groq, Mistral, OpenRouter, Azure OpenAI, together.ai, a local
// vLLM/LM Studio server, etc. — by picking "OpenAI-compatible" and
// pointing baseUrl at its endpoint.
export default function AdminProvidersPage() {
  const ready = useRequireAdmin();
  const [providers, setProviders] = useState<AiProvider[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-provider form state
  const [name, setName] = useState("");
  const [type, setType] = useState<AiProviderType>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const { providers } = await listProviders();
      setProviders(providers);
    } catch {
      setError("Could not reach the server — the database migration may still need to run.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setName("");
    setType("openai");
    setBaseUrl("");
    setApiKey("");
    setModelsText("");
    setCreating(false);
  }

  async function handleCreate() {
    if (!name.trim() || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createProvider({
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim(),
        models: modelsText
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      });
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(p: AiProvider) {
    await updateProvider(p.id, { enabled: !p.enabled });
    await refresh();
  }

  async function handleTest(p: AiProvider) {
    setTesting(p.id);
    try {
      await testProvider(p.id);
      await refresh();
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(p: AiProvider) {
    if (
      !(await askConfirm({
        title: `Remove provider "${p.name}"? Chats using its models will no longer be able to complete.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    await deleteProvider(p.id);
    await refresh();
  }

  if (!ready) return null;

  return (
    <div className="h-full overflow-y-auto px-6 py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="max-w-3xl pb-24">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold">AI Providers</h2>
            {!creating && (
              <button
                onClick={() => setCreating(true)}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] bg-white text-black hover:opacity-90 transition-opacity"
              >
                <Plus size={14} /> Add provider
              </button>
            )}
          </div>
          <p className="text-[13px] text-visiyon-text-3 mb-6">
            Connect OpenAI, Anthropic/Claude, or any OpenAI-compatible endpoint (Groq, Mistral,
            OpenRouter, Azure OpenAI, a local vLLM/LM Studio server, ...). Enabled models show up
            in the model picker alongside your local Ollama models.
          </p>

          {error && (
            <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5">
              {error}
            </div>
          )}

          {creating && (
            <div className="border border-visiyon-border rounded-[6px] p-4 mb-6 space-y-2.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={'Name (e.g. "OpenAI production")'}
                className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
              <select
                value={type}
                onChange={(e) => setType(e.target.value as AiProviderType)}
                className="w-full appearance-none bg-transparent text-visiyon-text text-[13px] border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text cursor-pointer"
              >
                {(Object.keys(TYPE_LABELS) as AiProviderType[]).map((t) => (
                  <option key={t} value={t} className="bg-visiyon-panel">
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              {type === "openai_compatible" && (
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
                  className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                />
              )}
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder="API key"
                className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
              />
              <input
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder="Model names, comma-separated (e.g. gpt-4o, gpt-4o-mini) — or leave blank and use Test to auto-fill"
                className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
              />
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleCreate}
                  disabled={saving || !name.trim() || !apiKey.trim()}
                  className="flex-1 text-[13px] font-medium py-1.5 rounded-[6px] bg-white text-black disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={resetForm}
                  className="text-[13px] px-3 py-1.5 rounded-[6px] border border-visiyon-border text-visiyon-text-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!providers ? (
            <p className="text-sm text-visiyon-text-3">Loading…</p>
          ) : providers.length === 0 ? (
            <p className="text-sm text-visiyon-text-3">No providers configured yet.</p>
          ) : (
            <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
              {providers.map((p) => (
                <div key={p.id} className="px-4 py-3.5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[13.5px]">
                        <span className={p.enabled ? "" : "text-visiyon-text-3"}>{p.name}</span>
                        <span className="text-[11px] text-visiyon-text-3 border border-visiyon-border rounded-full px-2 py-0.5">
                          {TYPE_LABELS[p.type]}
                        </span>
                        {p.lastTestError ? (
                          <AlertCircle size={13} className="text-red-400 shrink-0" />
                        ) : p.lastTestedAt ? (
                          <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                        ) : null}
                      </div>
                      <div className="text-[11px] text-visiyon-text-3 font-mono mt-0.5">
                        {p.apiKeyPreview}
                        {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                      </div>
                      {p.models.length > 0 && (
                        <div className="text-[11.5px] text-visiyon-text-3 mt-1 truncate">
                          {p.models.join(", ")}
                        </div>
                      )}
                      {p.lastTestError && (
                        <div className="text-[11.5px] text-red-400 mt-1">{p.lastTestError}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTest(p)}
                        disabled={testing === p.id}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-visiyon-text disabled:opacity-40"
                        title="Test connection"
                      >
                        <RefreshCw size={14} className={testing === p.id ? "animate-spin" : ""} />
                      </button>
                      <button
                        onClick={() => handleToggle(p)}
                        className={`p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] ${
                          p.enabled ? "text-visiyon-text-2" : "text-visiyon-text-3"
                        }`}
                        title={p.enabled ? "Disable" : "Enable"}
                      >
                        <Power size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        className="p-1.5 rounded-[6px] hover:bg-visiyon-text/[0.06] text-visiyon-text-3 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
