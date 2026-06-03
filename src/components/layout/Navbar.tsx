"use client";
import { useRouter } from "next/navigation";
import { LogOut, User, RefreshCw, Database, Settings } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/hooks/useUser";
import { useState } from "react";

interface NavbarProps {
  userEmail?: string;
  syncing?: boolean;
}

export function Navbar({ userEmail, syncing }: NavbarProps) {
  const router = useRouter();
  const supabase = createClient();
  const { role } = useUser();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header
      className="h-14 border-b border-slate-700/50 flex items-center px-6 gap-4 sticky top-0 z-40"
      style={{ background: "#1a2744" }}
    >
      {/* Logo + Title */}
      <div className="flex items-center gap-3 flex-1">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "#00B4A6" }}
        >
          <span className="text-white font-bold text-sm">P</span>
        </div>
        <div>
          <p className="text-xs text-slate-400 leading-none">PMU Bookings On Demand</p>
          <p className="text-sm font-semibold text-white leading-tight">Master Dashboard</p>
        </div>
      </div>

      {/* Sync indicator */}
      {syncing && (
        <div className="flex items-center gap-1.5 text-xs text-teal-400">
          <RefreshCw size={12} className="animate-spin" />
          Syncing…
        </div>
      )}

      {/* Admin links + User menu */}
      <div className="flex items-center gap-2">
        {role === "admin" && (
          <>
            <Link
              href="/sync"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-teal-800 text-slate-300 hover:text-teal-200 transition-colors border border-slate-600"
            >
              <Database size={12} />
              Sync
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors border border-slate-600"
            >
              <Settings size={12} />
              Settings
            </Link>
          </>
        )}

        <div className="flex items-center gap-2 text-sm text-slate-300 ml-1">
          <div className="w-7 h-7 rounded-full bg-teal-700 flex items-center justify-center">
            <User size={13} className="text-teal-200" />
          </div>
          <span className="hidden sm:block text-xs">{userEmail}</span>
        </div>

        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors border border-slate-600"
        >
          <LogOut size={12} />
          Logout
        </button>
      </div>
    </header>
  );
}
