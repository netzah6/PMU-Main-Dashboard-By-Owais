"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, Download, Eraser, PenLine, Type } from "lucide-react";
import { AgreementView } from "@/components/agreement/AgreementView";
import type { Agreement } from "@/lib/agreement";
import { usDate } from "@/lib/esign";

type View = {
  template: string;
  templateLabel: string;
  content: Agreement;
  partnerName: string;
  partnerEmail: string;
  status: "sent" | "signed";
  signedAt: string | null;
  signerName: string | null;
  consentText: string;
  reference: string;
};

const SCRIPT_FONT = "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', 'Apple Chancery', cursive";

/* Signature pad: pointer events cover mouse, pen and touch. The canvas is
   drawn at device-pixel resolution so the saved PNG is sharp. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const points = useRef(0);
  const lastW = useRef(0);
  const [resized, setResized] = useState(false);

  const setup = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    setResized(false);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    lastW.current = w;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b1f44";
    points.current = 0;
    onChange(null);
  }, [onChange]);

  useEffect(() => { setup(); }, [setup]);

  // The pad is sized once per width. When the width changes (phone rotation,
  // window resize) the old scale would misplace the strokes, so the pad is
  // reset and the signer is asked to sign again.
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (Math.abs(c.clientWidth - lastW.current) < 1) return;
      const had = points.current > 0;
      drawing.current = false;
      setup();
      if (had) setResized(true);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [setup]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d"); const p = pos(e);
    ctx?.beginPath(); ctx?.moveTo(p.x, p.y); ctx?.lineTo(p.x + 0.1, p.y + 0.1); ctx?.stroke();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext("2d"); const p = pos(e);
    ctx?.lineTo(p.x, p.y); ctx?.stroke();
    points.current++;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const c = ref.current;
    if (c && points.current > 3) onChange(c.toDataURL("image/png"));
  };

  return (
    <div>
      <canvas ref={ref}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
        className="w-full h-[150px] rounded-lg border-2 border-dashed border-[#b8c7d9] bg-white touch-none cursor-crosshair"
        aria-label="Draw your signature here" />
      <div className="flex items-center justify-between mt-1">
        {resized
          ? <span className="text-[11px] font-semibold text-[#b45309]">The screen changed size. Please sign again.</span>
          : <span className="text-[11px] text-[#8595a8]">Draw with your finger or mouse</span>}
        <button type="button" onClick={setup} className="flex items-center gap-1 text-[12px] font-semibold text-[#34568a] px-2 py-1 rounded-lg border border-[#d7e0ea] bg-white">
          <Eraser size={12} /> Clear
        </button>
      </div>
    </div>
  );
}

/** Typed name → PNG in a script font (so every signature is an image). */
function typedPng(name: string): string | null {
  const t = name.trim();
  if (t.length < 2) return null;
  const c = document.createElement("canvas");
  c.width = 900; c.height = 260;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  let size = 110;
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  while (ctx.measureText(t).width > 840 && size > 30) { size -= 4; ctx.font = `${size}px ${SCRIPT_FONT}`; }
  ctx.fillStyle = "#0b1f44"; ctx.textBaseline = "middle";
  ctx.fillText(t, 30, 135);
  return c.toDataURL("image/png");
}

// Outside the page component on purpose: a component defined inside it
// would remount on every keystroke (losing focus and the drawn signature).
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f3f7fb] px-3 sm:px-4 py-6 overflow-x-hidden">
      <div className="mx-auto w-full max-w-[800px] space-y-4">{children}</div>
    </div>
  );
}

