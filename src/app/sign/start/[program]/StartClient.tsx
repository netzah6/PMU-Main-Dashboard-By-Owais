"use client";
import { useState } from "react";
import { Loader2, Lock, ArrowRight } from "lucide-react";

export function StartClient({ program, email: email0, name: name0 }: { program: "ppa"; email: string; name: string }) {
  const [name, setName] = useState(name0);
  const [email, setEmail] = useState(email0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/sign/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ program, name, email }),
      });
      const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!r.ok || !j.token) { setErr(j.error || "Something went wrong. Please try again."); setBusy(false); return; }
      window.location.assign(`/sign/${j.token}`);
    } catch {
      setErr("No connection. Please try again."); setBusy(false);
    }
  }

  const input = "mt-1 w-full px-3 py-2.5 rounded-lg border border-[#cbd5e1] bg-white text-[15px] text-[#0f172a] focus:outline-none focus:border-[#15B7AE] focus:ring-2 focus:ring-[#15B7AE]/20";
  return (
    <div className="min-h-screen bg-[#eef2f6] overflow-x-hidden">
      <div className="bg-white border-b border-[#e2e8f0]">
        <div className="mx-auto w-full max-w-[860px] px-4 h-[52px] flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-logo.png" alt="" width={350} height={280} className="h-[34px] w-auto object-contain" />
          <span className="text-[14px] font-bold text-[#0f172a] truncate">PMU Bookings On Demand</span>
          <span className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-[#0e9f99] shrink-0"><Lock size={12} /> Secure signing</span>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[520px] px-4 py-8">
        <form onSubmit={go} className="rounded-2xl border border-[#e2e8f0] bg-white p-5 sm:p-6 shadow-sm space-y-4">
          <div>
            <h1 className="text-[19px] font-bold text-[#0f172a]">Your Scope of Service</h1>
            <p className="text-[13px] text-[#475569] mt-1">Type your name and email to open your Scope of Service and sign it.</p>
          </div>
          <label className="block text-[13px] font-semibold text-[#1f3559]">Full name
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} />
          </label>
          <label className="block text-[13px] font-semibold text-[#1f3559]">Email
            <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={200} />
          </label>
          {err && <p className="text-[13px] font-semibold text-[#b91c1c]">{err}</p>}
          <button type="submit" disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#15B7AE] text-white text-[15px] font-semibold disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} Open my Scope of Service
          </button>
        </form>
      </div>
    </div>
  );
}
