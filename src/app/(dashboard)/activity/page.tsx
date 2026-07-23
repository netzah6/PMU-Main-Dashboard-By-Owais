"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Admin-only activity log — every change a team member makes on the dashboard
// (mutating /api calls, recorded by the middleware into audit_log; RLS lets
// only admins read the table, so this page is protected server-side too).

interface Row { id: number; at: string; user_email: string; method: string; path: string; query: string | null }

// Friendly label for an endpoint — falls back to the raw method + path.
function describe(r: Row): string {
  const p = r.path;
  const m = r.method;
  if (p.startsWith("/api/sync/performance_tracking")) return "Saved a report Action (Reports tab)";
  if (p === "/api/onboarding" && m === "POST") return "Created an onboarding";
  if (/^\/api\/onboarding\/[^/]+\/claim/.test(p)) return m === "DELETE" ? "Unclaimed a sub-account" : "Claimed a sub-account";
  if (/^\/api\/onboarding\/[^/]+\/verify/.test(p)) return "Ran an onboarding verify";
  if (p === "/api/onboarding/check") return "Ran a Check Setup";
  if (p === "/api/onboarding/override") return "Hand-verified an onboarding check";
  if (p === "/api/onboarding/upload") return "Uploaded an onboarding image";
  if (/^\/api\/onboarding\/[^/]+$/.test(p)) return m === "DELETE" ? "Deleted an onboarding" : "Edited an onboarding";
  if (p.includes("refund")) return "Deposit refund action";
  if (p === "/api/ask") return "Used the AI tab";
  if (p.startsWith("/api/ghl/reply")) return "Generated an AI reply draft";
  if (p.startsWith("/api/sync")) return `Ran a sync (${p.replace("/api/sync/", "")})`;
  return `${m} ${p}`;
}

export default function ActivityPage() {
  const { role, loading: roleLoading } = useUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [who, setWho] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (role !== "admin") return;
    const supabase = createClient();
    supabase
      .from("audit_log")
      .select("id, at, user_email, method, path, query")
      .order("at", { ascending: false })
      .limit(500)
      .then(({ data }) => { setRows((data as Row[]) ?? []); setLoading(false); });
  }, [role]);

  const members = useMemo(() => Array.from(new Set(rows.map((r) => r.user_email))).sort(), [rows]);
  const listed = useMemo(() => rows.filter((r) => {
    if (who !== "all" && r.user_email !== who) return false;
    if (search && !`${r.user_email} ${r.path} ${describe(r)}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [rows, who, search]);

  if (roleLoading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-3 md:p-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold text-[#1f3559]">🕵️ Activity Log</h1>
        <span className="text-xs text-[#8595a8]">every change team members make · latest 500</span>
        <div className="flex-1" />
        <select value={who} onChange={(e) => setWho(e.target.value)}
          className="text-sm border border-[#e4ebf2] rounded-lg px-2 py-1.5 bg-white text-[#1f3559]">
          <option value="all">Everyone</option>
          {members.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter…"
            className="pl-7 pr-3 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-8"><Loader2 size={15} className="animate-spin" />Loading…</div>
      ) : !listed.length ? (
        <p className="text-sm text-[#8595a8] py-8">No activity recorded yet — entries appear as team members make changes.</p>
      ) : (
        <div className="border border-[#e4ebf2] rounded-xl bg-white overflow-hidden">
          {listed.map((r, i) => (
            <div key={r.id} className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-1.5", i > 0 && "border-t border-[#eef3f8]") }>
              <span className="text-xs text-[#8595a8] whitespace-nowrap w-36">
                {new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="text-sm font-medium text-[#1f3559]">{r.user_email.split("@")[0]}</span>
              <span className="text-sm text-[#34568a]">{describe(r)}</span>
              <span className="text-[11px] text-[#b9c3d0] font-mono truncate">{r.method} {r.path}{r.query ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
