"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, RotateCcw, Send, Square, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { VOICE_NOTE_MAX_SECONDS, canRecord, toMp3 } from "@/lib/voice-note-client";

/* 🎤 Voice note for a chat (owner, 2026-10-07). Record → listen back → Send.
   Nothing leaves the browser until Send: the recording becomes a small MP3
   and goes to the client as a text with audio, from the business number. */

type Phase = "idle" | "asking" | "recording" | "encoding" | "ready" | "sending";
const VOICE_CHANNELS = new Set(["SMS", "WhatsApp"]);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function VoiceNoteButton({ contactId, contactName, channel, onSent }: {
  contactId: string | null; contactName: string; channel: string; onSent?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /* One recording attempt at a time. Every start, cancel and unmount bumps
     the session; anything that resolves for an older session (the mic
     permission, the MP3 encode) cleans up after itself and changes nothing —
     so a cancelled or abandoned attempt can never turn the mic on in the
     background or bring a thrown-away note back. */
  const session = useRef(0);
  // The live attempt's own teardown (stops its mic + timer), if one is running.
  const teardown = useRef<(() => void) | null>(null);
  const rec = useRef<MediaRecorder | null>(null);

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
    setSecs(0); setErr(null);
  };
  // Leaving the chat mid-recording must release the microphone.
  useEffect(() => () => endAttempt(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The previous note's audio is freed when it's replaced, and on unmount.
  useEffect(() => () => { if (note) URL.revokeObjectURL(note.url); }, [note]);

  const start = async () => {
    endAttempt();
    discard();
    const id = session.current;
    setPhase("asking");
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (id !== session.current) return;
      setPhase("idle");
      const name = (e as { name?: string })?.name;
      setErr(name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone blocked — allow it in the browser's address bar, then try again"
        : name === "NotFoundError" ? "No microphone found on this device" : "Couldn't start recording");
      return;
    }
    // Cancelled, closed or restarted while the browser was asking: hand the mic back.
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
          if (id !== session.current) return; // thrown away while it was being prepared
          if (seconds < 1) throw new Error("That was too short — hold on a second longer");
          setNote({ blob: mp3, url: URL.createObjectURL(mp3), seconds });
          setPhase("ready");
        } catch (e) {
          if (id !== session.current) return;
          setErr(e instanceof Error ? e.message : "Couldn't prepare the recording");
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
      setErr("Couldn't start recording");
    }
  };
  const stop = () => { if (rec.current?.state === "recording") rec.current.stop(); };
  const cancel = () => { endAttempt(); discard(); setPhase("idle"); };

  const send = async () => {
    if (!note || !contactId) return;
    setPhase("sending"); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", new File([note.blob], "voice-note.mp3", { type: "audio/mpeg" }));
      fd.append("contactId", contactId);
      fd.append("channel", channel);
      const r = await fetch("/api/ghl/reply/voice", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Couldn't send the voice note");
      toast.success(`Voice note sent to ${contactName}`);
      discard(); setPhase("idle");
      onSent?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't send the voice note");
      setPhase("ready");
    }
  };

  const supported = canRecord();
  const allowed = VOICE_CHANNELS.has(channel) && !!contactId;
  if (phase === "idle") {
    return (
      <span className="flex items-center gap-1.5">
        <button onClick={() => void start()} disabled={!supported || !allowed}
          title={!supported ? "This browser can't record audio"
            : !contactId ? "No contact id — open the chat in GHL"
            : !VOICE_CHANNELS.has(channel) ? "Voice notes go by text (SMS) or WhatsApp"
            : `Record a voice note for ${contactName} (up to ${VOICE_NOTE_MAX_SECONDS / 60} min)`}
          className="px-2.5 py-1.5 rounded-lg border border-[#c9dbfb] bg-white text-[#34568a] hover:border-[#4f46e5] hover:text-[#4f46e5] text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40">
          <Mic size={13} /> Voice note
        </button>
        {err && <span className="text-[10.5px] text-[#be123c]">{err}</span>}
      </span>
    );
  }

  return (
    <div className="basis-full mt-1 rounded-lg border border-[#c9dbfb] bg-white px-2 py-1.5 flex items-center gap-2 flex-wrap">
      {phase === "asking" && <span className="text-[11px] text-[#697a91] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Waiting for the microphone…</span>}
      {phase === "recording" && (
        <>
          <span className="w-2 h-2 rounded-full bg-[#e11d48] animate-pulse" />
          <span className="text-[12px] font-semibold text-[#1f3559] tabular-nums">Recording {clock(secs)}</span>
          <span className="text-[10.5px] text-[#8595a8]">/ {clock(VOICE_NOTE_MAX_SECONDS)}</span>
          <button onClick={stop} className="px-2.5 py-1 rounded-lg bg-[#e11d48] text-white text-xs font-semibold flex items-center gap-1"><Square size={11} /> Stop</button>
        </>
      )}
      {phase === "encoding" && <span className="text-[11px] text-[#697a91] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Preparing the voice note…</span>}
      {(phase === "ready" || phase === "sending") && note && (
        <>
          <audio controls src={note.url} className="h-8 max-w-[260px]" />
          <span className="text-[10.5px] text-[#8595a8] tabular-nums">{clock(note.seconds)} · {Math.round(note.blob.size / 1024)} KB</span>
          <button onClick={() => void send()} disabled={phase === "sending"}
            className="px-3 py-1 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {phase === "sending" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send voice note to {contactName}
          </button>
          <button onClick={() => void start()} disabled={phase === "sending"} title="Record again"
            className="px-2 py-1 rounded-lg border border-[#d7e0ea] text-[#34568a] text-xs flex items-center gap-1 disabled:opacity-40"><RotateCcw size={11} /> Re-record</button>
        </>
      )}
      <button onClick={cancel} disabled={phase === "sending"} title="Throw it away"
        className={cn("ml-auto p-1 rounded text-[#8595a8] hover:text-[#e11d48] disabled:opacity-40")}><X size={13} /></button>
      {err && <span className="basis-full text-[10.5px] text-[#be123c]">{err}</span>}
    </div>
  );
}
