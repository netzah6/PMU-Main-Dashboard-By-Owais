"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

// One indicator for every request the dashboard makes. Any button on any tab
// that calls /api/… lights this up — a thin teal bar across the very top and a
// "Working…" pill — for as long as the request is in flight, so nothing ever
// looks like it did nothing. Buttons keep their own spinners where they have
// them; this is the guarantee underneath, and it covers buttons added later
// without anyone remembering to add one.
//
// Requests shorter than SHOW_AFTER_MS never show — a 90 ms save flashing a bar
// would be worse than silence. Only same-origin /api/ calls count; Supabase
// reads from the browser client go straight to Supabase and are not fetches
// we want a spinner for.

const SHOW_AFTER_MS = 250;

let inflight = 0;
const listeners = new Set<(n: number) => void>();
let patched = false;

function patchFetch() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const ours = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
    if (!ours) return orig(input, init);
    inflight++;
    listeners.forEach((l) => l(inflight));
    try {
      return await orig(input, init);
    } finally {
      inflight = Math.max(0, inflight - 1);
      listeners.forEach((l) => l(inflight));
    }
  };
}

export function FetchActivity() {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    patchFetch();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (n: number) => {
      if (n > 0) {
        if (!timer) timer = setTimeout(() => { timer = null; setBusy(true); }, SHOW_AFTER_MS);
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
        setBusy(false);
      }
    };
    listeners.add(onChange);
    onChange(inflight);
    return () => { listeners.delete(onChange); if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    // The cursor says "working" everywhere, including over the button that
    // was just pressed, which is where the eye is.
    document.body.style.cursor = busy ? "progress" : "";
    return () => { document.body.style.cursor = ""; };
  }, [busy]);

  if (!busy) return null;
  return (
    <>
      <div className="fixed top-0 left-0 right-0 h-[3px] z-[100] overflow-hidden bg-[#d5f0ee]" aria-hidden>
        <div className="h-full w-1/3 bg-[#15B7AE] animate-[fetchbar_1s_ease-in-out_infinite]" />
      </div>
      <div role="status" aria-live="polite"
        className="fixed top-2 right-3 z-[100] flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/95 border border-[#a7e3df] text-[#0e8f88] text-[11px] font-semibold shadow-sm">
        <Loader2 size={12} className="animate-spin" /> Working…
      </div>
    </>
  );
}
