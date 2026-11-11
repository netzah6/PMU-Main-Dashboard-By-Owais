"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/* "Which clients do I owe for?" — one click copies the names still to be
   charged, ready to paste to the artist (owner, 11/11/2026). */
export type OwedLine = { name: string | null; date: string | null; how: string };

const HOW_TEXT: Record<string, string> = {
  served: "deposit booking", past_due: "deposit booking",
  self_booked: "self-booked", calendar_booked: "self-booked (calendar)",
  chat_booked: "booked in chat",
};
const usDate = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
};
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function owedText(lines: OwedLine[], fee: number, credit: number): string {
  const gross = lines.length * fee;
  const used = Math.min(credit, gross);
  const out = [`Shows not charged yet (${lines.length}):`];
  lines.forEach((l, i) => {
    const bits = [l.name || "(no name)", usDate(l.date), HOW_TEXT[l.how] ?? ""].filter(Boolean);
    out.push(`${i + 1}. ${bits.join(" — ")}`);
  });
  out.push("");
  out.push(used > 0
    ? `${lines.length} × ${usd(fee)} = ${usd(gross)} − ${usd(used)} credit = ${usd(gross - used)}`
    : `${lines.length} × ${usd(fee)} = ${usd(gross)}`);
  return out.join("\n");
}

export function CopyOwedButton({ lines, fee, credit, className }: { lines: OwedLine[]; fee: number; credit: number; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(owedText(lines, fee, credit)); setState("done"); }
    catch { setState("error"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };
  return (
    <button onClick={copy} disabled={!lines.length}
      title="Copy the names still to be charged — to paste to the client"
      className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold whitespace-nowrap disabled:opacity-50",
        state === "done" ? "bg-[#e6f7ee] border-[#c7edd4] text-[#15803d]"
          : state === "error" ? "bg-[#fde8ee] border-[#f5c2cf] text-[#e11d48]"
          : "bg-white border-[#fcd9a8] text-[#b45309] hover:bg-[#fff7ec]", className)}>
      {state === "done" ? <Check size={11} /> : <Copy size={11} />}
      {state === "done" ? "Copied" : state === "error" ? "Failed" : "Copy names"}
    </button>
  );
}
