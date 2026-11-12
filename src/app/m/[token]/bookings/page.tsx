import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { loadApp, loadBookings, niceName, type AppBooking } from "@/lib/client-app";
import { HOW, day } from "@/components/client-app/BillingView";
import { FilterBox } from "@/components/client-app/FilterBox";
import { BookingActions } from "@/components/client-app/BookingActions";

/* Bookings: what is coming up, then the sessions that already happened and
   are waiting to be charged (the detail lives on the Billing tab). Tapping a
   client opens her chat; an upcoming appointment can be moved or cancelled
   with "Change" (owner, 11/12/2026). */
/* Upcoming rows show the time too, on the studio's own clock. */
const whenOf = (iso: string | null, tz: string | null) => {
  if (!iso || !tz || !/T\d{2}:/.test(iso)) return day(iso);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return day(iso);
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz })} · ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}`;
};

function Row({ s, token, tz }: { s: AppBooking; token: string; tz?: string | null }) {
  const how = HOW[s.how] ?? { label: "", cls: "" };
  const when = tz !== undefined ? whenOf(s.date, tz) : day(s.date);
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[#1c2b3a]">{niceName(s.name)}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-[#7b8a9c]">
          {when && <span>{when}</span>}
          {how.label && <span className={`rounded px-1.5 py-0.5 font-semibold ${how.cls}`}>{how.label}</span>}
        </span>
      </span>
      {s.contactId && (
        <span className="flex shrink-0 items-center gap-1 rounded-full border border-[#bfe9e5] bg-[#f3fbfa] px-2.5 py-1 text-xs font-bold text-[#0e8f88]">
          <MessageCircle size={13} /> Chat
        </span>
      )}
    </>
  );
  const line = s.contactId
    ? <Link href={`/m/${token}/chats/with/${s.contactId}`} prefetch={false} aria-label={`Chat with ${niceName(s.name)}`} className="flex items-center gap-2 py-2 active:opacity-70">{body}</Link>
    : <div className="flex items-center gap-2 py-2">{body}</div>;
  return (
    <li data-q={`${s.name} ${when} ${how.label}`.toLowerCase()} className="border-b border-[#eef3f8] last:border-0">
      {s.apptId ? <BookingActions token={token} id={s.apptId} name={niceName(s.name)} when={when}>{line}</BookingActions> : line}
    </li>
  );
}

export default async function ClientAppBookings({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const b = await loadBookings(params.token);
  const upcoming = b?.upcoming ?? [];
  const done = b?.done ?? [];
  return (
    <div id="bookings-list" className="space-y-3">
      <FilterBox target="bookings-list" placeholder="Search an appointment…" />
      <section data-qgroup className="rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#0e8f88]">Upcoming</p>
        <p className="text-3xl font-extrabold text-[#1c2b3a]">{upcoming.length}</p>
        {upcoming.length === 0
          ? <p className="text-sm text-[#7b8a9c]">Nothing booked ahead yet.</p>
          : <ul className="mt-1">{upcoming.map((s) => <Row key={`${s.apptId ?? s.name}-${s.date}`} s={s} token={params.token} tz={b?.tz ?? null} />)}</ul>}
      </section>

      {done.length > 0 && (
        <section data-qgroup className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
          <div className="flex items-center">
            <p className="text-sm font-bold text-[#1c2b3a]">Recent sessions</p>
            <Link href={`/m/${params.token}/billing`} className="ml-auto text-xs font-semibold text-[#0e8f88]">Billing</Link>
          </div>
          <p className="text-xs text-[#7b8a9c]">Clients who came in · on your next bill</p>
          <ul className="mt-1">{done.map((s, i) => <Row key={i} s={s} token={params.token} />)}</ul>
        </section>
      )}
    </div>
  );
}
