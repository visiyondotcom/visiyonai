"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import {
  getAnalyticsSummary,
  getAnalyticsTimeseries,
  getAnalyticsByModel,
  getAnalyticsByUser,
  getFunctionsUsage,
  AnalyticsSummary,
  AnalyticsTimeseriesRow,
  AnalyticsModelRow,
  AnalyticsUserRow,
  FunctionUsageRow,
} from "@/lib/api";

const RANGES = [7, 30, 90] as const;

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "$0.00";
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AnalyticsPanel({ variant = "full" }: { variant?: "full" | "overview" }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeseries, setTimeseries] = useState<AnalyticsTimeseriesRow[]>([]);
  const [byModel, setByModel] = useState<AnalyticsModelRow[]>([]);
  const [byUser, setByUser] = useState<AnalyticsUserRow[]>([]);
  const [functionsUsage, setFunctionsUsage] = useState<{ filters: FunctionUsageRow[]; pipes: FunctionUsageRow[]; actions: FunctionUsageRow[] }>({
    filters: [],
    pipes: [],
    actions: [],
  });
  const [sortKey, setSortKey] = useState<"messageCount" | "totalTokens" | "lastActive">("messageCount");
  const [loading, setLoading] = useState(true);

  // How often the panel quietly re-pulls fresh numbers. Kept short enough
  // that this reads like a live dashboard (e.g. left running on a big
  // screen in an office) without hammering the API.
  const REFRESH_MS = 30_000;

  useEffect(() => {
    let cancelled = false;

    // `showLoading` is only true for the very first fetch of a given
    // range — every subsequent tick on the interval below swaps the data
    // in place with no "Loading…" flash, which is what makes this safe to
    // leave running unattended on a big screen.
    function load(showLoading: boolean) {
      if (showLoading) setLoading(true);
      Promise.all([
        getAnalyticsSummary(days),
        getAnalyticsTimeseries(days),
        getAnalyticsByModel(days),
        getAnalyticsByUser(days),
      ])
        .then(([s, t, m, u]) => {
          if (cancelled) return;
          setSummary(s);
          setTimeseries(t.rows);
          setByModel(m.rows);
          setByUser(u.rows);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled && showLoading) setLoading(false);
        });
      // Not time-windowed (current state, not a range), so refreshed on
      // the same silent interval regardless of the `days` selector.
      getFunctionsUsage()
        .then((f) => !cancelled && setFunctionsUsage(f))
        .catch(() => {});
    }

    load(true);
    const interval = setInterval(() => load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [days]);

  const sortedUsers = [...(byUser ?? [])].sort((a, b) => {
    if (sortKey === "lastActive") return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
    return b[sortKey] - a[sortKey];
  });

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Analytics</h2>
        <div className="flex gap-1 bg-visiyon-text/[0.04] rounded-full p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={`text-[12.5px] px-3 py-1 rounded-full transition-colors ${
                days === r ? "bg-visiyon-accent text-visiyon-bg" : "text-visiyon-text-3 hover:text-visiyon-text"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          ["Messages", summary ? formatNumber(summary.messageCount) : "—"],
          ["Active users", summary ? formatNumber(summary.activeUserCount) : "—"],
          ["Active chats", summary ? formatNumber(summary.activeChatCount) : "—"],
          ["Total tokens", summary ? formatNumber(summary.totalTokens) : "—"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl p-5">
            <div className="text-[12.5px] text-visiyon-text-3 mb-1">{label}</div>
            <div className="text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {summary && (
        <div className="text-[12.5px] text-visiyon-text-3 mb-6">
          Prompt tokens: {formatNumber(summary.promptTokens)} · Completion tokens:{" "}
          {formatNumber(summary.completionTokens)}
        </div>
      )}

      {/* Timeseries chart */}
      <div className="rounded-2xl p-5 mb-6">
        <div className="text-[12.5px] text-visiyon-text-3 mb-4">Messages &amp; tokens per day</div>
        {timeseries.length === 0 ? (
          <p className="text-visiyon-text-3 text-sm py-8 text-center">
            {loading ? "Loading…" : "No activity in this range yet."}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={timeseries}>
              <defs>
                <linearGradient id="msgGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--visiyon-accent))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="rgb(var(--visiyon-accent))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--visiyon-border))" />
              <XAxis
                dataKey="date"
                tick={{ fill: "rgb(var(--visiyon-text) / 0.5)", fontSize: 11 }}
                axisLine={{ stroke: "rgb(var(--visiyon-border))" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "rgb(var(--visiyon-text) / 0.5)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "rgb(var(--visiyon-panel))",
                  border: "1px solid rgb(var(--visiyon-border))",
                  borderRadius: 12,
                  fontSize: 12.5,
                }}
              />
              <Area
                type="monotone"
                dataKey="messageCount"
                name="Messages"
                stroke="rgb(var(--visiyon-accent))"
                fill="url(#msgGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-model breakdown */}
      <div className="rounded-2xl p-5 mb-6">
        <div className="text-[12.5px] text-visiyon-text-3 mb-4">Usage by model</div>
        {byModel.length === 0 ? (
          <p className="text-visiyon-text-3 text-sm py-4 text-center">
            {loading ? "Loading…" : "No model usage in this range yet."}
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={byModel}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--visiyon-border))" vertical={false} />
                <XAxis
                  dataKey="model"
                  tick={{ fill: "rgb(var(--visiyon-text) / 0.5)", fontSize: 11 }}
                  axisLine={{ stroke: "rgb(var(--visiyon-border))" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "rgb(var(--visiyon-text) / 0.5)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgb(var(--visiyon-panel))",
                    border: "1px solid rgb(var(--visiyon-border))",
                    borderRadius: 12,
                    fontSize: 12.5,
                  }}
                />
                <Bar dataKey="messageCount" name="Messages" fill="rgb(var(--visiyon-accent))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>

            <table className="w-full text-[13px] mt-4">
              <thead>
                <tr className="text-visiyon-text-3 text-left border-b border-visiyon-border">
                  <th className="py-2 font-normal">Model</th>
                  <th className="py-2 font-normal">Messages</th>
                  <th className="py-2 font-normal">Prompt tokens</th>
                  <th className="py-2 font-normal">Completion tokens</th>
                  <th className="py-2 font-normal">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((m) => (
                  <tr key={m.model} className="border-b border-visiyon-border last:border-0">
                    <td className="py-2">{m.model}</td>
                    <td className="py-2">{formatNumber(m.messageCount)}</td>
                    <td className="py-2">{formatNumber(m.promptTokens)}</td>
                    <td className="py-2">{formatNumber(m.completionTokens)}</td>
                    <td className="py-2">{formatCost(m.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Per-user monitoring — a full sortable table lives on its own page
          (/admin/analytics) so a large user base doesn't turn the overview
          into an endless scroll; the overview just teases the top users. */}
      <div className="rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[12.5px] text-visiyon-text-3">Usage by user</div>
          {variant === "full" ? (
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
              className="text-[12.5px] bg-visiyon-panel text-visiyon-text border border-visiyon-border rounded-full px-3 py-1 outline-none"
              style={{ colorScheme: "dark" }}
            >
              <option value="messageCount">Sort: messages</option>
              <option value="totalTokens">Sort: tokens</option>
              <option value="lastActive">Sort: last active</option>
            </select>
          ) : (
            sortedUsers.length > 0 && (
              <a href="/admin/analytics" className="text-[12.5px] text-visiyon-text-3 hover:text-visiyon-text">
                View all →
              </a>
            )
          )}
        </div>
        {sortedUsers.length === 0 ? (
          <p className="text-visiyon-text-3 text-sm py-4 text-center">
            {loading ? "Loading…" : "No user activity in this range yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-visiyon-text-3 text-left border-b border-visiyon-border">
                  <th className="py-2 font-normal">User</th>
                  <th className="py-2 font-normal">Role</th>
                  <th className="py-2 font-normal">Messages</th>
                  <th className="py-2 font-normal">Prompt tokens</th>
                  <th className="py-2 font-normal">Completion tokens</th>
                  <th className="py-2 font-normal">Last active</th>
                </tr>
              </thead>
              <tbody>
                {(variant === "full" ? sortedUsers : sortedUsers.slice(0, 5)).map((u) => (
                  <tr key={u.userId} className="border-b border-visiyon-border last:border-0">
                    <td className="py-2">{u.name || u.email}</td>
                    <td className="py-2 text-visiyon-text-3">{u.role ?? "—"}</td>
                    <td className="py-2">{formatNumber(u.messageCount)}</td>
                    <td className="py-2">{formatNumber(u.promptTokens)}</td>
                    <td className="py-2">{formatNumber(u.completionTokens)}</td>
                    <td className="py-2 text-visiyon-text-3">{timeAgo(u.lastActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {variant === "full" && (functionsUsage.filters.length > 0 || functionsUsage.pipes.length > 0 || functionsUsage.actions.length > 0) && (
        <div className="mt-8">
          <h3 className="text-sm font-medium mb-3">Functions health</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-visiyon-text-3 text-left border-b border-visiyon-border">
                  <th className="py-2 font-normal">Name</th>
                  <th className="py-2 font-normal">Type</th>
                  <th className="py-2 font-normal">Status</th>
                  <th className="py-2 font-normal">Last run</th>
                  <th className="py-2 font-normal">Last error</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...functionsUsage.filters.map((f) => ({ ...f, kind: "Filter" })),
                  ...functionsUsage.pipes.map((f) => ({ ...f, kind: "Pipe" })),
                  ...functionsUsage.actions.map((f) => ({ ...f, kind: "Action" })),
                ].map((f) => (
                  <tr key={`${f.kind}-${f.id}`} className="border-b border-visiyon-border last:border-0">
                    <td className="py-2">{f.name}</td>
                    <td className="py-2 text-visiyon-text-3">{f.kind}</td>
                    <td className="py-2">
                      <span className={`inline-flex items-center gap-1.5 ${f.enabled ? "text-green-400" : "text-visiyon-text-3"}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${f.enabled ? "bg-green-400" : "bg-visiyon-text/20"}`} />
                        {f.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td className="py-2 text-visiyon-text-3">{f.lastRunAt ? timeAgo(f.lastRunAt) : "never"}</td>
                    <td className="py-2 text-red-400 max-w-xs truncate">{f.lastError || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
