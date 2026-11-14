"use client";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

/* Sign-in for a client: her mobile number, then the 6-digit code we text her
   (owner, 11/14/2026). The server decides everything — whether sign-in is
   open, whether she is on the beta list — and never says which. */
const INPUT = "w-full rounded-xl border border-[#d7e0ea] bg-white px-3 py-3 text-[17px] text-[#1c2b3a] outline-none placeholder:text-[#9aa8b8] focus:border-[#15B7AE]";
const BTN = "flex w-full items-center justify-center gap-2 rounded-xl bg-[#15B7AE] px-4 py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-50";

export function SignInForm() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code" | "closed">("phone");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const call = async (body: Record<string, string>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/client-app/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { state?: string; redirect?: string; error?: string };
      if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
      return j;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      return null;
    } finally { setBusy(false); }
  };
  const askCode = async () => {
    const j = await call({ phone });
    if (j) { setStep(j.state === "closed" ? "closed" : "code"); setCode(""); }
  };
  const checkCode = async () => {
    const j = await call({ phone, code });
    if (j?.redirect) window.location.href = j.redirect;
  };

  if (step === "closed") {
    return (
      <div className="text-center">
        <p className="text-base font-bold text-[#1c2b3a]">Sign-in is not open yet.</p>
        <p className="mt-1 text-sm text-[#7b8a9c]">Your success coach will tell you when your app is ready.</p>
        <button onClick={() => setStep("phone")} className="mt-3 text-sm font-semibold text-[#0e8f88]">‹ Back</button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {step === "phone" ? (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-bold text-[#1c2b3a]">Your mobile number</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" className={INPUT}
              onKeyDown={(e) => { if (e.key === "Enter" && phone.trim()) void askCode(); }} />
          </label>
          <button onClick={() => void askCode()} disabled={busy || !phone.trim()} className={BTN}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} {busy ? "One moment…" : "Text me a code"}
          </button>
          <p className="text-center text-xs text-[#9aa8b8]">We text a 6-digit code to this number.</p>
        </>
      ) : (
        <>
          <p className="text-sm text-[#52627a]">If this number is on our list, a code is on its way by text. Type it here.</p>
          <label className="block">
            <span className="mb-1 block text-sm font-bold text-[#1c2b3a]">6-digit code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
              className={`${INPUT} text-center text-2xl font-extrabold tracking-[0.4em]`} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) void checkCode(); }} />
          </label>
          <button onClick={() => void checkCode()} disabled={busy || code.length !== 6} className={BTN}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} {busy ? "Checking…" : "Sign in"}
          </button>
          <button onClick={() => { setStep("phone"); setErr(null); }} className="block w-full text-center text-sm font-semibold text-[#0e8f88]">‹ Use another number</button>
        </>
      )}
      {err && <p className="rounded-xl bg-[#fde8ee] px-3 py-2 text-center text-xs font-semibold text-[#be123c]">{err}</p>}
    </div>
  );
}
