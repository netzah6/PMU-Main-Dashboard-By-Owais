"use client";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

/* Daily ad budget: $25 a day to start (owner, 11/12/2026); she can pick more.
   One tap, shows it is working, then says the team will set it. */
export function BudgetPicker({ token, daily, options, recommended }: { token: string; daily: number; options: readonly number[]; recommended: number }) {
  const [value, setValue] = useState(daily);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<"saved" | "error" | null>(null);
  const pick = async (amount: number) => {
    if (amount === value || busy != null) return;
    setBusy(amount); setNote(null);
    try {
      const r = await fetch("/api/client-app/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, amount }) });
      if (!r.ok) throw new Error();
      setValue(amount); setNote("saved");
    } catch { setNote("error"); } finally { setBusy(null); }
  };
  return (
    <div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {options.map((o) => (
          <button key={o} onClick={() => void pick(o)} disabled={busy != null} aria-pressed={value === o}
            className={`relative rounded-xl border px-1 py-2.5 text-center active:opacity-80 disabled:opacity-70 ${value === o ? "border-[#15B7AE] bg-[#e6f7f5]" : "border-[#d7e0ea] bg-white"}`}>
            <span className={`flex items-center justify-center gap-1 text-base font-extrabold ${value === o ? "text-[#0e8f88]" : "text-[#1c2b3a]"}`}>
              {busy === o ? <Loader2 size={14} className="animate-spin" /> : value === o ? <Check size={14} /> : null}${o}
            </span>
            <span className="block text-[10px] font-semibold text-[#8595a8]">{o === recommended ? "start here" : "a day"}</span>
          </button>
        ))}
      </div>
      {note === "saved" && <p className="mt-2 text-center text-xs font-semibold text-[#15803d]">Saved — your team will set ${value} a day for you.</p>}
      {note === "error" && <p className="mt-2 text-center text-xs font-semibold text-[#be123c]">That didn&apos;t save. Please try again.</p>}
    </div>
  );
}
