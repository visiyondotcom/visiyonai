"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "./Logo";
import { askPrompt, askConfirm } from "./PromptDialog";
import { useChatStore, readStoredSidebarCollapsed } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import {
  listChats,
  createChat,
  pinChat,
  deleteChat,
  renameChat,
  logout,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveChatToFolder,
  getMe,
  getPublicConfigCached,
  Folder,
  PublicFeatureFlags,
} from "@/lib/api";
import {
  Pin,
  Trash2,
  Pencil,
  Plus,
  Search,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderInput,
  Settings,
  X,
  Hash,
  StickyNote,
  Bot,
  Swords,
  Code2,
  PanelLeftClose,
  LogOut,
  ShieldCheck,
  Loader2,
  Music,
} from "lucide-react";

interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  folderId?: string | null;
  _count?: { messages: number };
}

// Unread tracking is purely local (no backend/schema change): for each
// chat we remember how many messages it had the last time this browser
// actually viewed it. A badge shows when the chat's current message count
// (from listChats' _count.messages, already returned by the backend) is
// higher than that — which happens whenever a message landed in a chat the
// user *isn't* currently looking at: an Automation posting in the
// background, another tab/device, or a streamed reply that finished after
// the user navigated away mid-generation.
const READ_COUNTS_KEY = "visiyon_chat_read_counts";

function readReadCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(READ_COUNTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function markChatRead(chatId: string, count: number) {
  if (typeof window === "undefined") return;
  const map = readReadCounts();
  if (map[chatId] === count) return;
  map[chatId] = count;
  window.localStorage.setItem(READ_COUNTS_KEY, JSON.stringify(map));
}

function unreadCount(chat: ChatSummary): number {
  const total = chat._count?.messages ?? 0;
  const seen = readReadCounts()[chat.id] ?? total;
  return Math.max(0, total - seen);
}

export default function Sidebar({ activeId, model }: { activeId?: string; model: string }) {
  const { mobileSidebarOpen, setMobileSidebarOpen, desktopSidebarCollapsed, setDesktopSidebarCollapsed, chatListVersion, isStreaming, isGeneratingImage, openSettings, openSearch } = useChatStore(
    useShallow((s) => ({
      mobileSidebarOpen: s.mobileSidebarOpen,
      setMobileSidebarOpen: s.setMobileSidebarOpen,
      desktopSidebarCollapsed: s.desktopSidebarCollapsed,
      setDesktopSidebarCollapsed: s.setDesktopSidebarCollapsed,
      chatListVersion: s.chatListVersion,
      isStreaming: s.isStreaming,
      isGeneratingImage: s.isGeneratingImage,
      openSettings: s.openSettings,
      openSearch: s.openSearch,
    }))
  );
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [movingChatId, setMovingChatId] = useState<string | null>(null);
  const [me, setMe] = useState<{ name?: string | null; email: string; role: string; subscriptionStatus?: string | null; avatarUrl?: string | null } | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    // A "fixed inset-0" click-catcher doesn't work here: the <aside> below
    // has a transform (translate-x, for the mobile slide-in animation),
    // and any transform on an ancestor makes it the containing block for
    // fixed-position descendants — so that overlay would only cover the
    // sidebar's own box, not the full page, and clicks in the main chat
    // area would never close this menu. A real document listener has no
    // such containing-block issue.
    function onMouseDown(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [accountMenuOpen]);
  // Admin-controlled — Admin > Settings > General > "Sidebar &
  // navigation". Defaults to all-true so the sidebar looks unchanged
  // while the request for public-config is still in flight.
  const [features, setFeatures] = useState<PublicFeatureFlags>({
    playground: true,
    studio: true,
    arena: true,
    music: false,
    channels: true,
    notes: true,
    automations: true,
    upgradeButton: true,
    documentUpload: true,
    imageUpload: true,
  });
  const router = useRouter();

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
    getPublicConfigCached()
      .then((c) => setFeatures(c.features))
      .catch(() => {});
  }, []);

  async function refresh(q?: string) {
    try {
      setChats(await listChats(q));
    } catch {
      /* not logged in yet — leave empty */
    }
  }

  async function refreshFolders() {
    try {
      setFolders(await listFolders());
    } catch {
      /* not logged in yet */
    }
  }

  useEffect(() => {
    refresh();
    refreshFolders();
    if (readStoredSidebarCollapsed()) setDesktopSidebarCollapsed(true);
  }, []);

  // Whenever the list refreshes, immediately mark the chat currently open
  // in the main pane as read at its latest message count — otherwise its
  // own new messages (the ones the user is actively watching stream in)
  // would incorrectly show up as "unread" the next time this chat drops
  // out of view.
  useEffect(() => {
    if (!activeId) return;
    const active = chats.find((c) => c.id === activeId);
    if (active) markChatRead(active.id, active._count?.messages ?? 0);
  }, [activeId, chats]);

  useEffect(() => {
    if (chatListVersion > 0) refresh(query || undefined);
  }, [chatListVersion]);

  // Light polling so a message that lands in the background (an Automation
  // posting to a chat that isn't open, another tab/device) shows its unread
  // badge without requiring the user to trigger a refresh themselves.
  useEffect(() => {
    const t = setInterval(() => refresh(query || undefined), 15000);
    return () => clearInterval(t);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => refresh(query || undefined), 250);
    return () => clearTimeout(t);
  }, [query]);

  async function handleNewChat() {
    const chat = await createChat(model);
    router.push(`/chat/${chat.id}`);
    setMobileSidebarOpen(false);
    refresh();
  }

  async function handleNewFolder() {
    const name = await askPrompt({ title: "New folder", label: "Folder name", placeholder: "e.g. Work" });
    if (!name) return;
    await createFolder(name);
    refreshFolders();
  }

  function toggleCollapsed(folderId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function handleMove(chatId: string, folderId: string | null) {
    await moveChatToFolder(chatId, folderId);
    setMovingChatId(null);
    refresh(query || undefined);
    refreshFolders();
  }

  function renderChatRow(c: ChatSummary) {
    const unread = c.id === activeId ? 0 : unreadCount(c);
    return (
      <div
        key={c.id}
        className={`group flex items-center justify-between rounded-xl px-3 py-2 text-[13.5px] cursor-pointer ${
          c.id === activeId ? "bg-visiyon-text/[0.08]" : "hover:bg-visiyon-text/[0.04]"
        }`}
      >
        <Link href={`/chat/${c.id}`} className="truncate flex-1 flex items-center gap-1.5" onClick={() => setMobileSidebarOpen(false)}>
          {c.pinned && <Pin size={11} className="inline -mt-0.5 shrink-0" />}
          <span className="truncate">{c.title}</span>
          {unread > 0 && (
            <span className="shrink-0 min-w-[16px] h-[16px] px-1 rounded-full bg-visiyon-accent text-visiyon-bg text-[10px] font-semibold flex items-center justify-center">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
          {c.id === activeId && (isStreaming || isGeneratingImage) && (
            <Loader2 size={12} className="animate-spin shrink-0 text-visiyon-text-3" />
          )}
        </Link>
        <div className="relative hidden group-hover:flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
          <button
            onClick={() => setMovingChatId(movingChatId === c.id ? null : c.id)}
            title="Move to folder"
          >
            <FolderInput size={13} />
          </button>
          <button
            onClick={async () => {
              await pinChat(c.id, !c.pinned);
              refresh(query || undefined);
            }}
            title="Pin"
          >
            <Pin size={13} />
          </button>
          <button
            onClick={async () => {
              const title = await askPrompt({ title: "Rename chat", label: "Title", defaultValue: c.title });
              if (title) {
                await renameChat(c.id, title);
                refresh(query || undefined);
              }
            }}
            title="Rename"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={async () => {
              if (await askConfirm({ title: "Delete this chat?", confirmLabel: "Delete", danger: true })) {
                await deleteChat(c.id);
                if (c.id === activeId) router.push("/");
                refresh(query || undefined);
              }
            }}
            title="Delete"
          >
            <Trash2 size={13} />
          </button>

          {movingChatId === c.id && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-visiyon-panel rounded-xl overflow-hidden z-40 shadow-2xl">
              <button
                onClick={() => handleMove(c.id, null)}
                className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-visiyon-text/[0.06] text-visiyon-text-2"
              >
                No folder
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => handleMove(c.id, f.id)}
                  className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-visiyon-text/[0.06] truncate"
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const unfoldered = chats.filter((c) => !c.folderId);

  return (
    <>
      {/* Backdrop — mobile only, closes the drawer on tap */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <aside
        className={`w-[260px] shrink-0 h-full flex flex-col bg-visiyon-bg border-r border-visiyon-border
          fixed inset-y-0 left-0 z-50 transition-all duration-200
          lg:sticky lg:top-0 lg:translate-x-0
          ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}
          ${desktopSidebarCollapsed ? "lg:w-0 lg:opacity-0 lg:pointer-events-none lg:overflow-hidden" : ""}`}
      >
        <div className="p-4 flex items-center justify-between">
          <Link href="/">
            <Logo size={18} />
          </Link>
          <div className="flex items-center gap-1">
            <button
              onClick={openSearch}
              className="text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Search chats"
            >
              <Search size={18} />
            </button>
            <button
              onClick={() => setDesktopSidebarCollapsed(true)}
              className="hidden lg:block text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
            <button
              onClick={() => setMobileSidebarOpen(false)}
              className="lg:hidden text-visiyon-text-2 hover:text-visiyon-text p-1"
              title="Close menu"
            >
              <X size={18} />
            </button>
          </div>
        </div>

      <div className="px-3">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-visiyon-text/[0.06] hover:bg-visiyon-text/10 transition-colors"
        >
          <Plus size={16} /> New chat
        </button>
        {features.playground && (
          <Link
            href="/playground"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <FlaskConical size={16} /> Playground
          </Link>
        )}
        {features.channels && (
          <Link
            href="/channels"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Hash size={16} /> Channels
          </Link>
        )}
        {features.notes && (
          <Link
            href="/notes"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <StickyNote size={16} /> Notes
          </Link>
        )}
        {features.studio && (
          <Link
            href="/studio"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Code2 size={16} /> Studio
          </Link>
        )}
        {features.automations && (
          <Link
            href="/automations"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Bot size={16} /> Automations
          </Link>
        )}
        {features.arena && (
          <Link
            href="/arena"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Swords size={16} /> Arena
          </Link>
        )}
        {features.music && (
          <Link
            href="/music"
            className="mt-0.5 w-full flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg text-visiyon-text-2 hover:bg-visiyon-text/[0.06] transition-colors"
          >
            <Music size={16} /> Music
          </Link>
        )}
      </div>

      <div className="px-3 mt-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-visiyon-border text-visiyon-text-2">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            autoComplete="off"
            name="sidebar-chat-search"
            className="bg-transparent outline-none text-[13px] w-full placeholder:text-visiyon-text-3"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto mt-3 px-3 pb-4">
        <div className="flex items-center justify-between px-1 mb-1">
          <span className="text-[11px] uppercase tracking-wide text-visiyon-text-3">Folders</span>
          <button onClick={handleNewFolder} title="New folder" className="text-visiyon-text-3 hover:text-visiyon-text">
            <FolderPlus size={13} />
          </button>
        </div>

        <div className="space-y-1 mb-3">
          {folders.map((f) => {
            const isCollapsed = collapsed.has(f.id);
            const folderChats = chats.filter((c) => c.folderId === f.id);
            return (
              <div key={f.id}>
                <div className="group flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-visiyon-text/[0.04]">
                  <button
                    onClick={() => toggleCollapsed(f.id)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-[13px] text-visiyon-text-2"
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span className="truncate">{f.name}</span>
                    <span className="text-[11px] text-visiyon-text-3">{f._count?.chats ?? folderChats.length}</span>
                  </button>
                  <div className="hidden group-hover:flex items-center gap-1.5 text-visiyon-text-3 shrink-0">
                    <button
                      onClick={async () => {
                        const name = await askPrompt({ title: "Rename folder", label: "Name", defaultValue: f.name });
                        if (name) {
                          await renameFolder(f.id, name);
                          refreshFolders();
                        }
                      }}
                      title="Rename folder"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={async () => {
                        if (
                          await askConfirm({
                            title: `Delete folder "${f.name}"? Chats inside will be kept, just unfiled.`,
                            confirmLabel: "Delete",
                            danger: true,
                          })
                        ) {
                          await deleteFolder(f.id);
                          refreshFolders();
                          refresh(query || undefined);
                        }
                      }}
                      title="Delete folder"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="pl-3 space-y-1">
                    {folderChats.length === 0 ? (
                      <p className="text-[11.5px] text-visiyon-text-3 px-3 py-1">Empty</p>
                    ) : (
                      folderChats.map(renderChatRow)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-1">
          {unfoldered.map(renderChatRow)}
        </div>
      </div>

      <div className="relative p-3" ref={accountMenuRef}>
        <button
          onClick={() => setAccountMenuOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-visiyon-text/[0.06] transition-colors"
        >
          {me?.avatarUrl ? (
            <img
              src={me.avatarUrl}
              alt=""
              className="w-7 h-7 rounded-full object-cover shrink-0"
            />
          ) : (
            <span className="w-7 h-7 rounded-full bg-visiyon-accent text-visiyon-bg text-[12px] font-semibold flex items-center justify-center shrink-0">
              {(me?.name || me?.email || "?").charAt(0).toUpperCase()}
            </span>
          )}
          {!desktopSidebarCollapsed && (
            <span className="text-left overflow-hidden">
              <span className="block text-[13px] text-visiyon-text truncate">{me?.name || me?.email || "Account"}</span>
              <span className="block text-[11px] text-visiyon-text-3 truncate">
                {me?.subscriptionStatus === "ACTIVE" ? "Pro" : "Free"}
              </span>
            </span>
          )}
        </button>

        {accountMenuOpen && (
          <div className="absolute bottom-full left-3 mb-1 w-60 bg-visiyon-bg border border-visiyon-border rounded-xl overflow-hidden z-30 py-1">
              <div className="px-3 py-2.5 border-b border-visiyon-border">
                <p className="text-[13px] text-visiyon-text truncate">{me?.name || me?.email || "Account"}</p>
                <p className="text-[11.5px] text-visiyon-text-3 truncate">{me?.email}</p>
              </div>
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  openSettings();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
              >
                <Settings size={15} /> Settings
              </button>
              {me?.role === "ADMIN" && (
                <Link
                  href="/admin"
                  onClick={() => setAccountMenuOpen(false)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
                >
                  <ShieldCheck size={15} /> Admin
                </Link>
              )}
              <div className="border-t border-visiyon-border my-1" />
              <button
                onClick={() => {
                  logout();
                  // Full reload, not router.push: chat state (and any other
                  // in-memory React/module state) is a page-lifetime
                  // singleton, so only a hard navigation guarantees nothing
                  // from this account survives into the next login on the
                  // same tab.
                  window.location.href = "/login";
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] text-left text-visiyon-text-2 hover:bg-visiyon-text/[0.06] hover:text-visiyon-text transition-colors"
              >
                <LogOut size={15} /> Log out
              </button>
            </div>
        )}
      </div>
    </aside>
    </>
  );
}
