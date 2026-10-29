"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

/* How-to clips on each New Client Setup step (owner 10/29/2026): when the Mac
   Mini is down, a teammate does the step by hand and watches the short video
   next to it. Many small clips per step so one can be swapped without
   re-recording the rest. Admins paste a link (Loom / YouTube / Vimeo / Google
   Drive) or upload a file; everyone else just plays them. */

export type StepVideo = { id: string; step_key: string; title: string; url: string; position: number };

export function useStepVideos(): { byStep: Record<string, StepVideo[]>; reload: () => Promise<void> } {
  const [byStep, setByStep] = useState<Record<string, StepVideo[]>>({});
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/onboarding/step-videos", { cache: "no-store" });
      const j = (await r.json()) as { videos?: StepVideo[] };
      const map: Record<string, StepVideo[]> = {};
      for (const v of j.videos ?? []) (map[v.step_key] ??= []).push(v);
      setByStep(map);
    } catch { /* the steps still show without their clips */ }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { byStep, reload };
}

// Loom / YouTube / Vimeo / Google Drive play in their own player; anything
// else (our uploads, a direct .mp4) plays in a plain <video>.
function embedFor(url: string): { kind: "iframe" | "video"; src: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "loom.com") { const id = u.pathname.split("/").filter(Boolean).pop(); if (id) return { kind: "iframe", src: `https://www.loom.com/embed/${id}` }; }
    if (host === "youtu.be") return { kind: "iframe", src: `https://www.youtube.com/embed/${u.pathname.slice(1)}` };
    if (host.endsWith("youtube.com")) {
      const id = u.searchParams.get("v") ?? u.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1];
      if (id) return { kind: "iframe", src: `https://www.youtube.com/embed/${id}` };
    }
    if (host === "vimeo.com") { const id = u.pathname.split("/").filter(Boolean)[0]; if (id) return { kind: "iframe", src: `https://player.vimeo.com/video/${id}` }; }
    if (host === "drive.google.com") { const id = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? u.searchParams.get("id"); if (id) return { kind: "iframe", src: `https://drive.google.com/file/d/${id}/preview` }; }
  } catch { /* not a URL — fall through */ }
  return { kind: "video", src: url };
}

