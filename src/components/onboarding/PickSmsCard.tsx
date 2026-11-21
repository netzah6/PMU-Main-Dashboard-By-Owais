"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* Funnels tab: the pick-time text to QUIET pickers (owner, 11/21/2026). Leads
   who pick a time but never text back get no pay link by text today; half of
   them get ONE text about an hour after the pick, the other half nothing, so
   the hold side shows what the text adds. Off until the owner approves the
   text below and switches it on. Data: /api/onebox/pick-sms. */

type Side = {
  enrolled: number; pending: number; decided: number; sent: number; skipped: Record<string, number>;
  open: number; paid: number; matured: { open: number; paid: number }; earlier: number; clicked: number; paidAfterClick: number;
  paidPct: number | null; // the server sends a % only once the gate below is met
};
type Data = {
  settings: { enabled: boolean; startAt: string | null };
  tableMissing: boolean;
  sides: { sms: Side; hold: Side };
  gate: { minPerSide: number; minPaid: number; ready: boolean };
  firstMatureOn: string | null;
  errors: number; lastError: string | null;
  preview: { text: string; template: string; chars: number; unicode: boolean; segments: number };
};

const usDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
const n = (x: number) => x.toLocaleString("en-US");
const SKIP_LABEL: Record<string, string> = {
  paid: "paid before the text", paid_earlier: "already paid on an earlier visit", replied: "texted back (not quiet)",
  sms_dnd: "texts turned off (DND)", no_phone: "no phone", slot_passed: "time passed or under 3 h away", booked: "booked in chat",
  contact_gone: "contact deleted", funnel_off: "client paused or opted out", too_late: "too late to send", no_lead_row: "lead record gone",
  send_failed: "send failed 3×", check_failed: "couldn't check 3×", paused: "switched off mid-way",
};
const skipLine = (s: Record<string, number>) => Object.entries(s).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${SKIP_LABEL[k] ?? k}`).join(" · ");

export function PickSmsCard() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/onebox/pick-sms");
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setD(j); setErr(""); } else setErr(j.error || "Couldn't load");
  }, []);
  useEffect(() => { load().catch(() => setErr("Couldn't load")); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await fetch("/api/onebox/pick-sms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle", enabled }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Failed");
      setConfirming(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (err && !d) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#b91c1c]">💬 Pick-time text: {err}</div>;
  if (!d) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#697a91]">💬 Pick-time text — loading…</div>;

  const on = d.settings.enabled;
  const s = d.sides.sms, h = d.sides.hold, g = d.gate;
  const enoughPeople = s.matured.open >= g.minPerSide && h.matured.open >= g.minPerSide;
  /* A REAL gate: no % and no winner until each side has enough people past
     their 7 days AND enough payments between them — the server only sends
     the % once that's true. */
  const verdict = !on
    ? "Off — no texts are going out."
    : g.ready && s.paidPct != null && h.paidPct != null
      ? `Result: ${s.paidPct}% paid with the text, ${h.paidPct}% without.`
      : enoughPeople
        ? `Too early to decide — only ${s.matured.paid + h.matured.paid} payments so far, we need ${g.minPaid}.`
        : s.matured.open + h.matured.open > 0
          ? `Too early to decide — we need ${n(g.minPerSide)} people on each side who picked 7+ days ago (now ${n(s.matured.open)} and ${n(h.matured.open)}).`
          : `Too early to decide — the first people reach 7 days on ${d.firstMatureOn ? usDay(d.firstMatureOn) : "—"}.`;

  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((x) => !x)} className="w-full flex flex-wrap items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-medium text-[#1c2b3a]">💬 Pick-time text — 50/50</span>
        <span className="ml-auto text-xs text-[#4a5a6e]">
          {on ? `With text: ${s.paid} paid · Without: ${h.paid} paid · ${g.ready ? "result is in" : "too early to decide"}` : "Off"}
        </span>
        <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold",
          on ? "bg-[#e7f6ec] text-[#15803d] border-[#86efac]" : "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]")}>
          {on ? "On" : "Off"}
        </span>
        <span className="text-[#697a91] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 text-xs text-[#4a5a6e]">
          <p className="text-[#1c2b3a]">
            Some leads pick a time but never text back, so the AI never sends them the pay link.
            <b> Half of them get 1 text</b> about an hour after the pick. <b>The other half get nothing.</b> Then we compare how many paid.
          </p>

          {d.tableMissing && (
            <p className="rounded-lg bg-[#fff7ed] px-3 py-2 text-[#9a3412]">The database table isn&apos;t created yet — it can&apos;t be switched on.</p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {([["Got the text", s, "texted"], ["Got no text", h, "recorded"]] as const).map(([label, side, verb]) => (
              <div key={label} className="rounded-lg border border-[#eef2f6] bg-[#fafcfd] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wide text-[#8595a8]">{label}</div>
                <div className="text-xl font-bold text-[#1c2b3a]">{side.paid} paid</div>
                <div className="text-[#697a91]">out of {n(side.open)} people</div>
                <div className="mt-1 text-[10px] text-[#8595a8]">{n(side.enrolled)} picked · {n(side.decided)} {verb} · {n(side.pending)} waiting</div>
              </div>
            ))}
          </div>

          <p className={cn("rounded-lg px-3 py-2 font-semibold", g.ready ? "bg-[#e7f6ec] text-[#15803d]" : "bg-[#f6f9fc] text-[#1c2b3a]")}>{verdict}</p>

          {on && s.sent > 0 && <p>{n(s.sent)} texts sent so far · {s.clicked} people opened the link · {s.paidAfterClick} paid after opening</p>}

          <div className="flex flex-wrap items-center gap-2">
            {on ? (
              <button disabled={busy} onClick={() => toggle(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#1c2b3a] hover:bg-[#f6f9fc] disabled:opacity-60">
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Switch off
              </button>
            ) : confirming ? (
              <>
                <span className="text-[#1c2b3a]">Start texting new quiet pickers now?</span>
                <button disabled={busy} onClick={() => toggle(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#15B7AE] px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Yes, switch on
                </button>
                <button disabled={busy} onClick={() => setConfirming(false)} className="rounded-lg border border-[#e4ebf2] px-3 py-1.5">Cancel</button>
              </>
            ) : (
              <button disabled={d.tableMissing} onClick={() => setConfirming(true)} className="rounded-lg border border-[#15B7AE] px-3 py-1.5 font-semibold text-[#0e8f88] hover:bg-[#effaf9] disabled:opacity-50">
                Switch on…
              </button>
            )}
            {err && <span className="text-[#b91c1c]">{err}</span>}
          </div>

          <details className="rounded-lg border border-[#eef2f6] px-3 py-2">
            <summary className="cursor-pointer font-semibold text-[#1c2b3a]">See the text and the small print</summary>
            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1 font-semibold text-[#1c2b3a]">The text — about 1 hour after the pick (sample lead)</div>
                <div className="max-w-[360px] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-[#e9eef4] px-3 py-2 text-[13px] leading-snug text-[#1c2b3a]">{d.preview.text}</div>
                <div className="mt-1 text-[10px] text-[#8595a8]">
                  {d.preview.chars} characters · {d.preview.segments} SMS segment{d.preview.segments === 1 ? "" : "s"}{d.preview.unicode ? " (the emoji makes it Unicode: 70 characters a segment instead of 160)" : ""}
                </div>
              </div>
              <p>Why people on the text side got no text: {skipLine(s.skipped) || "—"}</p>
              <p>Same checks on the no-text side: {skipLine(h.skipped) || "—"}</p>
              {d.errors > 0 && <p>{d.errors} with an error{d.lastError ? <> · last: <span className="text-[#b91c1c]">{d.lastError}</span></> : null}</p>}
              <p className="text-[10px] text-[#8595a8]">
                Only quiet pickers count: no message from the lead on any channel since she picked, not paid, texts not turned off, a phone
                on file, and the picked time 3+ hours away. Both sides go through the same checks at the same moment (daytime for the
                lead, 9 AM–8 PM); the no-text side is only recorded. One text per person, ever. Paid = paid within 7 days of picking a
                time, counted among people not yet paid when the text went. Left out: people who had already paid on an earlier visit
                ({s.earlier + h.earlier}). The % shows only once {n(g.minPerSide)} people per side are 7+ days past their pick and there
                are {g.minPaid}+ payments between them. Opens can include phones that build a link preview.
              </p>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
