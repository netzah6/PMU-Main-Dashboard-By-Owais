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
      className="h-14 flex items-center px-3 sm:px-6 gap-2 sm:gap-4 sticky top-0 z-40 relative border-b border-[#e4ebf2]"
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

      {/* Logo + Title */}
      <div className="flex items-center gap-3 flex-1">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "linear-gradient(135deg, #15B7AE, #34568a)" }}
        >
          <span className="text-white font-bold text-sm">P</span>
        </div>
        <div className="min-w-0">
          <p className="hidden sm:block text-[11px] font-extrabold tracking-[0.12em] uppercase text-[#0e8f88] leading-none">
            PMU Bookings On Demand
          </p>
          <p className="text-sm font-bold text-[#34568a] leading-tight tracking-tight whitespace-nowrap">Master Dashboard</p>
        </div>
      </div>

      {/* Sync indicator */}
      {syncing && (
        <div className="flex items-center gap-1.5 text-xs text-[#0e8f88] font-semibold">
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
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] hover:text-[#0e8f88] transition-colors border border-[#e4ebf2]"
            >
              <Database size={12} />
              <span className="hidden sm:inline">Sync</span>
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e4ebf2] text-[#34568a] transition-colors border border-[#e4ebf2]"
            >
              <Settings size={12} />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </>
        )}

        <div className="flex items-center gap-2 text-sm text-[#34568a] ml-1">
          <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #15B7AE, #34568a)" }}>
            <User size={13} className="text-white" />
          </div>
          <span className="hidden sm:block text-xs">{userEmail}</span>
        </div>

        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e4ebf2] text-[#34568a] transition-colors border border-[#e4ebf2]"
        >
          <LogOut size={12} />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}
