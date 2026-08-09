"use client";

import { askConfirm, askPrompt } from "@/components/PromptDialog";

// Mirrors the embedding-model detection used elsewhere (see
// EMBEDDING_NAME_PATTERN in backend/src/routes/models.ts and
// frontend/app/admin/models/page.tsx) — filters these out of this
// dashboard's "Installed models" badge list specifically, since it's just
// an informational summary and embedding models (nomic-embed-text, etc.)
// aren't chat models a user would pick. The Pull/Delete Models page keeps
// showing every installed model, embeddings included, since managing them
// (deleting, re-pulling) is exactly what that page is for.
const EMBEDDING_NAME_PATTERN = /nomic-embed|embed|bge-|minilm|e5-|gte-/i;

import { useRequireAdmin } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import AnalyticsPanel from "@/components/AnalyticsPanel";
import { apiFetch, listGroups, createGroup, updateGroup, deleteGroup, Group, getPublicConfig, adminSetSignupEnabled, SystemStats } from "@/lib/api";
import {
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
  listFlaggedMessages,
  listLogs,
  clearLogs,
  Pipeline,
  FlaggedMessage,
  LogEntry,
  adminListWebhooks,
  adminCreateWebhook,
  adminUpdateWebhook,
  adminRotateWebhookSecret,
  adminDeleteWebhook,
  adminListWebhookDeliveries,
  adminClearWebhookDeliveries,
  adminCleanupWebhookDeliveries,
  adminCleanupQuotaUsage,
  WebhookDelivery,
  listSecurityAlerts,
  updateSecurityAlert,
  SecurityAlert,
} from "@/lib/api";
import { Plus, Trash2, X, RefreshCw, Webhook as WebhookIcon, KeyRound, ChevronDown, ChevronUp } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: string;
}

interface Stats {
  userCount: number;
  chatCount: number;
  messageCount: number;
  ollamaUp: boolean;
}
interface User {
  id: string;
  email: string;
  name?: string;
  role: "USER" | "ADMIN";
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  createdAt: string;
  lastActiveAt?: string | null;
}

function timeAgoOrDate(iso?: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "a few seconds ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// Color follows the % used, same red/yellow/white thresholds across
// CPU/RAM/disk/GPU so a glance at the dashboard tells you what needs
// attention without reading the numbers.
function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 75) return "bg-yellow-500";
  return "bg-white";
}