export function SignClient({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onDrawn = useCallback((v: string | null) => setDrawn(v), []);

  useEffect(() => {
    fetch(`/api/sign/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setLoadErr(j.error || "This link is not valid"); return; }
        setView(j); setName(j.partnerName ?? ""); setEmail(j.partnerEmail ?? "");
      })
      .catch(() => setLoadErr("Could not load — check your connection and refresh"));
  }, [token]);

  const hasSignature = mode === "draw" ? !!drawn : typed.trim().length >= 2;
  const ready = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) && hasSignature && consent;

  async function sign() {
    if (!ready || busy) return;
    const png = mode === "draw" ? drawn : typedPng(typed);
    if (!png) { setErr("Please add your signature"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/sign/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), email: email.trim(), signature: png, method: mode === "draw" ? "drawn" : "typed", consent,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok || (r.status === 409 && j.status === "signed")) { setView(j); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      setErr(j.error || "Could not sign — please try again");
    } catch { setErr("Could not sign — check your connection and try again"); }
    finally { setBusy(false); }
  }

  if (loadErr) return <Shell><div className="rounded-2xl border border-[#e4ebf2] bg-white p-6 text-center text-[14px] text-[#1f3559]">{loadErr}</div></Shell>;
  if (!view) return <Shell><div className="flex items-center justify-center gap-2 p-10 text-[14px] text-[#697a91]"><Loader2 size={16} className="animate-spin" /> Loading your agreement…</div></Shell>;

  if (view.status === "signed") {
    return (
      <Shell>
        <div className="rounded-2xl border border-[#c7edd4] bg-[#e6f7ee] p-5 text-center space-y-3">
          <CheckCircle2 size={36} className="mx-auto text-[#15803d]" />
          <h1 className="text-[18px] font-bold text-[#14532d]">Signed</h1>
          <p className="text-[13px] text-[#166534]">
            {view.signerName ? `${view.signerName} signed` : "Signed"} on {usDate(view.signedAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}. Thank you!
          </p>
          <a href={`/api/sign/${encodeURIComponent(token)}/pdf`}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#15B7AE] text-white text-[14px] font-semibold">
            <Download size={16} /> Download your signed copy
          </a>
          <p className="text-[11px] text-[#4d7c5f]">Reference {view.reference}</p>
        </div>
        <AgreementView agreement={view.content} signatureSlot={<p className="text-[12px] text-[#697a91]">Signed by {view.signerName} on {usDate(view.signedAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>} />
      </Shell>
    );
  }

  const input = "w-full px-3 py-2.5 rounded-lg border border-[#d7e0ea] bg-white text-[15px] text-[#1f3559] focus:outline-none focus:border-[#15B7AE]";
  return (
    <Shell>
      <div className="rounded-2xl border border-[#cfe3f7] bg-[#f7fbff] p-4 text-[13px] text-[#1f3559]">
        <b>Please read your agreement</b> below, then sign at the bottom. It takes about a minute.
      </div>

      <AgreementView
        agreement={view.content}
        signatureSlot={
          <div className="rounded-xl border border-[#e4ebf2] bg-[#fafcff] p-3 sm:p-4 space-y-3" id="sign">
            <h3 className="text-[14px] font-bold text-[#1f3559]">Sign here</h3>
            <label className="block">
              <span className="text-[12px] font-semibold text-[#34568a]">Full legal name</span>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} autoComplete="name" className={input} />
            </label>
            <label className="block">
              <span className="text-[12px] font-semibold text-[#34568a]">Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value.slice(0, 200))} autoComplete="email" className={input} />
            </label>
            <div>
              <div className="flex gap-1.5 mb-2">
                {([["draw", "Draw", PenLine], ["type", "Type", Type]] as const).map(([m, label, Icon]) => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] font-semibold border ${mode === m ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#34568a] border-[#d7e0ea]"}`}>
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </div>
              {mode === "draw" ? (
                <SignaturePad onChange={onDrawn} />
              ) : (
                <div>
                  <input value={typed} onChange={(e) => setTyped(e.target.value.slice(0, 80))} placeholder="Type your name" className={input} />
                  <div className="mt-2 h-[90px] rounded-lg border-2 border-dashed border-[#b8c7d9] bg-white flex items-center px-4 overflow-hidden">
                    <span className="text-[36px] text-[#0b1f44] truncate" style={{ fontFamily: SCRIPT_FONT }}>{typed}</span>
                  </div>
                </div>
              )}
            </div>
            <label className="flex items-start gap-2 text-[13px] text-[#1f3559]">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#15B7AE]" />
              <span>{view.consentText}</span>
            </label>
            <p className="text-[12px] text-[#697a91]">Date: {usDate(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
            {err && <p className="text-[13px] text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-3 py-2">{err}</p>}
            <button type="button" onClick={sign} disabled={!ready || busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#15B7AE] text-white text-[15px] font-bold disabled:opacity-50">
              {busy ? <><Loader2 size={16} className="animate-spin" /> Signing…</> : "Sign"}
            </button>
          </div>
        }
      />
      <p className="text-center text-[11px] text-[#8595a8]">Reference {view.reference}</p>
    </Shell>
  );
}
