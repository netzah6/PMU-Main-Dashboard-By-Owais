"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import type { WeekEvent, WeekView } from "@/lib/client-app-bookings";
import { BookingActions } from "@/components/client-app/BookingActions";

/* Her week as a calendar (owner, 11/12/2026: "show our clients like a calendar
   so they will be able to see how their week looks like, when they have
   appointments and their hours"). Seven days side by side on the studio's own
   clock: white = her opening hours, grey = closed, a block = an appointment.
   A tap on a block opens it underneath: chat, move, cancel. */
const HOUR = 44; // px per hour
const KIND: Record<WeekEvent["kind"], { label: string; block: string; chip: string }> = {
  booked: { label: "Booked", block: "bg-[#15B7AE] text-white", chip: "bg-[#e6f7f5] text-[#0e8f88]" },
  hold: { label: "Waiting for deposit", block: "border border-dashed border-[#d97706] bg-[#fff4e5] text-[#92400e]", chip: "bg-[#fff4e5] text-[#b45309]" },
  done: { label: "Came in", block: "bg-[#86c9a0] text-white", chip: "bg-[#e6f7ee] text-[#15803d]" },
};
const hourLabel = (min: number) => { const h = Math.floor(min / 60) % 24; return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`; };
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s;

export function WeekCalendar({ token, week }: { token: string; week: WeekView }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const sel = week.events.find((e) => e.id === openId) ?? null;
  const hours = Array.from({ length: Math.max(1, (week.toMin - week.fromMin) / 60) }, (_, i) => week.fromMin + i * 60);
  const height = hours.length * HOUR;
  const top = (min: number) => ((min - week.fromMin) / 60) * HOUR;
  const base = `/m/${token}/bookings`;
  const NAV = "flex h-9 w-9 items-center justify-center rounded-full text-[#52627a] active:opacity-70";

  return (
    <section className="rounded-2xl border border-[#bfe9e5] bg-white px-2 pb-3 pt-2">
      <div className="flex items-center px-1">
        {week.prev ? <Link href={`${base}?w=${week.prev}`} scroll={false} aria-label="Previous week" className={NAV}><ChevronLeft size={20} /></Link> : <span className="h-9 w-9" />}
        <div className="min-w-0 flex-1 text-center">
          <p className="text-sm font-extrabold text-[#1c2b3a]">{week.title}</p>
          <p className="text-[11px] font-semibold text-[#7b8a9c]">
            {week.events.length} appointment{week.events.length === 1 ? "" : "s"}
            {!week.isThisWeek && <> · <Link href={base} scroll={false} className="text-[#0e8f88]">Today</Link></>}
          </p>
        </div>
        {week.next ? <Link href={`${base}?w=${week.next}`} scroll={false} aria-label="Next week" className={NAV}><ChevronRight size={20} /></Link> : <span className="h-9 w-9" />}
      </div>

      {!week.ok && <p className="mx-1 mt-1 rounded-xl bg-[#fff4e5] px-3 py-2 text-xs font-semibold text-[#92400e]">We couldn&apos;t read all of your calendar just now. Please open Bookings again.</p>}

      <div className="mt-1 flex">
        <div className="w-9 shrink-0" />
        {week.days.map((d) => (
          <div key={d.key} className="min-w-0 flex-1 pb-1 text-center">
            <p className={`text-[10px] font-bold uppercase ${d.today ? "text-[#0e8f88]" : "text-[#8595a8]"}`}>{d.name}</p>
            <p className={`mx-auto flex h-6 w-6 items-center justify-center rounded-full text-xs font-extrabold ${d.today ? "bg-[#15B7AE] text-white" : "text-[#1c2b3a]"}`}>{d.num}</p>
          </div>
        ))}
      </div>

      <div className="flex" style={{ height }}>
        <div className="relative w-9 shrink-0">
          {hours.map((h) => <span key={h} className="absolute right-1 -translate-y-1/2 text-[9px] font-semibold text-[#9aa8b8]" style={{ top: top(h) }}>{h === week.fromMin ? "" : hourLabel(h)}</span>)}
        </div>
        {week.days.map((d, di) => {
          const mine = week.events.filter((e) => e.day === di);
          return (
            <div key={d.key} className="relative min-w-0 flex-1 border-l border-[#e4ebf2] bg-[#eef2f6]">
              {d.open.map(([a, b], i) => (
                <span key={i} className="absolute inset-x-0 bg-white" style={{ top: Math.max(0, top(a)), height: Math.max(0, top(Math.min(b, week.toMin)) - Math.max(0, top(a))) }} />
              ))}
              {hours.slice(1).map((h) => <span key={h} className="absolute inset-x-0 border-t border-[#e9eef4]" style={{ top: top(h) }} />)}
              {mine.map((e) => {
                // Two appointments at the same time share the column.
                const over = mine.filter((o) => o.startMin < e.endMin && e.startMin < o.endMin);
                const lane = over.indexOf(e), w = 100 / over.length;
                return (
                  <button key={e.id} onClick={() => setOpenId(openId === e.id ? null : e.id)} aria-pressed={openId === e.id}
                    aria-label={`${e.name}, ${e.when}, ${KIND[e.kind].label}`}
                    className={`absolute overflow-hidden rounded-md px-0.5 text-left text-[9.5px] font-bold leading-tight ${KIND[e.kind].block} ${openId === e.id ? "ring-2 ring-[#1c2b3a]" : ""}`}
                    style={{ top: top(e.startMin) + 1, height: Math.max(20, ((e.endMin - e.startMin) / 60) * HOUR - 2), left: `calc(${lane * w}% + 1px)`, width: `calc(${w}% - 2px)` }}>
                    <span className="block truncate">{firstName(e.name)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10.5px] font-semibold text-[#7b8a9c]">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-[#d7e0ea] bg-white" /> Your hours</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[#15B7AE]" /> Booked</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-[#d97706] bg-[#fff4e5]" /> Waiting for deposit</span>
      </div>

      {sel ? (
        <div className="mx-1 mt-2 rounded-xl border border-[#e4ebf2] bg-white px-3 pt-2">
          <div className="flex items-center gap-2 pb-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-[#1c2b3a]">{sel.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-[#7b8a9c]">
                <span>{sel.when}</span>
                <span className={`rounded px-1.5 py-0.5 font-semibold ${KIND[sel.kind].chip}`}>{KIND[sel.kind].label}</span>
              </span>
            </span>
            {sel.contactId && (
              <Link href={`/m/${token}/chats/with/${sel.contactId}`} prefetch={false} aria-label={`Chat with ${sel.name}`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-[#bfe9e5] bg-[#f3fbfa] px-2.5 py-1 text-xs font-bold text-[#0e8f88] active:opacity-70">
                <MessageCircle size={13} /> Chat
              </Link>
            )}
          </div>
          {sel.canChange && <BookingActions key={sel.id} token={token} id={sel.id} name={sel.name} when={sel.when} />}
        </div>
      ) : (
        week.events.length > 0 && <p className="px-1 pt-2 text-center text-[11px] text-[#9aa8b8]">Tap an appointment to open it.</p>
      )}
    </section>
  );
}
