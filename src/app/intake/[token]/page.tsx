"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/* Public info-request form (no login): shows ONLY the fields the agency
   is still missing for this client; submitting writes them straight into
   the funnel setup. */
type Field = { k: string; label: string; hint?: string; type: "text" | "textarea" };

export default function IntakePage({ params }: { params: { token: string } }) {
  const [business, setBusiness] = useState<string>("");
  const [fields, setFields] = useState<Field[] | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [state, setState] = useState<"loading" | "form" | "done" | "error" | "saving">("loading");
  useEffect(() => {
    fetch(`/api/intake/${params.token}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) { setState("error"); return; }
        setBusiness(j.business ?? "");
        setFields(j.fields ?? []);
        setState((j.fields ?? []).length ? "form" : "done");
      })
      .catch(() => setState("error"));
  }, [params.token]);

  const submit = async () => {
    setState("saving");
    try {
      const r = await fetch(`/api/intake/${params.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vals),
      });
      if (r.ok) setState("done"); else setState("form");
    } catch { setState("form"); }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-[#f3f7fb] flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-[#e4ebf2] bg-white p-6 shadow-sm">
        <h1 className="text-lg font-bold text-[#1c2b3a] mb-1">
          {business || "Your studio"} — quick setup questions
        </h1>
        {children}
      </div>
    </div>
  );

  if (state === "loading") return <Shell><p className="text-sm text-[#697a91] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p></Shell>;
  if (state === "error") return <Shell><p className="text-sm text-[#697a91]">This link isn&apos;t valid any more — please ask your account manager for a fresh one.</p></Shell>;
  if (state === "done") return <Shell><p className="text-sm text-[#15803d] font-semibold">All set — thank you! 🎉</p><p className="text-sm text-[#697a91] mt-1">We have everything we need. Your booking page updates automatically.</p></Shell>;

  return (
    <Shell>
      <p className="text-sm text-[#697a91] mb-4">A few details are missing from your booking page. Fill in what you can — it updates your page automatically.</p>
      <div className="grid gap-3">
        {(fields ?? []).map((f) => (
          <label key={f.k} className="grid gap-1">
            <span className="text-xs font-semibold text-[#34568a]">{f.label}</span>
            {f.hint && <span className="text-[11px] text-[#8595a8]">{f.hint}</span>}
            {f.type === "textarea" ? (
              <textarea value={vals[f.k] ?? ""} onChange={(e) => setVals((x) => ({ ...x, [f.k]: e.target.value }))}
                rows={3} className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#0e9c9c]" />
            ) : (
              <input value={vals[f.k] ?? ""} onChange={(e) => setVals((x) => ({ ...x, [f.k]: e.target.value }))}
                className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#0e9c9c]" />
            )}
          </label>
        ))}
      </div>
      <button onClick={() => void submit()} disabled={state === "saving" || !Object.values(vals).some((v) => v.trim())}
        className="mt-5 w-full bg-[#0e9c9c] text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-[#0b8383] disabled:opacity-50 inline-flex items-center justify-center gap-2">
        {state === "saving" ? <Loader2 size={14} className="animate-spin" /> : null} Send
      </button>
    </Shell>
  );
}
