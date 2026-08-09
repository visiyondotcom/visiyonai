"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe } from "@/lib/api";

// Module-level cache: once a session has been verified in this tab, every
// subsequent useRequireAuth() mount (e.g. clicking between chats — each
// /chat/[id] navigation remounts the page and re-runs this hook) can skip
// the network round trip and the ready=false flash that made switching
// chats feel like it needed several clicks before anything happened.
let cachedVerifiedUser: any = null;

/**
 * Guards a client page behind login. Every protected route (chat, admin,
 * settings, notes, arena, channels, playground, ...) previously rendered
 * immediately with no check at all — visiting the URL directly (even in a
 * fresh, logged-out browser) landed straight on the page, including
 * /admin. This redirects to /login whenever there's no valid session, and
 * returns `ready=false` until the check has resolved so callers can avoid
 * flashing protected content first.
 */
export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(cachedVerifiedUser !== null);
  const [user, setUser] = useState<any>(cachedVerifiedUser);

  useEffect(() => {
    if (cachedVerifiedUser) return;
    let cancelled = false;
    // Don't gate on localStorage's "visiyon_token" here: if you logged in
    // on a different visiyon.com subdomain, this tab's localStorage is
    // empty even though the shared session cookie still proves you're
    // logged in. Always ask the backend — apiFetch sends the cookie
    // automatically — and only bounce to /login if that actually fails.
    getMe()
      .then((u) => {
        if (!cancelled) {
          cachedVerifiedUser = u;
          setUser(u);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return { ready, user };
}

/** Same as useRequireAuth, but also requires the ADMIN role. */
export function useRequireAdmin() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (cancelled) return;
        if (user?.role !== "ADMIN") {
          router.replace("/");
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return ready;
}
