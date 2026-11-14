"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* Funnels tab: the "finish your deposit" email (owner, 11/03/2026). Leads who
   picked a time but didn't pay get 2 emails (1 h + 1 day), half of them only,
   so the other half shows what the emails add. Off until the owner reads the
   two emails below and switches it on (planned 11/25, after the deposit-ask
   test is read). Data: /api/onebox/pick-email. */

type Side = {
  people: number; open: number; paid: number;
  paidPct: number | null; matured: { open: number; paid: number }; // % = people whose pick is 7+ days old only
  earlier: number; emailedTracked: number; clicked: number; paidAfterClick: number;
};
/* No % until the comparison means something: this many people past their
   7 days on each side, and this many payments between them. */
const READ_MIN_OPEN = 300, READ_MIN_PAID = 30;
type Data = {
  settings: { enabled: boolean; startAt: string | null };
  planned: string;
  sides: { email: Side; hold: Side };
  sent: { first: number; second: number };
  stopped: Record<string, number>;
  errors: number; lastError: string | null;
  preview: { subject: string; html: string }[];
};

const usDay = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
const STOP_LABEL: Record<string, string> = {
  paid: "paid before the email", paid_earlier: "already paid on an earlier visit", finished: "got both emails", slot_passed: "time already passed",
  no_email: "no email on file", invalid_email: "email address invalid", email_dnd: "opted out of email", contact_gone: "contact deleted",
  failed: "send failed 3×", booked: "booked in chat",
  funnel_off: "client paused", too_late: "too late to send", no_lead_row: "lead record gone", paused: "switched off mid-way",
};

