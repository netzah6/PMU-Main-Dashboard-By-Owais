"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import type { UserRole } from "@/lib/types";

interface UserWithRole {
  user: User | null;
  /** The role the dashboard should render for — the preview role while an
   *  admin is "viewing as" someone else, otherwise the real one. */
  role: UserRole | null;
  /** The role on the user_roles row, never overridden. */
  realRole: UserRole | null;
  /** Preview role an admin picked in the top bar, or null when not previewing. */
  viewAs: UserRole | null;
  setViewAs: (role: UserRole | null) => void;
  loading: boolean;
}

// "View as" — an admin can see the dashboard the way a Client Success Coach
// or a Media Buyer sees it (owner request 2026-09-28). The pick lives in
// localStorage so it survives navigation and reloads, and every mounted
// useUser() hears about a change through one window event so the tab bar,
// the RoleGate and the page all switch together. It is a CLIENT-SIDE preview
// only: every API still checks the real role on the server, so an admin
// previewing as a coach sees the coach's tabs and layout but is never
// actually restricted — and never gains anything either.
const VIEW_AS_KEY = "pmu_view_as";
const VIEW_AS_EVENT = "pmu-view-as";
const PREVIEWABLE: ReadonlyArray<UserRole> = ["editor", "media_buyer", "va", "setter", "closer", "sales", "viewer"];

function readViewAs(): UserRole | null {
  try {
    const v = window.localStorage.getItem(VIEW_AS_KEY) as UserRole | null;
    return v && PREVIEWABLE.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function useUser(): UserWithRole {
  const [user, setUser] = useState<User | null>(null);
  const [realRole, setRealRole] = useState<UserRole | null>(null);
  const [viewAs, setViewAsState] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    const supabase = supabaseRef.current;

    async function fetchRole(userId: string) {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .single();
      setRealRole((data?.role as UserRole) ?? "viewer");
      setLoading(false);
    }

    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) fetchRole(data.user.id);
      else setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user ?? null);
      if (session?.user) fetchRole(session.user.id);
      else {
        setRealRole(null);
        setLoading(false);
      }
    });

    // Preview role: read once, then follow changes from any other hook
    // instance (same tab) or another tab (storage event).
    setViewAsState(readViewAs());
    const sync = () => setViewAsState(readViewAs());
    window.addEventListener(VIEW_AS_EVENT, sync);
    window.addEventListener("storage", sync);

    return () => {
      listener.subscription.unsubscribe();
      window.removeEventListener(VIEW_AS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setViewAs = useCallback((next: UserRole | null) => {
    try {
      if (next && PREVIEWABLE.includes(next)) window.localStorage.setItem(VIEW_AS_KEY, next);
      else window.localStorage.removeItem(VIEW_AS_KEY);
    } catch {}
    window.dispatchEvent(new Event(VIEW_AS_EVENT));
  }, []);

  // Only an admin may preview. A stale key left by an admin who later became
  // something else is ignored — never let it change what a non-admin sees.
  const effectiveViewAs = realRole === "admin" ? viewAs : null;
  const role = effectiveViewAs ?? realRole;

  return { user, role, realRole, viewAs: effectiveViewAs, setViewAs, loading };
}
