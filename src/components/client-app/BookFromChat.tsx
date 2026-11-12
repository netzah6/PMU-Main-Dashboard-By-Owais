"use client";
import { useState } from "react";
import { CalendarPlus, Check, Loader2, X } from "lucide-react";
import { BTN, SlotPicker, type SlotDay } from "@/components/client-app/BookingActions";

/* "Book appointment" at the top of a chat (owner, 11/12/2026: "when they click
   on one of their contacts and they want to book their appointment, they
   should be able to do that on the chat… choose a date and time"). The free
   times come live from her calendar; the server checks again before it books
   and refuses a second appointment for the same lead. */
type Options = { calendars: Array<{ id: string; name: string }>; calendarId: string; days: SlotDay[]; already: string | null };

export function BookFromChat({ token, contactId, name }: { token: string; contactId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [opt, setOpt] = useState<Options | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<{ at: string; label: string } | null>(null);
  const [busy, setBusy] = useState<null | "load" | "book">(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async (calendar?: string) => {
    setBusy("load"); setErr(null); setPick(null);
    try {
      const r = await fetch(`/api/client-app/booking?token=${encodeURIComponent(token)}&contact=${encodeURIComponent(contactId)}${calendar ? `&calendar=${encodeURIComponent(calendar)}` : ""}`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as Partial<Options> & { error?: string };
      if (!r.ok || !j.calendarId) throw new Error(j.error || "We couldn't read your calendar. Please try again.");
      setOpt({ calendars: j.calendars ?? [], calendarId: j.calendarId, days: j.days ?? [], already: j.already ?? null });
      setDay(j.days?.[0]?.day ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We couldn't read your calendar. Please try again.");
    } finally { setBusy(null); }
  };
  const book = async () => {
    if (!opt || !pick) return;
    setBusy("book"); setErr(null);
    try {
      const r = await fetch("/api/client-app/booking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "book", contact: contactId, calendar: opt.calendarId, start: pick.at }) });
      const j = (await r.json().catch(() => ({}))) as { when?: string; error?: string };
      if (!r.ok) throw new Error(j.error || "We couldn't book it. Please try again.");
      setDone(j.when ?? "Booked"); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We couldn't book it. Please try again.");
    } finally { setBusy(null); }
  };
  const cur = opt?.days.find((d) => d.day === day) ?? null;

  if (done) {
    return <p className="flex items-center gap-1.5 rounded-xl bg-[#e6f7ee] px-3 py-2 text-xs font-semibold text-[#15803d]"><Check size={14} /> Booked: {done}. It is on your calendar.</p>;
  }
  return (
    <div>
      <button onClick={() => { const next = !open; setOpen(next); if (next && !opt) void load(); }} aria-expanded={open}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#15B7AE] bg-white px-3 py-2 text-sm font-bold text-[#0e8f88] active:opacity-80">
        {open ? <X size={15} /> : <CalendarPlus size={15} />} {open ? "Close" : "Book appointment"}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-[#e4ebf2] bg-white p-3">
          <p className="text-sm font-bold text-[#1c2b3a]">Book {name}</p>
          {busy === "load" && <p className="flex items-center gap-2 py-4 text-sm font-semibold text-[#7b8a9c]"><Loader2 size={16} className="animate-spin text-[#15B7AE]" /> Reading your calendar…</p>}
          {opt && busy !== "load" && (opt.already ? (
            <p className="mt-1 rounded-xl bg-[#fff4e5] px-3 py-2 text-xs font-semibold text-[#92400e]">She already has a time: {opt.already}. To change it, use Move on the Bookings tab.</p>
          ) : (
            <>
              {opt.calendars.length > 1 && (
                <select value={opt.calendarId} onChange={(e) => void load(e.target.value)} aria-label="Calendar"
                  className="mt-2 w-full rounded-xl border border-[#d7e0ea] bg-white px-3 py-2 text-[16px] text-[#1c2b3a] outline-none focus:border-[#15B7AE]">
                  {opt.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <SlotPicker days={opt.days} day={day} setDay={setDay} pick={pick} setPick={setPick} />
              {opt.days.length > 0 && (
                <button disabled={!pick || busy === "book"} onClick={() => void book()} className={`${BTN} mt-3 w-full bg-[#15B7AE] text-white`}>
                  {busy === "book" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                  {busy === "book" ? "Booking…" : pick && cur ? `Book ${cur.label} · ${pick.label}` : "Pick a time"}
                </button>
              )}
            </>
          ))}
          {err && <p className="mt-2 rounded-xl bg-[#fde8ee] px-3 py-2 text-center text-xs font-semibold text-[#be123c]">{err}</p>}
        </div>
      )}
    </div>
  );
}
