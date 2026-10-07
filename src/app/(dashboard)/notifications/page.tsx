"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* 🔔 Notifications — the coach-facing feed (admins see everything).
   First source: a client completed their info-request form (the unique
   link minted on the Funnels tab); the row names the assigned coach. */
type Row = { id: number; created_at: string; type: string; title: string; body: string | null; coach: string | null; read_at: string | null };

export default function NotificationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => {
    fetch("/api/notifications").then(async (r) => { const j = await r.json(); if (r.ok) setRows(j.rows); }).catch(() => {});
  };
  useEffect(load, []);
  const markRead = async (id: number) => {
    setBusy(id);
    try { await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); load(); }
    finally { setBusy(null); }
  };
  return (
    <div className="p-4 sm:p-6 max-w-3xl">
      <h1 className="text-lg font-bold text-[#1c2b3a] mb-1">🔔 Notifications</h1>
      <p className="text-xs text-[#697a91] mb-4">When a client fills their info-request form, it shows up here with the assigned coach&apos;s name — the funnel is already updated, nothing to copy by hand.</p>
      {rows === null && <p className="text-sm text-[#697a91] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-[#8595a8]">Nothing yet.</p>}
      <div className="grid gap-2">
        {(rows ?? []).map((r) => (
          <div key={r.id} className={cn("rounded-xl border p-3 bg-white", r.read_at ? "border-[#eef2f6] opacity-70" : "border-[#bfe9e5]")}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#1c2b3a]">{r.title}</p>
                {r.body && <p className="text-xs text-[#56678a] mt-0.5">{r.body}</p>}
                <p className="text-[11px] text-[#8595a8] mt-1">
                  {new Date(r.created_at).toLocaleString()} {r.coach ? <>· coach: <b>{r.coach}</b></> : null}
                </p>
              </div>
              {!r.read_at && (
                <button onClick={() => void markRead(r.id)} disabled={busy === r.id}
                  className="text-[11px] border border-[#e4ebf2] rounded-lg px-2 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1 shrink-0">
                  {busy === r.id ? <Loader2 size={10} className="animate-spin" /> : null} Mark read
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
