"use client";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/* "It's loading" sign for every tap that opens another screen (owner,
   11/12/2026). It appears the instant a link inside the app is tapped and
   goes away when the new screen is there — so a slow screen never looks like
   a tap that did nothing. */
export function NavProgress({ base }: { base: string }) {
  const path = usePathname() ?? "";
  const query = useSearchParams()?.toString() ?? "";
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [path, query]); // the new screen arrived
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith(base)) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setBusy(true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [base]);
  // Never stay on forever (a tap that was cancelled, the phone went offline…).
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 20_000);
    return () => clearTimeout(t);
  }, [busy]);
  if (!busy) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 z-30 flex justify-center" style={{ top: "calc(env(safe-area-inset-top) + 72px)" }} role="status" aria-live="polite">
      <span className="flex items-center gap-2 rounded-full border border-[#bfe9e5] bg-white px-3.5 py-1.5 text-xs font-bold text-[#0e8f88] shadow-md">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </span>
    </div>
  );
}