export function DepositEmailCard() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/onebox/pick-email");
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setD(j); setErr(""); } else setErr(j.error || "Couldn't load");
  }, []);
  useEffect(() => { load().catch(() => setErr("Couldn't load")); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await fetch("/api/onebox/pick-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle", enabled }) });
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

  if (err && !d) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#b91c1c]">✉️ Deposit reminder email: {err}</div>;
  if (!d) return <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white px-4 py-2.5 text-xs text-[#697a91]">✉️ Deposit reminder email — loading…</div>;

  const on = d.settings.enabled;
  const e = d.sides.email, h = d.sides.hold;
  const stops = Object.entries(d.stopped).filter(([k]) => k !== "hold").sort((a, b) => b[1] - a[1]);
  const ready = e.matured.open >= READ_MIN_OPEN && h.matured.open >= READ_MIN_OPEN && e.matured.paid + h.matured.paid >= READ_MIN_PAID;
  const firstMature = d.settings.startAt ? usDay(new Date(Date.parse(d.settings.startAt) + 7 * 86400_000).toISOString()) : null;
  const enoughPeople = e.matured.open >= READ_MIN_OPEN && h.matured.open >= READ_MIN_OPEN;
  /* Plain-words verdict (owner, 11/14/2026: "I don't understand what's going on there"). */
  const verdict = !on
    ? "Off — no emails are going out."
    : ready
      ? `Result: ${e.paidPct}% paid with the emails, ${h.paidPct}% without.`
      : enoughPeople
        ? `Too early to decide — only ${e.matured.paid + h.matured.paid} payments so far, we need ${READ_MIN_PAID}.`
        : e.matured.open + h.matured.open > 0
          ? `Too early to decide — we need ${READ_MIN_OPEN} people on each side who picked 7+ days ago (now ${e.matured.open} and ${h.matured.open}).`
          : `Too early to decide — the first people reach 7 days on ${firstMature ?? "—"}.`;

  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((x) => !x)} className="w-full flex flex-wrap items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-medium text-[#1c2b3a]">✉️ Deposit reminder email — does it bring more deposits?</span>
        <span className="ml-auto text-xs text-[#4a5a6e]">
          {on ? `With emails: ${e.paid} paid · Without: ${h.paid} paid · ${ready ? "result is in" : "too early to decide"}` : "Off"}
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
            Some leads pick a time but don&apos;t pay the deposit. <b>Half of them get 2 reminder emails</b> (after 1 hour and after 1 day).
            <b> The other half get nothing.</b> Then we compare how many paid on each side.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            {([["Got the 2 emails", e], ["Got no email", h]] as const).map(([label, side]) => (
              <div key={label} className="rounded-lg border border-[#eef2f6] bg-[#fafcfd] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wide text-[#8595a8]">{label}</div>
                <div className="text-xl font-bold text-[#1c2b3a]">{side.paid} paid</div>
                <div className="text-[#697a91]">out of {side.open.toLocaleString("en-US")} people</div>
              </div>
            ))}
          </div>

          <p className={cn("rounded-lg px-3 py-2 font-semibold", ready ? "bg-[#e7f6ec] text-[#15803d]" : "bg-[#f6f9fc] text-[#1c2b3a]")}>{verdict}</p>

          {on && (
            <p>
              {(d.sent.first + d.sent.second).toLocaleString("en-US")} emails sent so far
              {e.emailedTracked ? ` · ${e.clicked} of ${e.emailedTracked} people clicked the link · ${e.paidAfterClick} paid after clicking` : ""}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {on ? (
              <button disabled={busy} onClick={() => toggle(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-[#e4ebf2] px-3 py-1.5 text-[#1c2b3a] hover:bg-[#f6f9fc] disabled:opacity-60">
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Switch off
              </button>
            ) : confirming ? (
              <>
                <span className="text-[#1c2b3a]">Start emailing new pickers now?</span>
                <button disabled={busy} onClick={() => toggle(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#15B7AE] px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Yes, switch on
                </button>
                <button disabled={busy} onClick={() => setConfirming(false)} className="rounded-lg border border-[#e4ebf2] px-3 py-1.5">Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirming(true)} className="rounded-lg border border-[#15B7AE] px-3 py-1.5 font-semibold text-[#0e8f88] hover:bg-[#effaf9]">
                Switch on…
              </button>
            )}
            {err && <span className="text-[#b91c1c]">{err}</span>}
          </div>

          <details className="rounded-lg border border-[#eef2f6] px-3 py-2">
            <summary className="cursor-pointer font-semibold text-[#1c2b3a]">See the 2 emails and the small print</summary>
            <div className="mt-3 space-y-3">
              <p>Sent: {d.sent.first} first emails · {d.sent.second} second emails · {d.errors} send errors.</p>
              {stops.length > 0 && (
                <p>Why some people on the email side got fewer emails: {stops.map(([k, n]) => `${n} ${STOP_LABEL[k] ?? k}`).join(" · ")}</p>
              )}
              {d.lastError && <p className="text-[#b91c1c]">Last send error: {d.lastError}</p>}
              <div className="grid gap-4 md:grid-cols-2">
                {d.preview.map((m, i) => (
                  <div key={i} className="min-w-0">
                    <div className="mb-1 font-semibold text-[#1c2b3a]">Email {i + 1} — {i === 0 ? "about 1 hour after the pick" : "1 day after the pick"}</div>
                    <div className="mb-1 break-words">Subject: <b className="text-[#1c2b3a]">{m.subject}</b></div>
                    <iframe title={`Email ${i + 1} preview`} sandbox="" srcDoc={m.html} className="w-full h-[380px] rounded-lg border border-[#eef2f6] bg-white" />
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#8595a8]">
                Emails go only if the lead still hasn&apos;t paid, from the artist&apos;s own account, daytime in the lead&apos;s time zone.
                Paid = paid within 7 days of picking a time. Left out on both sides: people who paid on the page within the first hour and
                people who had already paid on an earlier visit ({e.earlier + h.earlier}). The final % counts only people whose pick is
                7+ days old, and shows once {READ_MIN_OPEN} per side have passed that mark with {READ_MIN_PAID}+ payments between them.
                Clicks count only emails sent with the tracked link (from 11/08/2026) and can include mail apps that pre-open links.
              </p>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
