"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

/* Square profile-picture cropper: drag the picture to place the face, slide
   to zoom, save. What you see in the square is exactly what is stored (a
   900×900 JPEG), so the decks never have to guess where the face is. */

const VIEW = 300;   // on-screen square, px
const OUT = 900;    // stored square, px

export function PhotoCropper({ file, who, onCancel, onSave }: {
  file: File;
  who: string;
  onCancel: () => void;
  onSave: (jpeg: Blob) => Promise<void>;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // size of the picture on screen at this zoom ("cover" the square at zoom 1)
  const dims = useCallback((z: number, im = img) => {
    if (!im) return { w: VIEW, h: VIEW };
    const s = Math.max(VIEW / im.naturalWidth, VIEW / im.naturalHeight) * z;
    return { w: im.naturalWidth * s, h: im.naturalHeight * s };
  }, [img]);
  const clamp = useCallback((p: { x: number; y: number }, z: number, im = img) => {
    const d = dims(z, im);
    return { x: Math.min(0, Math.max(VIEW - d.w, p.x)), y: Math.min(0, Math.max(VIEW - d.h, p.y)) };
  }, [dims, img]);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      setImg(im);
      const d = dims(1, im);
      // start centred, a little toward the top — that is where a face usually is
      setPos(clamp({ x: (VIEW - d.w) / 2, y: (VIEW - d.h) * 0.25 }, 1, im));
    };
    im.onerror = () => setError("That file is not a picture we can open. Try a JPG or PNG.");
    im.src = url;
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const onZoom = (z: number) => {
    // keep the middle of the square where it is while zooming
    const a = dims(zoom), b = dims(z);
    const cx = (VIEW / 2 - pos.x) / a.w, cy = (VIEW / 2 - pos.y) / a.h;
    setZoom(z);
    setPos(clamp({ x: VIEW / 2 - cx * b.w, y: VIEW / 2 - cy * b.h }, z));
  };

  const save = async () => {
    if (!img || busy) return;
    setBusy(true); setError("");
    try {
      const c = document.createElement("canvas");
      c.width = OUT; c.height = OUT;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("This browser can't prepare the picture");
      const k = OUT / VIEW, d = dims(zoom);
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, OUT, OUT);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, pos.x * k, pos.y * k, d.w * k, d.h * k);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.9));
      if (!blob) throw new Error("Couldn't prepare the picture");
      await onSave(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the picture");
      setBusy(false);
    }
  };

  const d = dims(zoom);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={busy ? undefined : onCancel}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-bold text-[#1f3559]">Picture for {who}</div>
        <div className="mt-0.5 text-xs text-[#697a91]">Drag the picture so the face is in the middle. Slide to zoom.</div>
        <div
          className="relative mx-auto mt-3 touch-none select-none overflow-hidden rounded-2xl border border-[#e4ebf2] bg-[#f4f7fa]"
          style={{ width: VIEW, height: VIEW, cursor: drag.current ? "grabbing" : "grab" }}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }; }}
          onPointerMove={(e) => { const g = drag.current; if (g) setPos(clamp({ x: g.x + e.clientX - g.px, y: g.y + e.clientY - g.py }, zoom)); }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {img
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ left: pos.x, top: pos.y, width: d.w, height: d.h }} />
            : !error && <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-[#15B7AE]" /></div>}
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-[#697a91]">
          Zoom
          <input type="range" min={1} max={3} step={0.01} value={zoom} disabled={!img || busy} onChange={(e) => onZoom(Number(e.target.value))} className="flex-1 accent-[#15B7AE]" />
        </label>
        {error && <div className="mt-2 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs text-[#b91c1c]">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-sm font-semibold text-[#4a5a6e] hover:bg-[#f4f7fa] disabled:opacity-60">Cancel</button>
          <button onClick={save} disabled={!img || busy} className="inline-flex items-center gap-1.5 rounded-lg bg-[#15B7AE] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#0e8f88] disabled:opacity-60">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? "Saving…" : "Save picture"}
          </button>
        </div>
      </div>
    </div>
  );
}