function UsageBar({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  return (
    <div className="rounded-[6px] p-4 border border-visiyon-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12.5px] text-visiyon-text-3">{label}</span>
        <span className="text-[12.5px] font-medium">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-visiyon-text/10 overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all ${barColor(pct)}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="text-[11.5px] text-visiyon-text-3">{detail}</div>
    </div>
  );
}

export default function AdminPage() {
  const ready = useRequireAdmin();
  const [stats, setStats] = useState<Stats | null>(null);
  const [signupEnabled, setSignupEnabled] = useState(true);
  const [health, setHealth] = useState<{
    ollama: { up: boolean; models: string[] };
    searxng?: { up: boolean };
    system?: SystemStats;
  } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [flagged, setFlagged] = useState<FlaggedMessage[]>([]);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([]);
  const [securityFilter, setSecurityFilter] = useState<"" | "OPEN" | "DISMISSED" | "ACTIONED">("OPEN");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevelFilter, setLogLevelFilter] = useState<string>("");

  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [availableEvents, setAvailableEvents] = useState<string[]>([]);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [expandedWebhookId, setExpandedWebhookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [quotaCleanupMsg, setQuotaCleanupMsg] = useState<string | null>(null);

  const [newRule, setNewRule] = useState({
    name: "",
    stage: "PRE" as "PRE" | "POST",
    matchType: "KEYWORD" as "KEYWORD" | "REGEX" | "AI",
    pattern: "",
    action: "FLAG" as "BLOCK" | "FLAG",
    message: "This message was blocked by a moderation rule.",
    order: 0,
  });

  function refreshPipelines() {
    listPipelines().then(setPipelines).catch(() => {});
    listFlaggedMessages().then(setFlagged).catch(() => {});
  }

  function refreshSecurityAlerts(status?: "" | "OPEN" | "DISMISSED" | "ACTIONED") {
    listSecurityAlerts((status || securityFilter) || undefined).then(setSecurityAlerts).catch(() => {});
  }

  function refreshLogs(level?: string) {
    listLogs({ level: level || undefined, limit: 200 })
      .then(setLogs)
      .catch(() => {});
  }

  function refreshGroups() {
    listGroups().then(setGroups).catch(() => {});
  }

  function refreshWebhooks() {
    adminListWebhooks()
      .then((d) => {
        setWebhooks(d.webhooks);
        setAvailableEvents(d.availableEvents);
      })
      .catch(() => {});
  }

  useEffect(() => {
    apiFetch("/admin/dashboard").then(setStats).catch(() => {});
    apiFetch("/admin/health").then(setHealth).catch(() => {});
    refreshGroups();
    refreshPipelines();
    refreshSecurityAlerts("OPEN");
    refreshLogs();
    refreshWebhooks();
    getPublicConfig().then((cfg) => setSignupEnabled(cfg.signupEnabled)).catch(() => {});

    // Keep CPU/RAM/disk/GPU numbers live — cheap enough to poll every 5s
    // (see lib/system.ts on the backend), and this is the one section of
    // the dashboard where a stale number is actually misleading.
    const interval = setInterval(() => {
      apiFetch("/admin/health").then(setHealth).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const availableModels = health?.ollama.models ?? [];

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    await createGroup({ name: newGroupName.trim() });
    setNewGroupName("");
    setCreatingGroup(false);
    refreshGroups();
  }

  async function toggleGroupModel(group: Group, model: string) {
    const has = group.modelAccess.includes(model);
    const modelAccess = has ? group.modelAccess.filter((m) => m !== model) : [...group.modelAccess, model];
    await updateGroup(group.id, { modelAccess });
    refreshGroups();
  }

  async function handleCreateWebhook() {
    if (!newWebhookUrl.trim() || newWebhookEvents.length === 0) return;
    const { webhook } = await adminCreateWebhook(newWebhookUrl.trim(), newWebhookEvents);
    setNewWebhookUrl("");
    setNewWebhookEvents([]);
    setRevealedSecret(webhook.secret);
    refreshWebhooks();
  }

  function toggleNewWebhookEvent(event: string) {
    setNewWebhookEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  async function toggleDeliveries(webhookId: string) {
    if (expandedWebhookId === webhookId) {
      setExpandedWebhookId(null);
      return;
    }
    setExpandedWebhookId(webhookId);
    setLoadingDeliveries(true);
    try {
      const { deliveries: rows } = await adminListWebhookDeliveries(webhookId);
      setDeliveries((prev) => ({ ...prev, [webhookId]: rows }));
    } catch {
      // leave whatever was there before, if anything
    } finally {
      setLoadingDeliveries(false);
    }
  }

  async function handleClearDeliveries(webhookId: string) {
    if (!(await askConfirm({ title: "Clear delivery history for this webhook?", confirmLabel: "Clear" }))) return;
    await adminClearWebhookDeliveries(webhookId);
    setDeliveries((prev) => ({ ...prev, [webhookId]: [] }));
  }

  async function handleCleanupQuotaUsage() {
    const { deleted } = await adminCleanupQuotaUsage(90);
    setQuotaCleanupMsg(`${deleted} oude quota-rij(en) opgeruimd.`);
    setTimeout(() => setQuotaCleanupMsg(null), 4000);
  }

  async function handleCleanupDeliveries() {
    const { deleted } = await adminCleanupWebhookDeliveries(30);
    setQuotaCleanupMsg(`${deleted} oude delivery-rij(en) opgeruimd.`);
    setTimeout(() => setQuotaCleanupMsg(null), 4000);
    setDeliveries({});
    if (expandedWebhookId) {
      const { deliveries: rows } = await adminListWebhookDeliveries(expandedWebhookId);
      setDeliveries((prev) => ({ ...prev, [expandedWebhookId]: rows }));
    }
  }

  if (!ready) return null;

  return (
    <>
    <div className="h-full overflow-y-auto px-6 py-10">
    <div className="max-w-[1600px] mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
      </div>
      <div className="mb-10">
        <div className="flex gap-2 mt-3">
          <a href="/admin/mcp" className="text-sm px-3 py-1.5 rounded-full border border-visiyon-border hover:bg-visiyon-text/[0.06]">
            MCP tool servers
          </a>
        </div>
        <div className="flex items-center gap-2 mt-3" id="authentication">
          <span className="text-[13px] text-visiyon-text-2">Public sign-ups</span>
          <button
            onClick={async () => {
              const next = !signupEnabled;
              setSignupEnabled(next);
              try {
                await adminSetSignupEnabled(next);
              } catch {
                setSignupEnabled(!next);
              }
            }}
            className={`relative w-10 h-[22px] rounded-full transition-colors ${
              signupEnabled ? "bg-visiyon-accent" : "bg-visiyon-text/15"
            }`}
            title={signupEnabled ? "Sign-ups are enabled — click to disable" : "Sign-ups are disabled — click to enable"}
          >
            <span
              className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-visiyon-bg transition-transform ${
                signupEnabled ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
              }`}
            />
          </button>
          <span className="text-[12px] text-visiyon-text-3">{signupEnabled ? "Enabled" : "Disabled"}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
        {[
          ["Users", stats?.userCount],
          ["Chats", stats?.chatCount],
          ["Messages", stats?.messageCount],
          ["Ollama", stats?.ollamaUp ? "Online" : "Offline"],
          ["Web search", health?.searxng?.up ? "Online" : "Offline"],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-[6px] p-5">
            <div className="text-[12.5px] text-visiyon-text-3 mb-1">{label}</div>
            <div className="text-2xl font-semibold">{value ?? "—"}</div>
          </div>
        ))}
      </div>

      <AnalyticsPanel variant="overview" />

      <div className="mb-10">
        <h2 className="text-lg font-semibold mb-4">System resources</h2>
        {health?.system ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <UsageBar
                label="CPU"
                pct={health.system.cpu.usedPercent}
                detail={`Load avg ${health.system.cpu.loadAvg1.toFixed(2)} / ${health.system.cpu.cores} cores`}
              />
              <UsageBar
                label="RAM"
                pct={health.system.memory.usedPercent}
                detail={`${formatBytes(health.system.memory.usedBytes)} / ${formatBytes(health.system.memory.totalBytes)}`}
              />
              {health.system.disk && (
                <UsageBar
                  label="Disk"
                  pct={health.system.disk.usedPercent}
                  detail={`${formatBytes(health.system.disk.usedBytes)} / ${formatBytes(health.system.disk.totalBytes)}`}
                />
              )}
            </div>

            {health.system.gpus && health.system.gpus.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                {health.system.gpus.map((gpu) => (
                  <UsageBar
                    key={gpu.index}
                    label={`GPU ${gpu.index} · ${gpu.name}`}
                    pct={gpu.utilizationPercent}
                    detail={`${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)} VRAM${
                      gpu.temperatureC != null ? ` · ${gpu.temperatureC}°C` : ""
                    }`}
                  />
                ))}
              </div>
            )}
            {(!health.system.gpus || health.system.gpus.length === 0) && (
              <p className="text-[11.5px] text-visiyon-text-3 mt-3">
                No GPU stats available — nvidia-smi isn't reachable from this container. See the
                comment in <code>backend/src/lib/system.ts</code> for how to enable GPU passthrough.
              </p>
            )}
          </>
        ) : (
          <p className="text-visiyon-text-3 text-sm">Loading…</p>
        )}
      </div>

      <div className="mb-10">
        <h2 className="text-lg font-semibold mb-4">Installed models</h2>
        <div className="flex flex-wrap gap-2">
          {health?.ollama.models.filter((m) => !EMBEDDING_NAME_PATTERN.test(m)).length ? (
            health.ollama.models
              .filter((m) => !EMBEDDING_NAME_PATTERN.test(m))
              .map((m) => (
                <span key={m} className="text-[13px] border border-visiyon-border rounded-full px-3 py-1.5">
                  {m}
                </span>
              ))
          ) : (
            <p className="text-visiyon-text-3 text-sm">No models detected yet.</p>
          )}
        </div>
      </div>

      <div className="mb-10" id="groups">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Groups (permissions)</h2>
          <button
            onClick={() => setCreatingGroup((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors"
          >
            <Plus size={14} /> New group
          </button>
        </div>

        {creatingGroup && (
          <div className="flex gap-2 mb-4">
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Group name"
              className="flex-1 text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
            <button
              onClick={handleCreateGroup}
              className="text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black"
            >
              Create
            </button>
          </div>
        )}

        <p className="text-[12px] text-visiyon-text-3 mb-4">
          No models checked = group can use all models. Check models to restrict the group to only those models.
        </p>

        <div className="space-y-3">
          {groups.length === 0 && <p className="text-visiyon-text-3 text-sm">No groups created yet.</p>}
          {groups.map((g) => (
            <div key={g.id} className="rounded-[6px] p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    {g.name}
                    {g.isDefault && (
                      <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full bg-white text-black">
                        Default for new accounts
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-visiyon-text-3">{g._count?.users ?? 0} user(s)</div>
                </div>
                <div className="flex items-center gap-3">
                  {!g.isDefault && (
                    <button
                      onClick={async () => {
                        await updateGroup(g.id, { isDefault: true });
                        refreshGroups();
                      }}
                      className="text-[12px] text-visiyon-text-3 hover:text-visiyon-text transition-colors"
                      title="Every new account is automatically placed in this group"
                    >
                      Make default
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete group "${g.name}"? Members will lose their restriction (gain full access).`, confirmLabel: "Delete", danger: true })) {
                        await deleteGroup(g.id);
                        refreshGroups();
                      }
                    }}
                    className="text-visiyon-text-3 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mb-3">
                {availableModels.length === 0 && (
                  <p className="text-[12px] text-visiyon-text-3">No models detected.</p>
                )}
                {availableModels.map((m) => {
                  const active = g.modelAccess.includes(m);
                  return (
                    <button
                      key={m}
                      onClick={() => toggleGroupModel(g, m)}
                      className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                        active ? "bg-white text-black border-visiyon-text" : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 pt-3 border-t border-visiyon-border">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] text-visiyon-text-3">Token limit (rolling window)</label>
                  <input
                    type="number"
                    min={1}
                    placeholder="Default: 500"
                    defaultValue={g.dailyTokenQuota ?? ""}
                    onBlur={async (e) => {
                      const val = e.target.value.trim();
                      await updateGroup(g.id, { dailyTokenQuota: val ? Number(val) : null });
                      refreshGroups();
                    }}
                    className="w-24 text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-1 outline-none focus:border-visiyon-text"
                  />
                  <span className="text-[11px] text-visiyon-text-3">(afbeeldingen tellen hierin mee)</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-10" id="moderation">
        <h2 className="text-lg font-semibold mb-4">Pipelines (moderation/hooks)</h2>
        <p className="text-[12px] text-visiyon-text-3 mb-4">
          PRE rules run on the user's message before it reaches the model — BLOCK refuses the
          message entirely. POST rules run on the model's full reply — they can only FLAG it
          (the reply has already streamed), for review below. AI rules run automatically on
          every message, 24/7 — no schedule to configure, they fire the instant a message comes in.
        </p>

        <div className="rounded-[6px] p-5 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={newRule.name}
              onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
              placeholder="Rule name"
              className="text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
            <input
              value={newRule.pattern}
              onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
              placeholder={
                newRule.matchType === "KEYWORD"
                  ? "word1, word2, ..."
                  : newRule.matchType === "REGEX"
                  ? "regex pattern"
                  : "AI instruction, e.g. 'Flag spam, scam links or phishing'"
              }
              className="text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={newRule.stage}
              onChange={(e) => setNewRule({ ...newRule, stage: e.target.value as "PRE" | "POST" })}
              className="text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-2"
            >
              <option value="PRE" className="bg-visiyon-panel">PRE (user message)</option>
              <option value="POST" className="bg-visiyon-panel">POST (model reply)</option>
            </select>
            <select
              value={newRule.matchType}
              onChange={(e) => setNewRule({ ...newRule, matchType: e.target.value as "KEYWORD" | "REGEX" | "AI" })}
              className="text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-2"
            >
              <option value="KEYWORD" className="bg-visiyon-panel">Keyword (comma-separated)</option>
              <option value="REGEX" className="bg-visiyon-panel">Regex</option>
              <option value="AI" className="bg-visiyon-panel">AI (model reviews every message)</option>
            </select>
            <select
              value={newRule.action}
              onChange={(e) => setNewRule({ ...newRule, action: e.target.value as "BLOCK" | "FLAG" })}
              disabled={newRule.stage === "POST"}
              className="text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-2 disabled:opacity-40"
            >
              <option value="FLAG" className="bg-visiyon-panel">FLAG</option>
              <option value="BLOCK" className="bg-visiyon-panel">BLOCK</option>
            </select>
          </div>
          {newRule.action === "BLOCK" && newRule.stage === "PRE" && (
            <input
              value={newRule.message}
              onChange={(e) => setNewRule({ ...newRule, message: e.target.value })}
              placeholder="Message shown to the user when blocked"
              className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
            />
          )}
          <button
            onClick={async () => {
              if (!newRule.name.trim() || !newRule.pattern.trim()) return;
              await createPipeline({
                ...newRule,
                action: newRule.stage === "POST" ? "FLAG" : newRule.action,
              });
              setNewRule({ ...newRule, name: "", pattern: "" });
              refreshPipelines();
            }}
            className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black"
          >
            <Plus size={14} /> Add rule
          </button>
        </div>

        <div className="space-y-2 mb-6">
          {pipelines.length === 0 && <p className="text-visiyon-text-3 text-sm">No pipeline rules yet.</p>}
          {pipelines.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-[6px] px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium">
                  {p.name}{" "}
                  <span className="text-[11px] text-visiyon-text-3 ml-1">
                    {p.stage} · {p.matchType} · {p.action}
                  </span>
                </div>
                <div className="text-[12px] text-visiyon-text-3 font-mono">{p.pattern}</div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    await updatePipeline(p.id, { enabled: !p.enabled });
                    refreshPipelines();
                  }}
                  className={`text-[11px] px-2.5 py-1 rounded-full border ${
                    p.enabled ? "border-visiyon-text" : "border-visiyon-border text-visiyon-text-3"
                  }`}
                >
                  {p.enabled ? "Active" : "Off"}
                </button>
                <button
                  onClick={async () => {
                    if (await askConfirm({ title: `Delete rule "${p.name}"?`, confirmLabel: "Delete", danger: true })) {
                      await deletePipeline(p.id);
                      refreshPipelines();
                    }
                  }}
                  className="text-visiyon-text-3 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <h3 className="text-sm font-semibold mb-3">Flagged messages ({flagged.length})</h3>
        <div className="rounded-[6px] overflow-hidden">
          {flagged.length === 0 && (
            <p className="text-visiyon-text-3 text-sm px-5 py-4">Nothing flagged.</p>
          )}
          {flagged.map((m) => (
            <div key={m.id} className="px-5 py-3.5 border-b border-visiyon-border last:border-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] font-medium">{m.chat.title}</span>
                <span className="text-[11px] text-visiyon-text-3">{m.role}</span>
              </div>
              <p className="text-[13px] text-visiyon-text-2 line-clamp-2">{m.content}</p>
              <p className="text-[11px] text-yellow-500 mt-1">{m.flagReason}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-10" id="security">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Security (24/7 scanner)</h2>
            <p className="text-[12px] text-visiyon-text-3 mt-1">
              A background job scans the whole platform every 2 minutes for spam/abuse patterns
              no single message can show on its own — the same text spammed across many chats,
              a burst of messages far above normal, or a wave of new signups at once.
            </p>
          </div>
          <select
            value={securityFilter}
            onChange={(e) => {
              const v = e.target.value as "" | "OPEN" | "DISMISSED" | "ACTIONED";
              setSecurityFilter(v);
              refreshSecurityAlerts(v);
            }}
            className="text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-1.5 outline-none"
          >
            <option value="OPEN" className="bg-visiyon-panel">Open</option>
            <option value="ACTIONED" className="bg-visiyon-panel">Actioned</option>
            <option value="DISMISSED" className="bg-visiyon-panel">Dismissed</option>
            <option value="" className="bg-visiyon-panel">All</option>
          </select>
        </div>

        <div className="rounded-[6px] overflow-hidden">
          {securityAlerts.length === 0 && (
            <p className="text-visiyon-text-3 text-sm px-5 py-4">No alerts in this view.</p>
          )}
          {securityAlerts.map((a) => (
            <div key={a.id} className="px-5 py-3.5 border-b border-visiyon-border last:border-0">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${
                      a.status === "OPEN"
                        ? "border-yellow-500 bg-yellow-500 text-black font-semibold animate-pulse"
                        : a.status === "ACTIONED"
                        ? "border-red-400 text-red-400"
                        : "border-visiyon-border text-visiyon-text-3"
                    }`}
                  >
                    {a.status}
                  </span>
                  <span className="text-[12px] font-medium">{a.type.replace(/_/g, " ")}</span>
                </div>
                <span className="text-[11px] text-visiyon-text-3">{timeAgoOrDate(a.createdAt)}</span>
              </div>
              <p className="text-[13px] text-visiyon-text-2">{a.summary}</p>
              {a.user && (
                <p className="text-[11px] text-visiyon-text-3 mt-1">{a.user.email}</p>
              )}
              {a.status === "OPEN" && (
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={async () => {
                      await updateSecurityAlert(a.id, "ACTIONED");
                      refreshSecurityAlerts();
                    }}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-red-400 text-red-400 hover:bg-red-400/10"
                  >
                    Mark actioned
                  </button>
                  <button
                    onClick={async () => {
                      await updateSecurityAlert(a.id, "DISMISSED");
                      refreshSecurityAlerts();
                    }}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-10" id="logs">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Event log</h2>
          <div className="flex items-center gap-2">
            <select
              value={logLevelFilter}
              onChange={(e) => {
                setLogLevelFilter(e.target.value);
                refreshLogs(e.target.value);
              }}
              className="text-[12px] bg-transparent border border-visiyon-border rounded-[6px] px-2 py-1.5 outline-none"
            >
              <option value="" className="bg-visiyon-panel">All levels</option>
              <option value="ERROR" className="bg-visiyon-panel">Error</option>
              <option value="WARN" className="bg-visiyon-panel">Warn</option>
              <option value="INFO" className="bg-visiyon-panel">Info</option>
            </select>
            <button
              onClick={() => refreshLogs(logLevelFilter)}
              className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            <button
              onClick={async () => {
                if (await askConfirm({ title: "Clear all logged events? This can't be undone.", confirmLabel: "Clear", danger: true })) {
                  await clearLogs();
                  refreshLogs(logLevelFilter);
                }
              }}
              className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[6px] border border-visiyon-border hover:border-red-400 hover:text-red-400 transition-colors"
            >
              <Trash2 size={13} /> Clear
            </button>
          </div>
        </div>
        <div className="rounded-[6px] overflow-hidden max-h-96 overflow-y-auto">
          {logs.length === 0 && <p className="text-visiyon-text-3 text-sm px-5 py-4">No events logged yet.</p>}
          {logs.map((l) => (
            <div key={l.id} className="px-5 py-3 border-b border-visiyon-border last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10.5px] font-medium px-2 py-0.5 rounded-full border ${
                    l.level === "ERROR"
                      ? "border-red-400 text-red-400 animate-blink"
                      : l.level === "WARN"
                      ? "border-yellow-500 bg-yellow-500 text-black font-semibold animate-pulse"
                      : "border-visiyon-border text-visiyon-text-3"
                  }`}
                >
                  {l.level}
                </span>
                <span className="text-[11px] text-visiyon-text-3">{l.source}</span>
                <span className="text-[11px] text-visiyon-text-3 ml-auto">
                  {new Date(l.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-[13px] text-visiyon-text-2">{l.message}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-10" id="webhooks">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <WebhookIcon size={18} /> Webhooks
          </h2>
          <div className="flex items-center gap-3">
            {quotaCleanupMsg && <span className="text-[11px] text-visiyon-text-3">{quotaCleanupMsg}</span>}
            <button
              onClick={handleCleanupDeliveries}
              className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text hover:text-visiyon-text transition-colors"
              title="Deletes delivery logs older than 30 days"
            >
              Oude deliveries opruimen
            </button>
            <button
              onClick={handleCleanupQuotaUsage}
              className="text-[11px] px-2.5 py-1 rounded-full border border-visiyon-border text-visiyon-text-3 hover:border-visiyon-text hover:text-visiyon-text transition-colors"
              title="Deletes old quota usage event rows (older than 90 days)"
            >
              Oude quota-data opruimen
            </button>
          </div>
        </div>
        <p className="text-[12px] text-visiyon-text-3 mb-4">
          Every webhook is sent with an HMAC-SHA256 signature in the <code>X-Visiyon-Signature</code> header,
          computed over the raw request body using the secret below. Every delivery (including automatic
          retries) is logged — click a webhook to see its history.
        </p>

        <div className="rounded-[6px] p-5 mb-4 space-y-3">
          <input
            value={newWebhookUrl}
            onChange={(e) => setNewWebhookUrl(e.target.value)}
            placeholder="https://example.com/webhooks/visiyon"
            className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
          />
          <div className="flex flex-wrap gap-2">
            {availableEvents.map((ev) => {
              const active = newWebhookEvents.includes(ev);
              return (
                <button
                  key={ev}
                  onClick={() => toggleNewWebhookEvent(ev)}
                  className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                    active ? "bg-white text-black border-visiyon-text" : "border-visiyon-border text-visiyon-text-2 hover:border-visiyon-text"
                  }`}
                >
                  {ev}
                </button>
              );
            })}
          </div>
          <button
            onClick={handleCreateWebhook}
            disabled={!newWebhookUrl.trim() || newWebhookEvents.length === 0}
            className="flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-[6px] bg-white text-black disabled:opacity-40"
          >
            <Plus size={14} /> Add webhook
          </button>
        </div>

        {revealedSecret && (
          <div className="border border-visiyon-text rounded-[6px] p-4 mb-4">
            <p className="text-[12.5px] text-visiyon-text-2 mb-2">
              Secret for the new webhook — copy it now, it won't be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[13px] bg-visiyon-text/[0.06] rounded-[6px] px-3 py-2 overflow-x-auto whitespace-nowrap">
                {revealedSecret}
              </code>
              <button
                onClick={() => copyToClipboard(revealedSecret)}
                className="p-2 rounded-[6px] border border-visiyon-border hover:border-visiyon-text transition-colors shrink-0"
              >
                <KeyRound size={14} />
              </button>
            </div>
            <button
              onClick={() => setRevealedSecret(null)}
              className="mt-3 text-[12px] text-visiyon-text-3 hover:text-visiyon-text"
            >
              Close
            </button>
          </div>
        )}

        <div className="space-y-2">
          {webhooks.length === 0 && <p className="text-visiyon-text-3 text-sm">No webhooks configured yet.</p>}
          {webhooks.map((w) => (
            <div key={w.id} className="rounded-[6px] px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13px] font-medium truncate max-w-md">{w.url}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={async () => {
                      await adminUpdateWebhook(w.id, { enabled: !w.enabled });
                      refreshWebhooks();
                    }}
                    className={`text-[11px] px-2.5 py-1 rounded-full border ${
                      w.enabled ? "border-visiyon-text" : "border-visiyon-border text-visiyon-text-3"
                    }`}
                  >
                    {w.enabled ? "Active" : "Off"}
                  </button>
                  <button
                    onClick={async () => {
                      const { webhook } = await adminRotateWebhookSecret(w.id);
                      setRevealedSecret(webhook.secret);
                      refreshWebhooks();
                    }}
                    className="text-visiyon-text-3 hover:text-visiyon-text"
                    title="Regenerate secret"
                  >
                    <KeyRound size={14} />
                  </button>
                  <button
                    onClick={async () => {
                      if (await askConfirm({ title: `Delete webhook to "${w.url}"?`, confirmLabel: "Delete", danger: true })) {
                        await adminDeleteWebhook(w.id);
                        refreshWebhooks();
                      }
                    }}
                    className="text-visiyon-text-3 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    onClick={() => toggleDeliveries(w.id)}
                    className="text-visiyon-text-3 hover:text-visiyon-text"
                    title="Deliveries bekijken"
                  >
                    {expandedWebhookId === w.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.events.map((ev) => (
                  <span key={ev} className="text-[11px] text-visiyon-text-3 border border-visiyon-border rounded-full px-2 py-0.5">
                    {ev}
                  </span>
                ))}
              </div>

              {expandedWebhookId === w.id && (
                <div className="mt-3 pt-3 border-t border-visiyon-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-visiyon-text-3">Laatste deliveries</span>
                    <button
                      onClick={() => handleClearDeliveries(w.id)}
                      className="text-[11px] text-visiyon-text-3 hover:text-red-400"
                    >
                      Clear history
                    </button>
                  </div>
                  {loadingDeliveries && !deliveries[w.id] && (
                    <p className="text-[11px] text-visiyon-text-3">Loading...</p>
                  )}
                  {deliveries[w.id]?.length === 0 && (
                    <p className="text-[11px] text-visiyon-text-3">No deliveries yet.</p>
                  )}
                  <div className="space-y-1">
                    {deliveries[w.id]?.map((d) => (
                      <div key={d.id} className="flex items-center justify-between text-[11px]">
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                              d.status === "SUCCESS" ? "bg-emerald-400" : "bg-red-400"
                            }`}
                          />
                          <span className="text-visiyon-text-2 truncate">{d.event}</span>
                          {d.attempt > 1 && <span className="text-visiyon-text-3">(poging {d.attempt})</span>}
                        </span>
                        <span className="text-visiyon-text-3 shrink-0 ml-2">
                          {d.statusCode ?? d.error ?? "—"} · {new Date(d.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
    </div>
    </>
  );
}
