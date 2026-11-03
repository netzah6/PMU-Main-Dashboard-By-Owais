"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* Funnels tab: the "finish your deposit" email (owner, 11/03/2026). Leads who
   picked a time but didn't pay get 2 emails (1 h + 1 day), half of them only,
   so the other half shows what the emails add. Off until the owner reads the
   two emails below and switches it on (planned 11/25, after the deposit-ask
   test is read). Data: /api/onebox/pick-email. */

type Side = { people: number; open: number; paid: number; paidPct: number | null };
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
  paid: "paid before the email", finished: "got both emails", slot_passed: "time already passed", no_email: "no email on file",
  email_dnd: "opted out of email", contact_gone: "contact deleted", failed: "send failed 3×", booked: "booked in chat",
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

  return (
    <div className="mb-4 border border-[#e4ebf2] rounded-xl bg-white">
      <button onClick={() => setOpen((x) => !x)} className="w-full flex flex-wrap items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-sm font-medium text-[#1c2b3a]">✉️ Deposit reminder email — 50/50</span>
        <span className="ml-auto text-xs text-[#4a5a6e]">
          {on
            ? `On since ${d.settings.startAt ? usDay(d.settings.startAt) : "—"} · email ${e.paidPct ?? 0}% paid vs no email ${h.paidPct ?? 0}%`
            : `Off · planned ${usDay(d.planned)} — read the 2 emails, then switch on`}
        </span>
        <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-semibold",
          on ? "bg-[#e7f6ec] text-[#15803d] border-[#86efac]" : "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]")}>
          {on ? "On" : "Off"}
        </span>
        <span className="text-[#697a91] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 text-xs text-[#4a5a6e]">
          <p className="text-[#1c2b3a]">
            Who gets it: people who picked a date and time on the booking page but didn&apos;t pay. Email 1 about an hour after the pick,
            email 2 a day later — each only if they still haven&apos;t paid (checked right before sending, including payments by text link).
            Half of the pickers get the emails and half don&apos;t, so we see what the emails add. Sent from the artist&apos;s own account
            (booking.pmu-care.com), daytime in the lead&apos;s time zone.
          </p>

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

          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            {[
              ["Email side · paid", e.open ? `${e.paid} of ${e.open} (${e.paidPct}%)` : "—"],
              ["No-email side · paid", h.open ? `${h.paid} of ${h.open} (${h.paidPct}%)` : "—"],
              ["Emails sent", `${d.sent.first} first · ${d.sent.second} second`],
              ["Send errors", d.errors ? String(d.errors) : "0"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-[#eef2f6] bg-[#fafcfd] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[#8595a8]">{k}</div>
                <div className="text-sm font-semibold text-[#1c2b3a]">{v}</div>
              </div>
            ))}
          </div>
          {stops.length > 0 && (
            <p>Stopped early (email side): {stops.map(([k, n]) => `${n} ${STOP_LABEL[k] ?? k}`).join(" · ")}</p>
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
            Preview uses a sample name and a sample funnel. Paid = paid within 7 days of picking a time; people who paid on the page within
            the first hour are left out on both sides (the email would never reach them).
          </p>
        </div>
      )}
    </div>
  );
}
