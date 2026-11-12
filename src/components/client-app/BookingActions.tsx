"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Loader2, X } from "lucide-react";

/* Move or cancel one upcoming appointment (owner, 11/12/2026). Two buttons,
   always in sight: "Move" and "Cancel" — he asked for Cancel as its own
   button, not behind "Change". The row itself (name, time, chat) comes in as
   children. Nothing changes until she confirms, every button shows it is
   working, and the server re-checks everything live. */
export type SlotDay = { day: string; label: string; slots: Array<{ at: string; label: string }> };
export const BTN = "flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-bold active:opacity-80 disabled:opacity-60";

/* Day chips + the free times of the chosen day. Shared with "Book appointment" in a chat. */
export function SlotPicker({ days, day, setDay, pick, setPick }: {
  days: SlotDay[]; day: string | null; setDay: (d: string) => void;
  pick: { at: string; label: string } | null; setPick: (p: { at: string; label: string } | null) => void;
}) {
  const cur = days.find((d) => d.day === day) ?? null;
  if (days.length === 0) return <p className="py-3 text-sm text-[#7b8a9c]">Your calendar has no free times in the next 30 days.</p>;
  return (
    <>
      <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {days.map((d) => (
          <button key={d.day} onClick={() => { setDay(d.day); setPick(null); }}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${d.day === day ? "border-[#15B7AE] bg-[#e6f7f5] text-[#0e8f88]" : "border-[#d7e0ea] bg-white text-[#52627a]"}`}>{d.label}</button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {(cur?.slots ?? []).map((s) => (
          <button key={s.at} onClick={() => setPick(s)} aria-pressed={pick?.at === s.at}
            className={`rounded-xl border py-2 text-sm font-semibold ${pick?.at === s.at ? "border-[#15B7AE] bg-[#15B7AE] text-white" : "border-[#d7e0ea] bg-white text-[#1c2b3a]"}`}>{s.label}</button>
        ))}
      </div>
    </>
  );
}

export function BookingActions({ token, id, name, when, children }: { token: string; id: string; name: string; when: string; children?: React.ReactNode }) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "move" | "cancel">(null);
  const [days, setDays] = useState<SlotDay[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<{ at: string; label: string } | null>(null);
  const [busy, setBusy] = useState<null | "slots" | "move" | "cancel">(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const close = () => { setMode(null); setErr(null); setPick(null); };
  const openMove = async () => {
    setMode("move"); setErr(null); setPick(null); setBusy("slots");
    try {
      const r = await fetch(`/api/client-app/booking?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { days?: SlotDay[]; error?: string };
      if (!r.ok) throw new Error(j.error || "We couldn't read your calendar. Please try again.");
      setDays(j.days ?? []); setDay(j.days?.[0]?.day ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We couldn't read your calendar. Please try again."); setDays(null);
    } finally { setBusy(null); }
  };
  const send = async (body: { action: "cancel" } | { action: "move"; start: string }, okText: string) => {
    setBusy(body.action); setErr(null);
    try {
      const r = await fetch("/api/client-app/booking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, id, ...body }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
      setDone(okText); setMode(null);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally { setBusy(null); }
  };
  const cur = days?.find((d) => d.day === day) ?? null;
  const SMALL = "flex flex-1 items-center justify-center gap-1.5 rounded-xl border bg-white px-3 py-2 text-xs font-bold active:opacity-70";

  return (
    <>
      {children}
      {done ? (
        <p className="mb-2 flex items-center gap-1.5 rounded-xl bg-[#e6f7ee] px-3 py-2 text-xs font-semibold text-[#15803d]"><Check size={14} /> {done}</p>
      ) : (
        <div className="mb-2 flex gap-2">
          <button onClick={() => (mode === "move" ? close() : void openMove())} aria-expanded={mode === "move"} aria-label={`Move ${name}'s appointment`}
            className={`${SMALL} ${mode === "move" ? "border-[#15B7AE] text-[#0e8f88]" : "border-[#d7e0ea] text-[#52627a]"}`}>
            <CalendarClock size={14} /> Move
          </button>
          <button onClick={() => (mode === "cancel" ? close() : (setMode("cancel"), setErr(null)))} aria-expanded={mode === "cancel"} aria-label={`Cancel ${name}'s appointment`}
            className={`${SMALL} ${mode === "cancel" ? "border-[#e11d48] text-[#be123c]" : "border-[#f5c2cf] text-[#be123c]"}`}>
            <X size={14} /> Cancel
          </button>
        </div>
      )}

      {mode && (
        <div className="mb-2 rounded-xl border border-[#e4ebf2] bg-[#f8fafc] p-3" data-panel>
          {mode === "move" && (
            <div>
              <p className="text-sm font-bold text-[#1c2b3a]">Move {name}</p>
              <p className="text-xs text-[#7b8a9c]">Now: {when}</p>
              {busy === "slots" && <p className="flex items-center gap-2 py-4 text-sm font-semibold text-[#7b8a9c]"><Loader2 size={16} className="animate-spin text-[#15B7AE]" /> Reading your calendar…</p>}
              {days && (
                <>
                  <SlotPicker days={days} day={day} setDay={setDay} pick={pick} setPick={setPick} />
                  {days.length > 0 && (
                    <button disabled={!pick || busy === "move"} onClick={() => pick && cur && void send({ action: "move", start: pick.at }, `Moved to ${cur.label} · ${pick.label}.`)}
                      className={`${BTN} mt-3 w-full bg-[#15B7AE] text-white`}>
                      {busy === "move" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                      {busy === "move" ? "Moving…" : pick && cur ? `Move to ${cur.label} · ${pick.label}` : "Pick a time"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {mode === "cancel" && (
            <div>
              <p className="text-sm font-bold text-[#1c2b3a]">Cancel {name}&apos;s appointment?</p>
              <p className="text-xs text-[#7b8a9c]">{when}. It comes off your calendar. We do not text your client — please let her know.</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button onClick={close} disabled={busy === "cancel"} className={`${BTN} border border-[#d7e0ea] bg-white text-[#52627a]`}>Keep it</button>
                <button onClick={() => void send({ action: "cancel" }, "Cancelled. It is off your calendar.")} disabled={busy === "cancel"} className={`${BTN} bg-[#e11d48] text-white`}>
                  {busy === "cancel" ? <Loader2 size={15} className="animate-spin" /> : null} {busy === "cancel" ? "Cancelling…" : "Yes, cancel it"}
                </button>
              </div>
            </div>
          )}
          {err && <p className="mt-2 rounded-xl bg-[#fde8ee] px-3 py-2 text-center text-xs font-semibold text-[#be123c]">{err}</p>}
        </div>
      )}
    </>
  );
}