export function StepVideos({ stepKey, stepLabel, videos, isAdmin, onChanged }: {
  stepKey: string; stepLabel: string; videos: StepVideo[]; isAdmin: boolean; onChanged: () => Promise<void>;
}) {
  const [playing, setPlaying] = useState<StepVideo | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!videos.length && !isAdmin) return null;

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/onboarding/step-videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };
  const remove = async (v: StepVideo) => {
    if (!window.confirm(`Remove the video "${v.title}"?`)) return;
    setBusy(`rm:${v.id}`);
    try { await post({ action: "remove", id: v.id }); await onChanged(); toast.success("Video removed"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not remove it"); }
    finally { setBusy(null); }
  };
  const move = async (v: StepVideo, dir: -1 | 1) => {
    setBusy(`mv:${v.id}`);
    try { await post({ action: "move", id: v.id, dir }); await onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not move it"); }
    finally { setBusy(null); }
  };

  return (
    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
      {videos.map((v, i) => (
        <span key={v.id} className="inline-flex items-center rounded-full border border-[#c9dbfb] bg-[#f7faff] text-[10.5px] font-semibold text-[#2f5fb8]">
          <button onClick={() => setPlaying(v)} className="px-2 py-px hover:underline" title={`Watch: ${v.title}`}>▶ {videos.length > 1 ? `${i + 1}. ` : ""}{v.title}</button>
          {isAdmin && (
            <span className="flex items-center pr-1 text-[#8595a8]">
              {i > 0 && <button onClick={() => void move(v, -1)} disabled={!!busy} title="Move earlier" className="px-0.5 hover:text-[#2f5fb8]">‹</button>}
              {i < videos.length - 1 && <button onClick={() => void move(v, 1)} disabled={!!busy} title="Move later" className="px-0.5 hover:text-[#2f5fb8]">›</button>}
              <button onClick={() => void remove(v)} disabled={!!busy} title="Remove this video" className="px-0.5 hover:text-[#e11d48]">
                {busy === `rm:${v.id}` ? <Loader2 size={10} className="animate-spin" /> : "×"}
              </button>
            </span>
          )}
        </span>
      ))}
      {isAdmin && (
        <button onClick={() => setAdding(true)} className="px-2 py-px rounded-full border border-dashed border-[#c9dbfb] text-[10.5px] font-semibold text-[#2f5fb8] hover:bg-[#f7faff]">🎬 + Video</button>
      )}
      {playing && <PlayerModal video={playing} onClose={() => setPlaying(null)} />}
      {adding && <AddVideoModal stepKey={stepKey} stepLabel={stepLabel} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await onChanged(); }} />}
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`w-full ${wide ? "max-w-4xl" : "max-w-md"} rounded-xl bg-white shadow-xl overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#eef3f8]">
          <p className="text-sm font-semibold text-[#1f3559] truncate">{title}</p>
          <button onClick={onClose} className="text-[#8595a8] hover:text-[#1f3559]" aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function PlayerModal({ video, onClose }: { video: StepVideo; onClose: () => void }) {
  const e = embedFor(video.url);
  return (
    <Modal title={video.title} onClose={onClose} wide>
      <div className="bg-black aspect-video">
        {e.kind === "iframe"
          ? <iframe src={e.src} className="w-full h-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
          : <video src={e.src} className="w-full h-full" controls autoPlay playsInline />}
      </div>
      <p className="px-4 py-2 text-[11px] text-[#697a91]">Not playing? <a href={video.url} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">Open it in a new tab ↗</a></p>
    </Modal>
  );
}

function AddVideoModal({ stepKey, stepLabel, onClose, onAdded }: { stepKey: string; stepLabel: string; onClose: () => void; onAdded: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const save = async () => {
    if (!title.trim()) { toast.error("Give the video a short title"); return; }
    if (!file && !/^https:\/\//i.test(link.trim())) { toast.error("Paste a link or choose a video file"); return; }
    setBusy(true);
    try {
      let url = link.trim();
      if (file) {
        setProgress("Uploading…");
        const r = await fetch("/api/onboarding/step-videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upload", key: stepKey, name: file.name }) });
        const j = (await r.json()) as { path?: string; token?: string; url?: string; error?: string };
        if (!r.ok || !j.path || !j.token || !j.url) throw new Error(j.error ?? "Could not start the upload");
        const { error } = await createClient().storage.from("setup-videos").uploadToSignedUrl(j.path, j.token, file, { contentType: file.type || "video/mp4" });
        if (error) throw new Error(error.message);
        url = j.url;
      }
      setProgress("Saving…");
      const r = await fetch("/api/onboarding/step-videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", key: stepKey, title: title.trim(), url }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success("Video added");
      await onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the video");
    } finally { setBusy(false); setProgress(""); }
  };

  return (
    <Modal title={`Add a video — ${stepLabel}`} onClose={busy ? () => undefined : onClose}>
      <div className="px-4 py-3 space-y-3 text-xs">
        <label className="block">
          <span className="font-semibold text-[#34568a]">Short title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pick the number in Robokiller" maxLength={120}
            className="mt-1 w-full rounded-md border border-[#d7e0ea] px-2.5 py-1.5 outline-none focus:border-[#15B7AE]" />
        </label>
        <label className="block">
          <span className="font-semibold text-[#34568a]">Paste a link</span>
          <input value={link} onChange={(e) => { setLink(e.target.value); if (e.target.value) setFile(null); }} placeholder="Loom, YouTube, Vimeo or Google Drive link" disabled={!!file}
            className="mt-1 w-full rounded-md border border-[#d7e0ea] px-2.5 py-1.5 outline-none focus:border-[#15B7AE] disabled:bg-[#f8fafc]" />
        </label>
        <div>
          <span className="font-semibold text-[#34568a]">…or upload a file</span>
          <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={!!link.trim()}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-[11px] text-[#475569]" />
          <p className="mt-0.5 text-[10.5px] text-[#8595a8]">MP4, MOV or WebM. For long recordings a Loom link is faster.</p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          {progress && <span className="text-[11px] text-[#697a91] flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> {progress}</span>}
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-md border border-[#d7e0ea] text-[#64748b] hover:bg-[#f8fafc] disabled:opacity-50">Cancel</button>
          <button onClick={() => void save()} disabled={busy} className="px-3 py-1.5 rounded-md font-semibold bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : "Save video"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
