import Link from "next/link";
import { loadApp } from "@/lib/client-app";
import { ShowRow } from "@/components/client-app/BillingView";

/* Bookings: what is coming up, then the sessions that already happened and
   are waiting to be charged (the detail lives on the Billing tab). */
export default async function ClientAppBookings({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const v = app.view;
  const upcoming = [...v.upcoming].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const done = [...v.owed.shows].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#0e8f88]">Upcoming</p>
        <p className="text-3xl font-extrabold text-[#1c2b3a]">{upcoming.length}</p>
        {upcoming.length === 0
          ? <p className="text-sm text-[#7b8a9c]">Nothing booked ahead yet.</p>
          : <ul className="mt-1">{upcoming.map((s, i) => <ShowRow key={i} s={s} />)}</ul>}
      </section>

      {done.length > 0 && (
        <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
          <div className="flex items-center">
            <p className="text-sm font-bold text-[#1c2b3a]">Recent sessions</p>
            <Link href={`/m/${params.token}/billing`} className="ml-auto text-xs font-semibold text-[#0e8f88]">Billing</Link>
          </div>
          <p className="text-xs text-[#7b8a9c]">Happened already · not charged yet</p>
          <ul className="mt-1">{done.map((s, i) => <ShowRow key={i} s={s} />)}</ul>
        </section>
      )}
    </div>
  );
}
