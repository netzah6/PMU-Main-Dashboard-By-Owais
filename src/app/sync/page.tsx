"use client";
import { useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import {
  RefreshCw, CheckCircle, XCircle, AlertCircle,
  ArrowRight, Clock, Database, Sheet, LayoutDashboard,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface SyncResult {
  table: string;
  sheetName: string;
  sheetRows: number;
  supabaseRowsBefore: number;
  supabaseRowsAfter: number;
  status: "ok" | "error";
  error?: string;
  durationMs: number;
}

interface ValidationResult {
  table: string;
  sheetRows: number;
  supabaseRows: number;
  inSync: boolean;
  missingInSupabase: number;
  extraInSupabase: number;
}

type Mode = "idle" | "validating" | "syncing";

export default function SyncPage() {
  const { user, role, loading } = useUser();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null);
  const [validationResults, setValidationResults] = useState<ValidationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  if (!loading && role !== "admin") {
    router.push("/clients");
    return null;
  }

  async function handleDiscover() {
    setMode("validating");
    setError(null);
    try {
      const res = await fetch("/api/sync/discover");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Discovery failed");
      alert(JSON.stringify(json.spreadsheets, null, 2));
    } catch (e) {
      setError(String(e));
    } finally {
      setMode("idle");
    }
  }

  async function handleValidate() {
    setMode("validating");
    setError(null);
    setValidationResults(null);
    try {
      const res = await fetch("/api/sync/validate");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Validation failed");
      setValidationResults(json.results);
      setLastRun(json.timestamp);
    } catch (e) {
      setError(String(e));
    } finally {
      setMode("idle");
    }
  }

  async function handleSyncAll() {
    if (!confirm("This will DELETE and re-insert all Supabase data from Google Sheets. Continue?")) return;
    setMode("syncing");
    setError(null);
    setSyncResults(null);
    try {
      const res = await fetch("/api/cron/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET ?? "pmu-cron-2026"}`,
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      setSyncResults(json.results);
      setLastRun(json.timestamp);
    } catch (e) {
      setError(String(e));
    } finally {
      setMode("idle");
    }
  }

  async function handleSyncOne(table: string) {
    setMode("syncing");
    setError(null);
    try {
      const res = await fetch("/api/cron/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET ?? "pmu-cron-2026"}`,
        },
        body: JSON.stringify({ table }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      // Merge this result into existing sync results
      setSyncResults((prev) => {
        const result = json.results[0];
        if (!prev) return [result];
        const idx = prev.findIndex((r) => r.table === table);
        if (idx >= 0) { const n = [...prev]; n[idx] = result; return n; }
        return [...prev, result];
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setMode("idle");
    }
  }

  const isBusy = mode !== "idle";

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar userEmail={user?.email} syncing={mode === "syncing"} />

      <div className="max-w-5xl mx-auto w-full px-6 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-[#1f3559] flex items-center gap-2">
              <Database size={20} className="text-[#0e8f88]" />
              Data Sync & Validation
            </h1>
            <p className="text-sm text-[#697a91] mt-1">
              Validate and sync Google Sheets → Supabase
            </p>
          </div>
          {lastRun && (
            <span className="text-xs text-[#8595a8] flex items-center gap-1">
              <Clock size={11} /> Last run: {new Date(lastRun).toLocaleString()}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3">
          <Link href="/clients"
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-[#1f3559] transition-colors"
            style={{ background: "#34568a", border: "1px solid #15B7AE" }}>
            <LayoutDashboard size={14} style={{ color: "#15B7AE" }} />
            Go to Dashboard
          </Link>

          <button
            onClick={handleDiscover}
            disabled={isBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-[#d7e0ea] text-[#34568a] bg-white hover:bg-[#e4ebf2] disabled:opacity-40 transition-colors"
          >
            <Sheet size={14} />
            Discover Tab Names
          </button>

          <button
            onClick={handleValidate}
            disabled={isBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-[#a7e3df] text-[#0e8f88] bg-[#e6f7f5] hover:bg-[#e6f7f5] disabled:opacity-40 transition-colors"
          >
            {mode === "validating" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <CheckCircle size={14} />
            )}
            Validate All (read-only)
          </button>

          <button
            onClick={handleSyncAll}
            disabled={isBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-[#1f3559] disabled:opacity-40 transition-colors"
            style={{ background: isBusy ? "#0e8f88" : "#15B7AE" }}
          >
            {mode === "syncing" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {mode === "syncing" ? "Syncing…" : "Sync All Sheets Now"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-3 bg-[#fde8ee] border border-[#f5c2cf] rounded-lg text-[#e11d48] text-sm">
            {error}
          </div>
        )}

        {/* Validation results */}
        {validationResults && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[#34568a]">Validation Report</h2>
            <div className="rounded-xl border border-[#e4ebf2] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white border-b border-[#e4ebf2]">
                    <th className="px-4 py-3 text-left text-xs text-[#697a91] uppercase">Table</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Sheet Rows</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Supabase Rows</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Missing</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Extra</th>
                    <th className="px-4 py-3 text-center text-xs text-[#697a91] uppercase">Status</th>
                    <th className="px-4 py-3 text-center text-xs text-[#697a91] uppercase">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {validationResults.map((r, i) => (
                    <tr key={r.table} className={cn(
                      "border-b border-[#e4ebf2]",
                      i % 2 === 0 ? "bg-white" : "bg-white/10"
                    )}>
                      <td className="px-4 py-3 font-mono text-xs text-[#34568a]">{r.table}</td>
                      <td className="px-4 py-3 text-right text-[#34568a]">{r.sheetRows < 0 ? "—" : r.sheetRows}</td>
                      <td className="px-4 py-3 text-right text-[#34568a]">{r.supabaseRows < 0 ? "—" : r.supabaseRows}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={r.missingInSupabase > 0 ? "text-[#e11d48] font-medium" : "text-[#8595a8]"}>
                          {r.missingInSupabase || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={r.extraInSupabase > 0 ? "text-[#d97706]" : "text-[#8595a8]"}>
                          {r.extraInSupabase || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {r.inSync ? (
                          <span className="flex items-center justify-center gap-1 text-[#0e8f88] text-xs">
                            <CheckCircle size={13} /> In Sync
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-1 text-[#e11d48] text-xs">
                            <XCircle size={13} /> Out of Sync
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {!r.inSync && (
                          <button
                            onClick={() => handleSyncOne(r.table)}
                            disabled={isBusy}
                            className="text-xs px-2 py-1 rounded bg-[#15B7AE] hover:bg-[#0e8f88] text-[#0e8f88] disabled:opacity-40 flex items-center gap-1 mx-auto"
                          >
                            <ArrowRight size={10} /> Fix
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-4 text-xs text-[#8595a8]">
              <span><span className="text-[#0e8f88]">■</span> In Sync = sheet rows match Supabase rows</span>
              <span><span className="text-[#e11d48]">■</span> Missing = rows in Sheet but not in Supabase</span>
              <span><span className="text-[#d97706]">■</span> Extra = rows in Supabase but not in Sheet</span>
            </div>
          </div>
        )}

        {/* Sync results */}
        {syncResults && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[#34568a]">Sync Results</h2>
            <div className="rounded-xl border border-[#e4ebf2] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white border-b border-[#e4ebf2]">
                    <th className="px-4 py-3 text-left text-xs text-[#697a91] uppercase">Table</th>
                    <th className="px-4 py-3 text-left text-xs text-[#697a91] uppercase">Sheet</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Sheet Rows</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Before</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">After</th>
                    <th className="px-4 py-3 text-right text-xs text-[#697a91] uppercase">Time</th>
                    <th className="px-4 py-3 text-center text-xs text-[#697a91] uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {syncResults.map((r, i) => (
                    <tr key={r.table} className={cn(
                      "border-b border-[#e4ebf2]",
                      i % 2 === 0 ? "bg-white" : "bg-white/10"
                    )}>
                      <td className="px-4 py-3 font-mono text-xs text-[#34568a]">{r.table}</td>
                      <td className="px-4 py-3 text-xs text-[#697a91]">{r.sheetName}</td>
                      <td className="px-4 py-3 text-right text-[#34568a]">{r.sheetRows}</td>
                      <td className="px-4 py-3 text-right text-[#8595a8]">{r.supabaseRowsBefore}</td>
                      <td className="px-4 py-3 text-right text-[#0e8f88] font-medium">{r.supabaseRowsAfter}</td>
                      <td className="px-4 py-3 text-right text-[#8595a8]">{r.durationMs}ms</td>
                      <td className="px-4 py-3 text-center">
                        {r.status === "ok" ? (
                          <span className="flex items-center justify-center gap-1 text-[#0e8f88] text-xs">
                            <CheckCircle size={13} /> Done
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-1 text-[#e11d48] text-xs" title={r.error}>
                            <XCircle size={13} /> Error
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {syncResults.some((r) => r.status === "error") && (
              <div className="space-y-1">
                {syncResults.filter((r) => r.status === "error").map((r) => (
                  <div key={r.table} className="text-xs text-[#e11d48] bg-[#fde8ee] px-3 py-2 rounded border border-[#f5c2cf]">
                    <strong>{r.table}:</strong> {r.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Info box */}
        <div className="bg-white border border-[#e4ebf2] rounded-xl p-5 space-y-2 text-sm text-[#697a91]">
          <div className="flex items-center gap-2 text-[#34568a] font-medium">
            <AlertCircle size={14} className="text-[#d97706]" />
            How sync works
          </div>
          <ul className="space-y-1 text-xs list-disc list-inside">
            <li><strong>Validate</strong> — read-only check: compares row counts between Google Sheets and Supabase. No data is changed.</li>
            <li><strong>Sync All</strong> — deletes ALL current Supabase rows for each table, then re-inserts fresh from Google Sheets. This is a full replace.</li>
            <li><strong>Fix (per table)</strong> — same as Sync All but for one table only.</li>
            <li>The Vercel Cron job runs this automatically every 15 minutes.</li>
            <li>The Google Apps Script onEdit trigger handles real-time single-row updates.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
