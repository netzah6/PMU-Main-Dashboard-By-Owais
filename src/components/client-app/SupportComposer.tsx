"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Send, Square, Trash2 } from "lucide-react";
import { VOICE_NOTE_MAX_SECONDS, canRecord, toMp3 } from "@/lib/voice-note-client";

/* Support tab composer: type a message, or record a voice note → listen back
   → Send. Nothing leaves the phone until Send. Every button shows it is
   working. Same one-attempt-at-a-time recorder rule as the team's voice note
   (a cancelled attempt can never leave the mic on). */

type Phase = "idle" | "asking" | "recording" | "encoding" | "ready" | "sending";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function SupportComposer({ token, coachFirst, count }: { token: string; coachFirst: string | null; count: number }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const session = useRef(0);
  const teardown = useRef<(() => void) | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  // The box is sticky (always "in view"), so the page itself is scrolled down.
  const toNewest = (smooth = false) => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });

  useEffect(() => { setSupported(canRecord()); }, []);
  // Open on the newest message, like a messaging app.
  useEffect(() => { toNewest(); }, [count]);

  const endAttempt = () => {
    session.current++;
    const r = rec.current;
    rec.current = null;
    if (r && r.state !== "inactive") { r.onstop = null; r.stop(); }
    teardown.current?.();
    teardown.current = null;
  };
  const discard = () => {
    setNote((n) => { if (n) URL.revokeObjectURL(n.url); return null; });
    setSecs(0);
  };
  useEffect(() => () => endAttempt(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (note) URL.revokeObjectURL(note.url); }, [note]);

  const start = async () => {
    endAttempt(); discard(); setErr(null);
    const id = session.current;
    setPhase("asking");
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (id !== session.current) return;
      setPhase("idle");
      const name = (e as { name?: string })?.name;
      setErr(name === "NotAllowedError" || name === "SecurityError" ? "Please allow the microphone, then try again."
        : name === "NotFoundError" ? "No microphone found on this phone." : "Couldn't start recording.");
      return;
    }
    if (id !== session.current) { s.getTracks().forEach((t) => t.stop()); return; }
    let timer: ReturnType<typeof setInterval> | null = null;
    const release = () => { if (timer) clearInterval(timer); timer = null; s.getTracks().forEach((t) => t.stop()); };
    teardown.current = release;
    try {
      const r = new MediaRecorder(s);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      r.onstop = async () => {
        release();
        if (id !== session.current) return;
        rec.current = null; teardown.current = null;
        setPhase("encoding");
        try {
          const { mp3, seconds } = await toMp3(new Blob(chunks, { type: r.mimeType || chunks[0]?.type }));
          if (id !== session.current) return;
          if (seconds < 1) throw new Error("That was too short — hold on a second longer.");
          setNote({ blob: mp3, url: URL.createObjectURL(mp3), seconds });
          setPhase("ready");
        } catch (e) {
          if (id !== session.current) return;
          setErr(e instanceof Error ? e.message : "Couldn't prepare the recording.");
          setPhase("idle");
        }
      };
      rec.current = r;
      r.start(250);
      const t0 = Date.now();
      setSecs(0);
      setPhase("recording");
      timer = setInterval(() => {
        const s2 = (Date.now() - t0) / 1000;
        setSecs(s2);
        if (s2 >= VOICE_NOTE_MAX_SECONDS && r.state === "recording") r.stop();
      }, 250);
    } catch {
      release(); teardown.current = null; rec.current = null;
      setPhase("idle");
      setErr("Couldn't start recording.");
    }
  };
  const stop = () => { if (rec.current?.state === "recording") rec.current.stop(); };
  const cancel = () => { endAttempt(); discard(); setErr(null); setPhase("idle"); };

  const send = async () => {
    const body = text.trim();
    if (!body && !note) return;
    const back: Phase = note ? "ready" : "idle";
    setPhase("sending"); setErr(null);
    try {
      const fd = new FormData();
      fd.append("token", token);
      fd.append("text", body);
      if (note) {
        fd.append("file", new File([note.blob], "voice-note.mp3", { type: "audio/mpeg" }));
        fd.append("seconds", String(note.seconds));
      }
      const r = await fetch("/api/client-app/support", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || "That didn't go through. Please try again.");
      setText(""); discard(); setPhase("idle");
      router.refresh(); // the new message arrives with the refreshed list, which scrolls down (count)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't go through. Please try again.");
      setPhase(back);
    }
  };

  const busy = phase === "sending";
  const recording = phase === "asking" || phase === "recording" || phase === "encoding";
  return (
    <div className="sticky z-[6] -mx-3 border-t border-[#e4ebf2] bg-[#f3f7fb]/95 px-3 pb-2 pt-2 backdrop-blur"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 68px)" }}>
      {err && <p className="pb-1.5 text-center text-xs text-[#be123c]">{err}</p>}

      {recording ? (
        <div className="flex items-center gap-2 rounded-2xl border border-[#f5c2cf] bg-white px-3 py-2.5">
          {phase === "recording" ? (
            <>
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#e11d48]" />
              <span className="text-sm font-bold tabular-nums text-[#1c2b3a]">Recording {clock(secs)}</span>
              <span className="text-xs text-[#8595a8]">/ {clock(VOICE_NOTE_MAX_SECONDS)}</span>
              <button onClick={stop} className="ml-auto flex items-center gap-1.5 rounded-full bg-[#e11d48] px-3.5 py-1.5 text-sm font-bold text-white active:opacity-80">
                <Square size={13} /> Stop
              </button>
            </>
          ) : (
            <span className="flex items-center gap-2 text-sm text-[#52627a]">
              <Loader2 size={15} className="animate-spin" /> {phase === "asking" ? "Waiting for the microphone…" : "Preparing your voice note…"}
            </span>
          )}
          <button onClick={cancel} aria-label="Cancel" className={`${phase === "recording" ? "" : "ml-auto "}rounded-full p-2 text-[#8595a8] active:opacity-70`}><Trash2 size={17} /></button>
        </div>
      ) : (
        <>
          {note && (
            <div className="mb-2 flex items-center gap-2 rounded-2xl border border-[#bfe9e5] bg-white px-3 py-2">
              <audio controls src={note.url} className="h-9 min-w-0 flex-1" />
              <span className="text-xs tabular-nums text-[#8595a8]">{clock(note.seconds)}</span>
              <button onClick={cancel} disabled={busy} aria-label="Delete voice note" className="rounded-full p-1.5 text-[#8595a8] active:opacity-70 disabled:opacity-40"><Trash2 size={16} /></button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000} disabled={busy}
              placeholder={coachFirst ? `Message ${coachFirst}…` : "Write a message…"}
              className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none rounded-2xl border border-[#d7e0ea] bg-white px-3.5 py-2.5 text-[15px] leading-snug text-[#1c2b3a] outline-none placeholder:text-[#9aa8b8] focus:border-[#15B7AE] disabled:opacity-60" />
            {!note && !text.trim() ? (
              <button onClick={() => void start()} disabled={!supported || busy} aria-label="Record a voice note"
                title={supported ? "Record a voice note" : "This phone's browser can't record audio"}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#bfe9e5] bg-white text-[#0e8f88] active:opacity-80 disabled:opacity-40">
                <Mic size={19} />
              </button>
            ) : (
              <button onClick={() => void send()} disabled={busy} aria-label="Send"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#15B7AE] text-white active:opacity-80 disabled:opacity-70">
                {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            )}
          </div>
        </>
      )}
      <p className="pt-1.5 text-center text-[11px] text-[#9aa8b8]">Demo — your coach doesn&apos;t get these messages yet.</p>
    </div>
  );
}
