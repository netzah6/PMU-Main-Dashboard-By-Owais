"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";

/* Mac Mini screenshots: thumbnails that open ONE pop-up you slide through
   (arrows, ← / → keys, swipe) and close with ×, Esc or a click outside —
   instead of opening and closing a tab per picture (owner, 10/17/2026). */

export type Shot = { name?: string; url: string };

export default function ScreenshotGallery({ shots, variant = "grid" }: { shots: Shot[]; variant?: "grid" | "row" | "chip" }) {
  const [open, setOpen] = useState<number | null>(null);
  const touchX = useRef<number | null>(null);
  const n = shots.length;

  const close = useCallback(() => setOpen(null), []);
  const go = useCallback((d: number) => setOpen((i) => (i === null ? i : (i + d + n) % n)), [n]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, close, go]);

  if (!n) return null;
  const label = (s: Shot, i: number) => s.name || `Screenshot ${i + 1}`;
  const cur = open === null ? null : shots[open];

  return (
    <>
      {variant === "chip" ? (
        <button type="button" onClick={() => setOpen(0)} title="Screenshots"
          className="inline-flex items-center gap-1 rounded-full border border-[#cfe9e6] bg-[#f3fbfa] px-1.5 py-px text-[10px] font-semibold text-[#0e8f88] hover:border-[#15B7AE]">
          📷 {n}
        </button>
      ) : variant === "grid" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {shots.map((s, i) => (
            <button key={i} type="button" onClick={() => setOpen(i)} className="block text-left rounded-lg border border-black/10 overflow-hidden bg-white hover:border-[#15B7AE]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt={label(s, i)} className="w-full h-28 object-cover object-top" loading="lazy" />
              <span className="block px-2 py-1 text-[10px] text-[#697a91] truncate">{label(s, i)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {shots.map((s, i) => (
            <button key={i} type="button" onClick={() => setOpen(i)} title={s.name} className="block w-24 rounded-md border border-black/10 overflow-hidden bg-white hover:border-[#15B7AE]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt={label(s, i)} className="w-full h-14 object-cover object-top" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {cur && open !== null && typeof document !== "undefined" && createPortal(
        <div
          role="dialog" aria-modal="true" aria-label="Screenshots"
          className="fixed inset-0 z-[1000] flex flex-col bg-black/85 backdrop-blur-sm"
          onClick={close}
          onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
          onTouchEnd={(e) => {
            const x0 = touchX.current; touchX.current = null;
            const x1 = e.changedTouches[0]?.clientX;
            if (x0 === null || x1 === undefined || Math.abs(x1 - x0) < 40) return;
            go(x1 < x0 ? 1 : -1);
          }}
        >
          <div className="flex items-center gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
            <span className="text-sm font-semibold tabular-nums">{open + 1} / {n}</span>
            <span className="text-sm text-white/80 truncate flex-1">{label(cur, open)}</span>
            <a href={cur.url} target="_blank" rel="noreferrer" title="Open full size" className="p-2 rounded-full hover:bg-white/10"><ExternalLink className="w-4 h-4" /></a>
            <button type="button" onClick={close} title="Close (Esc)" className="p-2 rounded-full hover:bg-white/10"><X className="w-5 h-5" /></button>
          </div>

          <div className="relative flex-1 min-h-0 flex items-center justify-center px-12 sm:px-16">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cur.url} alt={label(cur, open)} onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full object-contain rounded-lg shadow-2xl select-none" draggable={false} />
            {n > 1 && (
              <>
                <button type="button" onClick={(e) => { e.stopPropagation(); go(-1); }} title="Previous (←)"
                  className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/15 text-white hover:bg-white/30">
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); go(1); }} title="Next (→)"
                  className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/15 text-white hover:bg-white/30">
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}
          </div>

          {n > 1 && (
            <div className="flex gap-2 justify-center overflow-x-auto px-4 py-3" onClick={(e) => e.stopPropagation()}>
              {shots.map((s, i) => (
                <button key={i} type="button" onClick={() => setOpen(i)} title={label(s, i)}
                  className={`shrink-0 w-16 h-10 rounded overflow-hidden border-2 ${i === open ? "border-[#15B7AE]" : "border-transparent opacity-60 hover:opacity-100"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt="" className="w-full h-full object-cover object-top" />
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
