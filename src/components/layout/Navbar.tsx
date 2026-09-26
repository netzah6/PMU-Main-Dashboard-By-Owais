"use client";
import { useRouter } from "next/navigation";
import { LogOut, User, RefreshCw, Database, Settings, BadgeCheck, Loader2 } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/hooks/useUser";
import { ROLE_LABELS } from "@/lib/types";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface NavbarProps {
  userEmail?: string;
  syncing?: boolean;
  /* Pin the bar to the top of a DOCUMENT-scrolling page. True by default
     because /settings and /sync scroll the document and lose their whole
     header without it. DashboardShell passes false: there only <main>
     scrolls, so pinning buys nothing there and on a phone the pinned bar
     rode over the tab row (owner: "fix the phone view on side"). */
  sticky?: boolean;
}

export function Navbar({ userEmail, syncing, sticky = true }: NavbarProps) {
  const router = useRouter();
  const supabase = createClient();
  const { role } = useUser();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await supabase.auth.signOut();
      router.push("/login");
    } catch {
      // Offline or a Supabase blip: re-enable the button instead of leaving it
      // stuck on "Signing out…" with no way back other than a reload.
      setLoggingOut(false);
    }
  }

  return (
    // Not `sticky` any more (owner: "fix the phone view on side", 2026-09-26).
    // The bar is the first child of the shell's non-scrolling flex column —
    // only <main> scrolls — so pinning it bought nothing, and on a phone it
    // cost: whenever the page itself scrolled (100vh is taller than what a
    // phone actually shows) the pinned bar rode over the tab row and the
    // content. `relative` stays for the accent line below; `flex-shrink-0` so
    // a short landscape screen can never squeeze the bar into the tabs.
    <header
      className={cn(
        "h-14 flex-shrink-0 flex items-center px-3 sm:px-6 gap-2 sm:gap-4 z-40 border-b border-[#e4ebf2]",
        sticky ? "sticky top-0" : "relative",
      )}
      style={{
        background: "rgba(255,255,255,0.86)",
        backdropFilter: "saturate(140%) blur(10px)",
        WebkitBackdropFilter: "saturate(140%) blur(10px)",
        boxShadow: "0 4px 18px rgba(31,53,89,.06)",
      }}
    >
      {/* signature teal→navy accent line */}
      <div
        className="absolute left-0 right-0 bottom-0 h-[3px]"
        style={{ background: "linear-gradient(90deg, #15B7AE, #34568a)" }}
      />

      {/* Logo + Title + the viewer's role */}
      <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
        {/* the brand mark in its original colors — black art, teal shield — sits directly on the white bar */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand-logo.png" alt="PMU Bookings On Demand" className="w-9 h-8 sm:w-10 sm:h-9 object-contain flex-shrink-0" />
        {/* Both lines `truncate`: this block is min-w-0, so on a landscape
            phone the controls on the right squeezed it until the brand line
            wrapped onto four words-per-line and shoved "Master Dashboard" out
            of the 56px bar and behind the tab row — the collision in the
            owner's screenshot (2026-09-26). Nowrap + ellipsis means the box
            can only ever get narrower, never taller. */}
        <div className="min-w-0">
          <p className="hidden sm:block text-[11px] font-extrabold tracking-[0.12em] uppercase text-[#0e8f88] leading-none truncate">
            PMU Bookings On Demand
          </p>
          <p className="text-sm font-bold text-[#34568a] leading-tight tracking-tight truncate">Master Dashboard</p>
        </div>
        {role && (
          // md, not sm: at 640–767 (phone on its side) the badge was part of
          // what squeezed the title out of the bar.
          <span
            className="hidden md:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-tight flex-shrink-0"
            style={{
              color: "#0e8f88",
              background: "linear-gradient(135deg, rgba(21,183,174,0.10), rgba(52,86,138,0.10))",
              border: "1px solid rgba(21,183,174,0.35)",
            }}
          >
            <BadgeCheck size={13} />
            {ROLE_LABELS[role] ?? role}
          </span>
        )}
      </div>

      {/* Sync indicator */}
      {syncing && (
        <div className="flex items-center gap-1.5 text-xs text-[#0e8f88] font-semibold">
          <RefreshCw size={12} className="animate-spin" />
          Syncing…
        </div>
      )}

      {/* Admin links + User menu — flex-shrink-0 so the controls stay whole
          and the title gives way instead; the tighter gap/padding under sm is
          what buys "Master Dashboard" enough room to read in full down to a
          320px screen. */}
      <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
        {role === "admin" && (
          <>
            <Link
              href="/sync"
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] hover:text-[#0e8f88] transition-colors border border-[#e4ebf2]"
            >
              <Database size={12} />
              <span className="hidden sm:inline">Sync</span>
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e4ebf2] text-[#34568a] transition-colors border border-[#e4ebf2]"
            >
              <Settings size={12} />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </>
        )}

        {/* Under sm this block is only the decorative avatar dot (the address
            is hidden anyway), so it goes — Logout already says who's signed
            in, and the 36px it frees is the title's. The address itself moves
            to lg: at 640–1023 it was crowding the bar on a landscape phone. */}
        <div className="hidden sm:flex items-center gap-2 text-sm text-[#34568a] ml-1">
          <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "linear-gradient(135deg, #15B7AE, #34568a)" }}>
            <User size={13} className="text-white" />
          </div>
          <span className="hidden lg:block text-xs">{userEmail}</span>
        </div>

        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e4ebf2] text-[#34568a] transition-colors border border-[#e4ebf2] disabled:opacity-60"
        >
          {/* the bar's own button obeys the standing rule too — it shows it is working */}
          {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
          <span className="hidden sm:inline">{loggingOut ? "Signing out…" : "Logout"}</span>
        </button>
      </div>
    </header>
  );
}
