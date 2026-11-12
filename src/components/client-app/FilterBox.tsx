"use client";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";

/* Search line for a tab (owner, 11/11/2026: "if they want to search for a
   specific appointment or a lead"). The lists are rendered on the server;
   this only shows/hides the rows inside `target` that carry a data-q text.
   While searching, folded sections open so a match is never hidden, and
   blocks marked data-qgroup disappear when none of their rows match. */
export function FilterBox({ target, placeholder }: { target: string; placeholder: string }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    const root = document.getElementById(target);
    if (!root) return;
    const needle = q.trim().toLowerCase();
    let n = 0;
    root.querySelectorAll<HTMLElement>("[data-q]").forEach((el) => {
      const hit = !needle || (el.dataset.q ?? "").includes(needle);
      el.style.display = hit ? "" : "none";
      if (hit) n++;
    });
    root.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => {
      if (needle) { if (!d.open) { d.dataset.autoOpen = "1"; d.open = true; } }
      else if (d.dataset.autoOpen) { d.open = false; delete d.dataset.autoOpen; }
    });
    root.querySelectorAll<HTMLElement>("[data-qgroup]").forEach((g) => {
      const any = [...g.querySelectorAll<HTMLElement>("[data-q]")].some((el) => el.style.display !== "none");
      g.style.display = !needle || any ? "" : "none";
    });
    setShown(needle ? n : null);
  }, [q, target]);
  return (
    <div>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8595a8]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} inputMode="search" enterKeyHint="search"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          className="w-full rounded-2xl border border-[#e4ebf2] bg-white py-2.5 pl-9 pr-9 text-[16px] text-[#1c2b3a] placeholder:text-[#9aa8b8] focus:border-[#15B7AE] focus:outline-none" />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-[#8595a8]">
            <X size={16} />
          </button>
        )}
      </div>
      {shown === 0 && <p className="px-1 pt-2 text-sm text-[#7b8a9c]">Nothing matches &ldquo;{q.trim()}&rdquo;.</p>}
    </div>
  );
}
