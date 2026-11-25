"use client";
import { useRef, useState } from "react";
import { ExternalLink, Loader2, Trash2, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { TY_LIMITS, type TyExtra } from "@/lib/ty-extra";
import { cn } from "@/lib/utils";

/* ✏️ Thank-you page box (owner, 11/25/2026): coaches add the artist's own
   note, website button, picture and video to the thank-you step without
   asking the owner. Saves through /api/onebox/admin {action:"thankyou"};
   pictures and videos go to the public "onboarding" bucket the same way the
   onboarding form uploads them. */

const VIDEO_MAX = 200 * 1024 * 1024;

export function TyExtraEditor({ slug, url, initial, onSaved, onClose }: {
  slug: string;
  url: string;
  initial: TyExtra | null;
  onSaved: (t: TyExtra | null) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(initial?.note ?? "");
  const [linkLabel, setLinkLabel] = useState(initial?.linkLabel ?? "");
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl ?? "");
  const [img, setImg] = useState(initial?.img ?? "");
  const [video, setVideo] = useState(initial?.video ?? "");
  const [busy, setBusy] = useState<"" | "save" | "img" | "video">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);

  const uploadImg = async (file: File) => {
    setBusy("img"); setMsg(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/onboarding/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error ?? "Upload failed");
      setImg(j.url);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally { setBusy(""); }
  };

  const uploadVideo = async (file: File) => {
    if (file.size > VIDEO_MAX) { setMsg({ ok: false, text: "That video is too big (max 200 MB). Try a shorter clip." }); return; }
    setBusy("video"); setMsg(null);
    try {
      const r = await fetch("/api/onboarding/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video: true, name: file.name }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.path || !j.token) throw new Error(j.error ?? "Could not start the upload");
      const { error } = await createClient().storage.from("onboarding").uploadToSignedUrl(j.path, j.token, file, { contentType: file.type || "video/mp4" });
      if (error) throw new Error(error.message);
      setVideo(j.url);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally { setBusy(""); }
  };

  const save = async () => {
    setBusy("save"); setMsg(null);
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "thankyou", slug, tyNote: note, tyLinkLabel: linkLabel, tyLinkUrl: linkUrl, tyImg: img, tyVideo: video }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      onSaved(j.tyExtra ?? null);
      setMsg({ ok: true, text: j.tyExtra ? "Saved ✓ It shows on the thank-you page within a minute." : "Saved ✓ The thank-you page goes back to normal within a minute." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't save" });
    } finally { setBusy(""); }
  };

  const input = "w-full border border-[#e4ebf2] rounded-lg px-2 py-1.5 text-xs text-[#1c2b3a] bg-white";
  const label = "text-[11px] font-semibold text-[#697a91]";
  return (
    <div className="mt-2 w-full max-w-xl rounded-xl border border-[#bfe6e2] bg-[#f7fdfc] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold text-[#1c2b3a]">✏️ Thank-you page — extra for this artist</div>
        <button onClick={onClose} className="ml-auto text-xs text-[#697a91] hover:underline">Close</button>
      </div>
      <p className="text-[11px] text-[#697a91]">Shows under &ldquo;You&rsquo;re booked!&rdquo; after the lead pays. Leave a box empty to skip it.</p>

      <div>
        <div className={label}>Note from the artist</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={TY_LIMITS.note}
          placeholder="Example: Please come with no makeup on your brows. Parking is behind the building." className={input} />
        <div className="text-[10px] text-[#97a5b8] text-right">{note.length}/{TY_LIMITS.note}</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
        <div>
          <div className={label}>Button text</div>
          <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} maxLength={TY_LIMITS.linkLabel} placeholder="Visit our website" className={input} />
        </div>
        <div>
          <div className={label}>Website link</div>
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://yourstudio.com" className={input} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className={label}>Picture</div>
          {img ? (
            <div className="relative mt-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt="" className="w-full max-h-40 object-cover rounded-lg border border-[#e4ebf2]" />
              <button onClick={() => setImg("")} title="Remove the picture" className="absolute top-1 right-1 bg-white/90 rounded-full p-1"><Trash2 size={12} /></button>
            </div>
          ) : (
            <button onClick={() => imgRef.current?.click()} disabled={!!busy}
              className="mt-1 w-full border border-dashed border-[#a7e3df] rounded-lg py-3 text-xs text-[#0e8f88] inline-flex items-center justify-center gap-1 hover:bg-white">
              {busy === "img" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} {busy === "img" ? "Uploading…" : "Add a picture"}
            </button>
          )}
          <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadImg(f); }} />
        </div>
        <div>
          <div className={label}>Video</div>
          {video ? (
            <div className="relative mt-1">
              <video src={`${video}#t=0.1`} controls playsInline preload="metadata" className="w-full max-h-40 rounded-lg bg-black" />
              <button onClick={() => setVideo("")} title="Remove the video" className="absolute top-1 right-1 bg-white/90 rounded-full p-1"><Trash2 size={12} /></button>
            </div>
          ) : (
            <button onClick={() => vidRef.current?.click()} disabled={!!busy}
              className="mt-1 w-full border border-dashed border-[#a7e3df] rounded-lg py-3 text-xs text-[#0e8f88] inline-flex items-center justify-center gap-1 hover:bg-white">
              {busy === "video" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} {busy === "video" ? "Uploading… keep this open" : "Add a video"}
            </button>
          )}
          <input ref={vidRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadVideo(f); }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void save()} disabled={!!busy}
          className={cn("rounded-lg px-3 py-1.5 text-xs font-semibold text-white inline-flex items-center gap-1", busy ? "bg-[#94d3cf]" : "bg-[#0e9c9c] hover:bg-[#0b8686]")}>
          {busy === "save" && <Loader2 size={12} className="animate-spin" />} {busy === "save" ? "Saving…" : "Save"}
        </button>
        <a href={`${url}?preview=thankyou`} target="_blank" rel="noopener" className="text-xs text-[#0e9c9c] hover:underline inline-flex items-center gap-1">
          See the thank-you page <ExternalLink className="w-3 h-3" />
        </a>
        {initial?.at && <span className="text-[10px] text-[#97a5b8]">last saved {new Date(initial.at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" })}{initial.by ? ` by ${initial.by}` : ""}</span>}
      </div>
      {msg && <div className={cn("text-xs rounded-lg px-2 py-1.5", msg.ok ? "bg-[#ecfdf5] text-[#047857]" : "bg-[#fef2f2] text-[#b91c1c]")}>{msg.text}</div>}
    </div>
  );
}
