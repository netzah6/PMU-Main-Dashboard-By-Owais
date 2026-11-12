"use client";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

/* "Ask my team to turn this on" — one tap, shows it is working, then says
   the request was sent (and stays that way on the next visit). */
export function AskReviewsButton({ token, sent }: { token: string; sent: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">(sent ? "sent" : "idle");
  if (state === "sent") {
    return (
      <p className="flex items-center justify-center gap-1.5 rounded-2xl bg-[#e6f7ee] px-4 py-3 text-sm font-bold text-[#15803d]">
        <Check size={16} /> Request sent — your team will turn it on
      </p>
    );
  }
  return (
    <div>
      <button disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const r = await fetch("/api/client-app/reviews-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
            setState(r.ok ? "sent" : "error");
          } catch { setState("error"); }
        }}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#15B7AE] px-4 py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-70">
        {state === "busy" && <Loader2 size={16} className="animate-spin" />}
        {state === "busy" ? "Sending…" : "Ask my team to turn this on"}
      </button>
      {state === "error" && <p className="pt-2 text-center text-xs text-[#be123c]">That didn&apos;t go through. Please try again.</p>}
    </div>
  );
}
