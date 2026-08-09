"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useRequireAdmin } from "@/lib/useAuth";
import { adminGetSettings, adminUpdateSettings, AppSettings, AppBanner } from "@/lib/api";
import { safeRandomUUID } from "@/lib/uuid";
import { Plus, X } from "lucide-react";

// Sidebar categories mirror the OpenWebUI Settings layout. Only "General"
// is wired up here — the rest link back into functionality that already
// lives elsewhere in this admin panel (Groups/Moderation/Webhooks/Logs on
// the Users tab, Functions on its own tab) so nothing is duplicated.
//
// Every tab is a real route (/admin/settings/general, /admin/settings/
// usagelimits, ...) so it can be linked to directly and survives a page
// refresh — previously the active tab lived only in React state, so
// reloading (or bookmarking/sharing a link to a specific tab) always
// dropped you back on "General".
const TAB_KEYS = [
  "general",
  "usagelimits",
  "uploads",
  "billing",
  "music",
  "login",
  "images",
  "websearch",
  "voice",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

const SIDEBAR: { key: string; label: string; href?: string }[] = [
  { key: "general", label: "General" },
  { key: "usagelimits", label: "Usage limits" },
  { key: "uploads", label: "Uploads" },
  { key: "billing", label: "Billing" },
  { key: "music", label: "Music" },
  { key: "login", label: "Login providers" },
  { key: "images", label: "Image generation" },
  { key: "websearch", label: "Web search" },
  { key: "voice", label: "Voice" },
  { key: "auth", label: "Authentication", href: "/admin#authentication" },
  { key: "groups", label: "Groups & Access", href: "/admin#groups" },
  { key: "moderation", label: "Moderation", href: "/admin#moderation" },
  { key: "webhooks", label: "Webhooks", href: "/admin#webhooks" },
  { key: "functions", label: "Functions", href: "/admin/functions" },
  { key: "mcp", label: "MCP Servers", href: "/admin/mcp" },
  { key: "logs", label: "Logs", href: "/admin#logs" },
];

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${on ? "bg-visiyon-accent" : "bg-visiyon-text/15"}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform ${
          on ? "translate-x-[18px] bg-visiyon-bg" : "translate-x-0 bg-visiyon-text"
        }`}
      />
    </button>
  );
}

const FEATURE_ROWS: { key: keyof AppSettings; label: string; indent?: boolean }[] = [
  { key: "communitySharingEnabled", label: "Enable Community Sharing" },
  { key: "messageRatingEnabled", label: "Enable Message Rating" },
  { key: "foldersEnabled", label: "Folders" },
  { key: "memoriesEnabled", label: "Memories" },
  { key: "memorySystemContextEnabled", label: "Memory System Context", indent: true },
  { key: "notesEnabled", label: "Notes" },
  { key: "channelsEnabled", label: "Channels" },
  { key: "calendarEnabled", label: "Calendar" },
  { key: "automationsEnabled", label: "Automations" },
  { key: "userWebhooksEnabled", label: "User Webhooks" },
  { key: "userStatusEnabled", label: "User Status" },
];

// Controls which nav links show up in the app sidebar, plus the header
// "Upgrade" button — separate section since these are visibility-only
// switches (the feature itself keeps working if visited by URL), not
// functional on/off switches like FEATURE_ROWS above.
const NAV_ROWS: { key: keyof AppSettings; label: string }[] = [
  { key: "playgroundEnabled", label: "Playground" },
  { key: "studioEnabled", label: "Studio" },
  { key: "arenaEnabled", label: "Arena" },
  { key: "musicGenEnabled", label: "Music" },
  { key: "channelsEnabled", label: "Channels" },
  { key: "notesEnabled", label: "Notes" },
  { key: "automationsEnabled", label: "Automations" },
  { key: "upgradeButtonEnabled", label: "Upgrade button" },
];

// Mirrors the Prisma schema defaults. Used the moment /admin/settings
// can't be reached yet (freshly deployed backend, migration not run
// yet) so the form is always usable — Save then upserts the row.
const DEFAULT_SETTINGS: AppSettings = {
  communitySharingEnabled: true,
  messageRatingEnabled: true,
  foldersEnabled: true,
  memoriesEnabled: true,
  memorySystemContextEnabled: true,
  notesEnabled: true,
  channelsEnabled: true,
  calendarEnabled: false,
  automationsEnabled: true,
  userWebhooksEnabled: false,
  userStatusEnabled: false,
  playgroundEnabled: true,
  studioEnabled: true,
  arenaEnabled: true,
  upgradeButtonEnabled: true,
  responseWatermark: null,
  webuiUrl: null,
  termsRequired: false,
  termsOfService: null,
  captchaEnabled: false,
  banners: [],
  stripeSecretKey: null,
  stripePublishableKey: null,
  stripeWebhookSecret: null,
  stripePlans: null,
  stripePlanQuotas: null,
  musicGenEnabled: false,
  musicGenUrl: null,
  musicGenApiKey: null,
  musicGenModel: null,
  musicGenCallbackUrl: null,
  ssoEnabled: null,
  ssoProviderName: null,
  ssoIssuerUrl: null,
  ssoClientId: null,
  ssoClientSecret: null,
  ssoScopes: null,
  ssoRedirectUri: null,
  imageGenEnabled: null,
  imageGenProvider: "custom",
  imageGenUrl: null,
  imageGenApiKey: null,
  stabilityApiKey: null,
  webSearchEnabled: null,
  webSearchProvider: "searxng",
  webSearchUrl: null,
  webSearchApiKey: null,
  internetAccessEnabled: null,
  voiceSttEnabled: null,
  voiceTtsEnabled: null,
  voiceTtsProvider: "piper",
  voiceTtsVoice: null,
  voiceTtsUrl: null,
  voiceTtsApiKey: null,
  defaultTokenQuota: null,
  quotaWindowHours: null,
  limitPopupTitle: null,
  limitPopupMessage: null,
  limitPopupButtonText: null,
  documentMaxUploadMb: null,
  voiceMaxUploadMb: null,
  avatarMaxUploadMb: null,
  documentUploadEnabled: true,
  imageUploadEnabled: true,
};

export default function AdminSettingsPage() {
  const ready = useRequireAdmin();
  const router = useRouter();
  const params = useParams();
  const rawTab = Array.isArray(params?.tab) ? params.tab[0] : params?.tab;
  const tab: TabKey = (TAB_KEYS as readonly string[]).includes(rawTab as string)
    ? (rawTab as TabKey)
    : "general";
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Unknown/old tab slug in the URL (e.g. a stale bookmark) — send it to
  // General instead of silently rendering General under the wrong URL.
  useEffect(() => {
    if (rawTab && !(TAB_KEYS as readonly string[]).includes(rawTab as string)) {
      router.replace("/admin/settings/general");
    }
  }, [rawTab, router]);

  useEffect(() => {
    adminGetSettings()
      .then((d) => setSettings(d.settings))
      .catch(() => {
        setLoadError(true);
        setSettings(DEFAULT_SETTINGS);
      });
  }, []);

  // Autosave: any change to `settings` gets pushed to the server on its
  // own, debounced so fast edits (typing, dragging a slider) don't fire a
  // request per keystroke. Skips the very first render (the initial load
  // setting `settings` for the first time) so opening the page never
  // triggers a save of data that just came from the server.
  const isFirstSettingsLoad = useRef(true);
  useEffect(() => {
    if (!settings) return;
    if (isFirstSettingsLoad.current) {
      isFirstSettingsLoad.current = false;
      return;
    }
    setSaving(true);
    setSaved(false);
    const timer = setTimeout(() => {
      adminUpdateSettings(settings)
        .then(() => {
          setSaved(true);
          setLoadError(false);
          setTimeout(() => setSaved(false), 2000);
        })
        .catch(() => setLoadError(true))
        .finally(() => setSaving(false));
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function addBanner() {
    if (!settings) return;
    const banner: AppBanner = { id: safeRandomUUID(), type: "info", content: "", enabled: true };
    set("banners", [...settings.banners, banner]);
  }

  function updateBanner(id: string, patch: Partial<AppBanner>) {
    if (!settings) return;
    set("banners", settings.banners.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function removeBanner(id: string) {
    if (!settings) return;
    set("banners", settings.banners.filter((b) => b.id !== id));
  }

  if (!ready) return null;

  const tabLabel =
    tab === "general" ? "General" : tab === "usagelimits" ? "Usage limits" : tab === "uploads" ? "Uploads" : tab === "billing" ? "Billing" : tab === "music" ? "Music generation" : tab === "login" ? "Login providers" : tab === "websearch" ? "Web search" : tab === "voice" ? "Voice" : "Image generation";

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-6 sm:py-10">
      <div className="max-w-[1600px] mx-auto">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-xl sm:text-2xl font-semibold">Admin dashboard</h1>
        </div>

        <div className="flex flex-col lg:flex-row lg:gap-10">
          {/* Section nav — vertical list on desktop, horizontal scroll strip on mobile/tablet */}
          <div
            className="
              flex lg:block lg:w-48 lg:shrink-0
              -mx-4 px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0
              mb-6 lg:mb-0
              gap-1.5 lg:gap-0 lg:space-y-0.5
              overflow-x-auto lg:overflow-visible
              pb-2 lg:pb-0
              border-b border-visiyon-border lg:border-b-0
              [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
            "
          >
            {SIDEBAR.map((s) => {
              const isTab = (TAB_KEYS as readonly string[]).includes(s.key);
              const active = isTab && s.key === tab;
              return (
                <Link
                  key={s.key}
                  href={isTab ? `/admin/settings/${s.key}` : s.href || "#"}
                  className={`shrink-0 whitespace-nowrap lg:whitespace-normal lg:block text-[13px] px-3 py-1.5 rounded-[6px] transition-colors cursor-pointer ${
                    active ? "bg-visiyon-text/[0.08] font-medium" : "text-visiyon-text-3 hover:text-visiyon-text hover:bg-visiyon-text/[0.04]"
                  }`}
                >
                  {s.label}
                </Link>
              );
            })}
          </div>

          <div className="flex-1 lg:max-w-2xl min-w-0 pb-24">
            <div className="flex items-center justify-between gap-3 mb-5">
              <h2 className="text-base sm:text-lg font-semibold truncate">{tabLabel}</h2>
              <span className="shrink-0 text-[12px] text-visiyon-text-3">
                {saving ? "Saving…" : saved ? "Saved" : ""}
              </span>
            </div>

            {loadError && (
              <div className="mb-5 text-[12.5px] border border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-200 rounded-[6px] px-3.5 py-2.5 animate-blink">
                Could not reach the server for these settings (the database migration may still
                need to run: <code>npx prisma migrate dev</code> in <code>backend/</code>).
                You can still make changes below — they'll save automatically once the server is reachable.
              </div>
            )}

            {!settings ? (
              <p className="text-sm text-visiyon-text-3">Loading…</p>
            ) : tab === "usagelimits" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Controls the default per-user token budget and the rolling reset window, plus the
                  text shown to regular users when they hit that budget. Leave a field blank to keep
                  using the server's environment variables — a value entered here takes priority.
                  Changes take effect immediately, no restart needed.
                </p>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Default token quota</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.defaultTokenQuota ?? ""}
                    onChange={(e) => set("defaultTokenQuota", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="5000 (blank = use DEFAULT_TOKEN_QUOTA env var)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Tokens a user without a group override or paid plan can use per window before
                    they're blocked. Admins are never limited by this.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Reset window (hours)</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.quotaWindowHours ?? ""}
                    onChange={(e) => set("quotaWindowHours", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="5 (blank = use QUOTA_WINDOW_HOURS env var)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Rolling window length — usage ages out continuously rather than resetting at a
                    fixed clock time, similar to Claude.ai's 5-hour window.
                  </p>
                </div>

                <h3 className="text-[13px] font-semibold mb-3 text-visiyon-text-2">"You reached the limit" popup</h3>
                <p className="text-[12.5px] text-visiyon-text-3 mb-4">
                  Shown to regular users in English when they hit their quota. Leave blank to use the
                  built-in default text.
                </p>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Title</label>
                  <input
                    value={settings.limitPopupTitle ?? ""}
                    onChange={(e) => set("limitPopupTitle", e.target.value || null)}
                    placeholder="You've reached your usage limit"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  />
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Message</label>
                  <textarea
                    value={settings.limitPopupMessage ?? ""}
                    onChange={(e) => set("limitPopupMessage", e.target.value || null)}
                    placeholder="Upgrade your plan to keep chatting, or wait for your limit to reset."
                    rows={3}
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text resize-none"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    The exact reset time is appended automatically after this message when the popup
                    was triggered by hitting the limit.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Button text</label>
                  <input
                    value={settings.limitPopupButtonText ?? ""}
                    onChange={(e) => set("limitPopupButtonText", e.target.value || null)}
                    placeholder="Choose {plan}"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Use <code>{"{plan}"}</code> as a placeholder for the plan name shown on each pricing card's button.
                  </p>
                </div>
              </>
            ) : tab === "uploads" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Maximum file size accepted for each type of upload. Leave a field blank to keep
                  using the built-in default. Changes take effect immediately, no restart needed.
                </p>

                <div className="mb-8">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-visiyon-text-2">Document uploads</h3>
                    <Toggle on={settings.documentUploadEnabled} onClick={() => set("documentUploadEnabled", !settings.documentUploadEnabled)} />
                  </div>
                  <p className="text-[11.5px] text-visiyon-text-3">
                    When off, users can no longer upload files to their document library
                    (existing documents are unaffected). Useful to shut off uploads entirely
                    during a storage incident, independent of the size limit below.
                  </p>
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-visiyon-text-2">Image attachments</h3>
                    <Toggle on={settings.imageUploadEnabled} onClick={() => set("imageUploadEnabled", !settings.imageUploadEnabled)} />
                  </div>
                  <p className="text-[11.5px] text-visiyon-text-3">
                    When off, the "Attach image" option is hidden from the chat input and
                    sending an image is rejected server-side. Separate from document uploads
                    above — this controls images sent inline to vision models.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Document uploads (MB)</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.documentMaxUploadMb ?? ""}
                    onChange={(e) => set("documentMaxUploadMb", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="20 (default)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Max size for PDF, DOCX, TXT, MD, and CSV files uploaded to a user's document library.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Voice uploads (MB)</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.voiceMaxUploadMb ?? ""}
                    onChange={(e) => set("voiceMaxUploadMb", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="25 (default)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Max size for audio files sent to speech-to-text transcription.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Avatar uploads (MB)</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.avatarMaxUploadMb ?? ""}
                    onChange={(e) => set("avatarMaxUploadMb", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="2 (default)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Max size for a user's profile photo.
                  </p>
                </div>
              </>
            ) : tab === "billing" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Configure Stripe here, or leave a field blank to keep using the <code>STRIPE_*</code>
                  environment variables on the server — a value entered here takes priority.
                  Changes take effect immediately, no restart needed.
                </p>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Secret key</label>
                  <input
                    value={settings.stripeSecretKey ?? ""}
                    onChange={(e) => set("stripeSecretKey", e.target.value)}
                    placeholder="sk_live_… (blank = use STRIPE_SECRET_KEY)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Shown masked after saving. Leave the masked field unchanged to keep the
                    existing key.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Publishable key</label>
                  <input
                    value={settings.stripePublishableKey ?? ""}
                    onChange={(e) => set("stripePublishableKey", e.target.value)}
                    placeholder="pk_live_…"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Webhook signing secret</label>
                  <input
                    value={settings.stripeWebhookSecret ?? ""}
                    onChange={(e) => set("stripeWebhookSecret", e.target.value)}
                    placeholder="whsec_… (blank = use STRIPE_WEBHOOK_SECRET)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Used to verify the <code>Stripe-Signature</code> header on <code>/billing/webhook</code>.
                    Found in the Stripe Dashboard under the webhook endpoint settings.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Plans</label>
                  <input
                    value={settings.stripePlans ?? ""}
                    onChange={(e) => set("stripePlans", e.target.value)}
                    placeholder="pro:price_123,team:price_456"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Format: <code>plan_id:stripe_price_id</code>, comma-separated. <code>plan_id</code> is a
                    name you choose yourself, referenced in checkout requests from the frontend.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Plan quotas (optional)</label>
                  <input
                    value={settings.stripePlanQuotas ?? ""}
                    onChange={(e) => set("stripePlanQuotas", e.target.value)}
                    placeholder="pro:100:20,team:500:100"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Format: <code>plan_id:tokenquota_per_window</code>. Only raises a user's
                    quota above what their group already allows — never lowers it.
                  </p>
                </div>
              </>
            ) : tab === "music" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Point this at a Suno-compatible AI music API (e.g. kie.ai) to enable the Music page for
                  users. Leave a field blank to keep using the matching <code>MUSIC_GEN_*</code>
                  environment variable — a value entered here takes priority. Changes take effect
                  immediately, no restart needed.
                </p>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable music generation</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows the Music nav item / page to users once a URL and API key are set.
                      </span>
                    </div>
                    <Toggle on={settings.musicGenEnabled} onClick={() => set("musicGenEnabled", !settings.musicGenEnabled)} />
                  </div>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">API URL</label>
                  <input
                    value={settings.musicGenUrl ?? ""}
                    onChange={(e) => set("musicGenUrl", e.target.value)}
                    placeholder="https://api.kie.ai (blank = use MUSIC_GEN_URL)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">API key</label>
                  <input
                    value={settings.musicGenApiKey ?? ""}
                    onChange={(e) => set("musicGenApiKey", e.target.value)}
                    placeholder="blank = use MUSIC_GEN_API_KEY"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Default model</label>
                  <input
                    value={settings.musicGenModel ?? ""}
                    onChange={(e) => set("musicGenModel", e.target.value)}
                    placeholder="V4_5 (blank = use MUSIC_GEN_MODEL, defaults to V4_5)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Callback URL</label>
                  <input
                    value={settings.musicGenCallbackUrl ?? ""}
                    onChange={(e) => set("musicGenCallbackUrl", e.target.value)}
                    placeholder="https://your-domain.com/api/music/callback"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Required by the provider on every generate call — must be a publicly reachable URL.
                  </p>
                </div>
              </>
            ) : tab === "login" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Set up "Continue with…" single sign-on (Microsoft/Azure AD, Google, Okta, Keycloak, or
                  any OpenID Connect provider). Leave a field blank to keep using the matching{" "}
                  <code>OIDC_*</code> environment variable — a value entered here takes priority, and
                  changes take effect immediately, no restart needed. This replaces setting{" "}
                  <code>OIDC_*</code> vars by hand on the server, which don't survive every redeploy.
                </p>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable SSO login</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows the "Continue with…" button on the login page once an issuer, client ID
                        and client secret are set.
                      </span>
                    </div>
                    <Toggle on={Boolean(settings.ssoEnabled)} onClick={() => set("ssoEnabled", !settings.ssoEnabled)} />
                  </div>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Provider name</label>
                  <input
                    value={settings.ssoProviderName ?? ""}
                    onChange={(e) => set("ssoProviderName", e.target.value)}
                    placeholder="Microsoft (blank = use OIDC_PROVIDER_NAME, defaults to SSO)"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Shown on the login button as "Continue with {settings.ssoProviderName || "…"}".
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Issuer URL</label>
                  <input
                    value={settings.ssoIssuerUrl ?? ""}
                    onChange={(e) => set("ssoIssuerUrl", e.target.value)}
                    placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Must serve <code>/.well-known/openid-configuration</code>. For Microsoft/Azure AD,
                    use your tenant's v2.0 endpoint from the app registration's "Endpoints" pane.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Client ID</label>
                  <input
                    value={settings.ssoClientId ?? ""}
                    onChange={(e) => set("ssoClientId", e.target.value)}
                    placeholder="blank = use OIDC_CLIENT_ID"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Client secret</label>
                  <input
                    value={settings.ssoClientSecret ?? ""}
                    onChange={(e) => set("ssoClientSecret", e.target.value)}
                    placeholder="blank = use OIDC_CLIENT_SECRET"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Shown masked after saving. Leave the masked field unchanged to keep the existing secret.
                  </p>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Scopes (optional)</label>
                  <input
                    value={settings.ssoScopes ?? ""}
                    onChange={(e) => set("ssoScopes", e.target.value)}
                    placeholder="openid email profile"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Redirect URI (optional)</label>
                  <input
                    value={settings.ssoRedirectUri ?? ""}
                    onChange={(e) => set("ssoRedirectUri", e.target.value)}
                    placeholder="https://your-domain.com/api/auth/sso/callback"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Must exactly match the redirect URI registered with the provider. Leave blank to
                    auto-derive from the incoming request's origin.
                  </p>
                </div>
              </>
            ) : tab === "images" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Enables the "Create an image" affordance in chat. Pick a provider below — run everything
                  on your own GPU with the bundled self-hosted stack, point at any OpenAI-images-compatible
                  endpoint, or use a cloud provider directly.
                </p>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable image generation</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows the image-generation option to users once the provider below is configured.
                      </span>
                    </div>
                    <Toggle on={Boolean(settings.imageGenEnabled)} onClick={() => set("imageGenEnabled", !settings.imageGenEnabled)} />
                  </div>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Provider</label>
                  <select
                    value={settings.imageGenProvider ?? "custom"}
                    onChange={(e) => set("imageGenProvider", e.target.value as AppSettings["imageGenProvider"])}
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  >
                    <option value="custom" className="bg-visiyon-panel">Custom (OpenAI-compatible URL)</option>
                    <option value="selfhosted" className="bg-visiyon-panel">Self-hosted (stable-diffusion-webui, your own GPU)</option>
                    <option value="openai" className="bg-visiyon-panel">OpenAI (DALL-E)</option>
                    <option value="stability" className="bg-visiyon-panel">Stability AI</option>
                  </select>
                </div>

                {settings.imageGenProvider === "selfhosted" ? (
                  <>
                    <p className="text-[11.5px] text-visiyon-text-3 mb-6">
                      Runs AUTOMATIC1111/stable-diffusion-webui on your own GPU(s) via the bundled{" "}
                      <code>sd-wrapper</code> service. Start it with{" "}
                      <code>docker compose --profile selfhosted-images up -d</code> — it defaults to{" "}
                      <code>http://sd-wrapper:8000</code>, so no URL is required unless you moved it.
                    </p>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">
                        Wrapper URL (optional)
                      </label>
                      <input
                        value={settings.imageGenUrl ?? ""}
                        onChange={(e) => set("imageGenUrl", e.target.value)}
                        placeholder="http://sd-wrapper:8000 (default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                  </>
                ) : settings.imageGenProvider === "openai" ? (
                  <>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">OpenAI API key</label>
                      <input
                        value={settings.imageGenApiKey ?? ""}
                        onChange={(e) => set("imageGenApiKey", e.target.value)}
                        placeholder="sk-... (blank = use IMAGE_GEN_API_KEY)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                      </p>
                    </div>
                  </>
                ) : settings.imageGenProvider === "stability" ? (
                  <>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Stability AI API key</label>
                      <input
                        value={settings.stabilityApiKey ?? ""}
                        onChange={(e) => set("stabilityApiKey", e.target.value)}
                        placeholder="blank = use STABILITY_API_KEY"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-6">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Image generation URL</label>
                      <input
                        value={settings.imageGenUrl ?? ""}
                        onChange={(e) => set("imageGenUrl", e.target.value)}
                        placeholder="https://your-endpoint (blank = use IMAGE_GEN_URL)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        <code>POST {"{url}"}/v1/images/generations</code> — must accept the OpenAI images
                        request shape and return either <code>b64_json</code> or <code>url</code>. Works with
                        LocalAI, ComfyUI's OpenAI-compatible wrapper, fal.ai's compatibility endpoint, or the
                        bundled <code>sd-wrapper</code> pointed at manually.
                      </p>
                    </div>

                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">API key</label>
                      <input
                        value={settings.imageGenApiKey ?? ""}
                        onChange={(e) => set("imageGenApiKey", e.target.value)}
                        placeholder="blank = use IMAGE_GEN_API_KEY"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                      </p>
                    </div>
                  </>
                )}
              </>
            ) : tab === "websearch" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Enables the "Search the web" toggle in chat. Backed by the bundled SearXNG meta search
                  engine (see <code>docker compose up -d searxng</code>) — point at a different instance
                  below if you're running your own.
                </p>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable web search</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows the web-search option to users once a SearXNG instance is reachable below.
                      </span>
                    </div>
                    <Toggle on={Boolean(settings.webSearchEnabled)} onClick={() => set("webSearchEnabled", !settings.webSearchEnabled)} />
                  </div>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">SearXNG URL</label>
                  <input
                    value={settings.webSearchUrl ?? ""}
                    onChange={(e) => set("webSearchUrl", e.target.value)}
                    placeholder="http://searxng:8080 (blank = use SEARXNG_URL)"
                    className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Must have <code>formats: [html, json]</code> enabled in <code>searxng/settings.yml</code>
                    so <code>{"{url}"}/search?format=json</code> returns results.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">API key (optional)</label>
                  <input
                    value={settings.webSearchApiKey ?? ""}
                    onChange={(e) => set("webSearchApiKey", e.target.value)}
                    placeholder="blank if your SearXNG instance doesn't require one"
                    className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                  </p>
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable full internet access</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Lets the AI fetch any public web page directly (the "browse_web" tool, shown in
                        Admin &gt; Functions) instead of only querying the bundled search engine above.
                        Requests to localhost and private/internal network addresses are always blocked.
                      </span>
                    </div>
                    <Toggle
                      on={Boolean(settings.internetAccessEnabled)}
                      onClick={() => set("internetAccessEnabled", !settings.internetAccessEnabled)}
                    />
                  </div>
                </div>
              </>
            ) : tab === "voice" ? (
              <>
                <p className="text-[12.5px] text-visiyon-text-3 mb-6">
                  Lets the AI speak its replies out loud, and lets users speak instead of typing.
                  Speech-to-text always runs through a bundled, self-hosted Whisper container. Pick any
                  text-to-speech engine below — stay fully self-hosted, or use ElevenLabs for the most
                  natural-sounding voice.
                </p>

                <div className="mb-5">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable text-to-speech</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows a "Read aloud" button on assistant replies, and lets the AI speak during voice mode.
                      </span>
                    </div>
                    <Toggle on={Boolean(settings.voiceTtsEnabled)} onClick={() => set("voiceTtsEnabled", !settings.voiceTtsEnabled)} />
                  </div>
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between px-4 py-3 border border-visiyon-border rounded-[6px]">
                    <div>
                      <span className="text-[13.5px] block">Enable speech-to-text</span>
                      <span className="text-[11.5px] text-visiyon-text-3">
                        Shows a microphone button in the chat box so users can speak their message instead of typing it.
                      </span>
                    </div>
                    <Toggle on={Boolean(settings.voiceSttEnabled)} onClick={() => set("voiceSttEnabled", !settings.voiceSttEnabled)} />
                  </div>
                </div>

                <div className="mb-6">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Text-to-speech engine</label>
                  <select
                    value={settings.voiceTtsProvider ?? "piper"}
                    onChange={(e) => set("voiceTtsProvider", e.target.value as AppSettings["voiceTtsProvider"])}
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  >
                    <option value="piper" className="bg-visiyon-panel">Piper — self-hosted, fastest, robotic-ish (default)</option>
                    <option value="kokoro" className="bg-visiyon-panel">Kokoro — self-hosted, natural, runs fine on CPU</option>
                    <option value="coqui" className="bg-visiyon-panel">Coqui XTTS-v2 — self-hosted, most natural local option, GPU recommended</option>
                    <option value="elevenlabs" className="bg-visiyon-panel">ElevenLabs — cloud API, most human-sounding overall</option>
                  </select>
                </div>

                {settings.voiceTtsProvider === "elevenlabs" ? (
                  <>
                    <div className="mb-6">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">ElevenLabs API key</label>
                      <input
                        value={settings.voiceTtsApiKey ?? ""}
                        onChange={(e) => set("voiceTtsApiKey", e.target.value)}
                        placeholder="blank = use ELEVENLABS_API_KEY"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Shown masked after saving. Leave the masked field unchanged to keep the existing key.
                      </p>
                    </div>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Voice ID</label>
                      <input
                        value={settings.voiceTtsVoice ?? ""}
                        onChange={(e) => set("voiceTtsVoice", e.target.value || null)}
                        placeholder="21m00Tcm4TlvDq8ikWAM (Rachel, default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Find voice IDs (including any voices you've cloned) at{" "}
                        <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noreferrer" className="underline">
                          elevenlabs.io/app/voice-library
                        </a>.
                      </p>
                    </div>
                  </>
                ) : settings.voiceTtsProvider === "coqui" ? (
                  <>
                    <p className="text-[11.5px] text-visiyon-text-3 mb-6">
                      Runs Coqui XTTS-v2 via the bundled <code>coqui/</code> service. Start it with{" "}
                      <code>docker compose --profile tts-coqui up -d --build</code> — a GPU is strongly
                      recommended (edit the commented GPU block in <code>docker-compose.yml</code>'s{" "}
                      <code>coqui</code> service to enable it), CPU inference is slow enough to hurt
                      real-time voice mode. Supports voice cloning: drop a 6–10s reference WAV into the
                      service's <code>/speakers</code> volume named e.g. <code>jean.wav</code>, then set
                      "Voice" below to <code>jean</code>.
                    </p>
                    <div className="mb-6">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Voice (speaker name)</label>
                      <input
                        value={settings.voiceTtsVoice ?? ""}
                        onChange={(e) => set("voiceTtsVoice", e.target.value || null)}
                        placeholder="blank = built-in default speaker"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Service URL (optional)</label>
                      <input
                        value={settings.voiceTtsUrl ?? ""}
                        onChange={(e) => set("voiceTtsUrl", e.target.value || null)}
                        placeholder="http://coqui:5002 (default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                  </>
                ) : settings.voiceTtsProvider === "kokoro" ? (
                  <>
                    <p className="text-[11.5px] text-visiyon-text-3 mb-6">
                      Runs Kokoro-TTS via the bundled <code>kokoro/</code> service. Start it with{" "}
                      <code>docker compose --profile tts-kokoro up -d --build</code>. Fast enough for
                      real-time voice mode on CPU, no GPU required.
                    </p>
                    <div className="mb-6">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Voice</label>
                      <input
                        value={settings.voiceTtsVoice ?? ""}
                        onChange={(e) => set("voiceTtsVoice", e.target.value || null)}
                        placeholder="af_heart (default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        See Kokoro's voice list on its{" "}
                        <a href="https://github.com/hexgrad/kokoro" target="_blank" rel="noreferrer" className="underline">
                          GitHub page
                        </a>{" "}
                        for available names (e.g. <code>af_heart</code>, <code>am_adam</code>, <code>bf_emma</code>).
                      </p>
                    </div>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Service URL (optional)</label>
                      <input
                        value={settings.voiceTtsUrl ?? ""}
                        onChange={(e) => set("voiceTtsUrl", e.target.value || null)}
                        placeholder="http://kokoro:5003 (default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-6">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Voice</label>
                      <select
                        value={settings.voiceTtsVoice ?? ""}
                        onChange={(e) => set("voiceTtsVoice", e.target.value || null)}
                        className="w-full text-[13px] bg-visiyon-bg text-visiyon-text border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                      >
                        <option value="">Use server default (PIPER_VOICE, or en_US-lessac-medium)</option>
                        <option value="en_US-lessac-medium">English (US) — Lessac</option>
                        <option value="en_US-amy-medium">English (US) — Amy</option>
                        <option value="en_GB-alan-medium">English (UK) — Alan</option>
                        <option value="nl_NL-mls-medium">Dutch — MLS</option>
                      </select>
                      <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                        Must be a voice model already downloaded into the Piper container. See{" "}
                        <code>piper/</code> for how to add more voices.
                      </p>
                    </div>
                    <div className="mb-8">
                      <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Service URL (optional)</label>
                      <input
                        value={settings.voiceTtsUrl ?? ""}
                        onChange={(e) => set("voiceTtsUrl", e.target.value || null)}
                        placeholder="http://piper:5001 (default)"
                        className="w-full text-[13px] bg-transparent text-visiyon-text placeholder:text-visiyon-text-3 border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text font-mono"
                      />
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="mb-8">
                  <h3 className="text-[13px] font-semibold mb-3 text-visiyon-text-2">Features</h3>
                  <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
                    {FEATURE_ROWS.map((row) => (
                      <div key={row.key as string} className={`flex items-center justify-between px-4 py-3 ${row.indent ? "pl-8" : ""}`}>
                        <span className="text-[13.5px]">{row.label}</span>
                        <Toggle on={settings[row.key] as boolean} onClick={() => set(row.key, !(settings[row.key] as boolean) as any)} />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mb-8">
                  <h3 className="text-[13px] font-semibold mb-3 text-visiyon-text-2">Sidebar &amp; navigation</h3>
                  <p className="text-[11.5px] text-visiyon-text-3 mb-3">
                    Hide items from the sidebar and header without disabling the feature itself.
                  </p>
                  <div className="border border-visiyon-border rounded-[6px] divide-y divide-visiyon-border">
                    {NAV_ROWS.map((row) => (
                      <div key={row.key as string} className="flex items-center justify-between px-4 py-3">
                        <span className="text-[13.5px]">{row.label}</span>
                        <Toggle on={settings[row.key] as boolean} onClick={() => set(row.key, !(settings[row.key] as boolean) as any)} />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-visiyon-text-2">CAPTCHA</h3>
                    <Toggle on={settings.captchaEnabled} onClick={() => set("captchaEnabled", !settings.captchaEnabled)} />
                  </div>
                  <p className="text-[11.5px] text-visiyon-text-3">
                    When enabled, an animated slide-puzzle challenge is shown on Login and
                    Register to slow down automated spam/bot signups. Fully self-hosted — no
                    third-party service, no API key to configure.
                  </p>
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">Response Watermark</label>
                  <input
                    value={settings.responseWatermark ?? ""}
                    onChange={(e) => set("responseWatermark", e.target.value)}
                    placeholder="e.g. visiyon ai"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  />
                </div>

                <div className="mb-8">
                  <label className="text-[13px] font-semibold text-visiyon-text-2 block mb-2">WebUI URL</label>
                  <input
                    value={settings.webuiUrl ?? ""}
                    onChange={(e) => set("webuiUrl", e.target.value)}
                    placeholder="http://ai.visiyon.com"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text"
                  />
                  <p className="text-[11.5px] text-visiyon-text-3 mt-1.5">
                    The public URL of your WebUI. Used to generate links in notifications.
                  </p>
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-visiyon-text-2">Terms of Service</h3>
                    <Toggle on={settings.termsRequired} onClick={() => set("termsRequired", !settings.termsRequired)} />
                  </div>
                  <p className="text-[11.5px] text-visiyon-text-3 mb-2">
                    When enabled, new users must review and accept these terms — always shown in
                    English — before their account is created, via a "Continue" step on the
                    registration page.
                  </p>
                  <textarea
                    value={settings.termsOfService ?? ""}
                    onChange={(e) => set("termsOfService", e.target.value)}
                    rows={8}
                    placeholder="Enter your Terms of Service text here…"
                    className="w-full text-[13px] bg-transparent border border-visiyon-border rounded-[6px] px-3 py-2 outline-none focus:border-visiyon-text resize-y"
                  />
                </div>

                <div className="mb-8">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-visiyon-text-2">Banners</h3>
                    <button onClick={addBanner} className="text-visiyon-text-3 hover:text-visiyon-text">
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {settings.banners.length === 0 && (
                      <p className="text-[12px] text-visiyon-text-3">No banners configured.</p>
                    )}
                    {settings.banners.map((b) => (
                      <div key={b.id} className="flex flex-wrap sm:flex-nowrap items-center gap-2 border border-visiyon-border rounded-[6px] px-3 py-2">
                        <select
                          value={b.type}
                          onChange={(e) => updateBanner(b.id, { type: e.target.value as AppBanner["type"] })}
                          className="shrink-0 text-[12px] bg-transparent border border-visiyon-border rounded-full px-2 py-1 outline-none"
                        >
                          <option value="info" className="bg-visiyon-panel">Info</option>
                          <option value="warning" className="bg-visiyon-panel">Warning</option>
                          <option value="error" className="bg-visiyon-panel">Error</option>
                          <option value="success" className="bg-visiyon-panel">Success</option>
                        </select>
                        <input
                          value={b.content}
                          onChange={(e) => updateBanner(b.id, { content: e.target.value })}
                          placeholder="Banner text shown to users"
                          className="flex-1 min-w-[140px] text-[13px] bg-transparent outline-none"
                        />
                        <div className="flex items-center gap-2 ml-auto sm:ml-0">
                          <Toggle on={b.enabled} onClick={() => updateBanner(b.id, { enabled: !b.enabled })} />
                          <button onClick={() => removeBanner(b.id)} className="text-visiyon-text-3 hover:text-red-400">
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
