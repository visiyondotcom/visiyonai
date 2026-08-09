import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PromptDialogHost } from "@/components/PromptDialog";
import BannerBar from "@/components/BannerBar";
import SupportChatWidget from "@/components/SupportChatWidget";
import SettingsModal from "@/components/SettingsModal";
import SearchModal from "@/components/SearchModal";
import { MusicPlayerProvider } from "@/lib/musicPlayer";
import GlobalPlayerBar from "@/components/GlobalPlayerBar";
import VisitorTracker from "@/components/VisitorTracker";
import CookieConsentBanner from "@/components/CookieConsentBanner";

export const metadata: Metadata = {
  title: "Visiyon AI",
  description:
    "Visiyon AI — a self-hosted AI assistant platform powered by open models, running entirely on your own infrastructure.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Runs before paint so switching themes never flashes the wrong
            one on reload. Falls back to dark (matches the className above)
            when nothing's been chosen yet or localStorage is unavailable. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("visiyon_theme");if(t==="light"){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light");}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-visiyon-bg text-visiyon-text antialiased h-dvh flex flex-col overflow-hidden">
        <MusicPlayerProvider>
          <BannerBar />
          <div className="flex-1 min-h-0">{children}</div>
          <PromptDialogHost />
          <SupportChatWidget />
          <SettingsModal />
          <SearchModal />
          <GlobalPlayerBar />
        </MusicPlayerProvider>
        {/* Central Visiyon visitor tracker — skipped on /admin, see component. */}
        <VisitorTracker />
        <CookieConsentBanner />
      </body>
    </html>
  );
}
