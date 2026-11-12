import Link from "next/link";
import { Lock } from "lucide-react";
import { loadApp } from "@/lib/client-app";
import { day } from "@/components/client-app/BillingView";

/* Home: the three numbers a client opens the app for, each a tap away from
   its detail. Few words, big numbers (owner's screen rule). Good news only —
   money lives on the Billing tab (owner, 11/11/2026). */
export default async function ClientAppHome({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null; // the layout shows the "not available" card
  const { view: v, leads, leads30, booked30, paid30, sessionsDone, reviews } = app;
  const first = v.ownerName.trim().split(/\s+/)[0] ?? "";
  const base = `/m/${params.token}`;
  const next = [...v.upcoming].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")))[0];

  const Card = ({ href, label, value, sub, tone }: { href: string; label: string; value: string; sub: string; tone: "green" | "teal" | "blue" }) => (
    <Link href={href} className={`block rounded-2xl border p-4 active:opacity-80 ${
      tone === "green" ? "border-[#c7edd4] bg-white" : tone === "teal" ? "border-[#bfe9e5] bg-white" : "border-[#c9dbfb] bg-white"}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${tone === "green" ? "text-[#15803d]" : tone === "teal" ? "text-[#0e8f88]" : "text-[#1d4ed8]"}`}>{label}</p>
      <div className="flex items-end gap-2">
        <p className="text-3xl font-extrabold text-[#1c2b3a]">{value}</p>
        <span className="mb-1 ml-auto text-lg text-[#9aa8b8]">›</span>
      </div>
      <p className="text-sm text-[#7b8a9c]">{sub}</p>
    </Link>
  );

  return (
    <div className="space-y-3">
      {first && <p className="px-1 text-lg font-extrabold text-[#1c2b3a]">Hi {first} 👋</p>}
      <Card href={`${base}/bookings`} tone="teal" label="Upcoming appointments" value={String(v.upcoming.length)}
        sub={next ? `Next: ${next.name} · ${day(next.date)}` : "Nothing booked ahead yet"} />
      <Card href={`${base}/leads`} tone="blue" label="New leads · last 30 days" value={String(leads30)}
        sub={`${booked30} picked a time · ${paid30} paid a deposit`} />
      <Card href={`${base}/bookings`} tone="green" label="Clients served" value={String(sessionsDone)}
        sub="Came in through PMU Bookings On Demand" />

      {/* Google Reviews: numbers once the team turned it on, a locked teaser before. */}
      {reviews.on && reviews.connected ? (
        <Link href={`${base}/reviews`} className="block rounded-2xl border border-[#f3e3b3] bg-white p-4 active:opacity-80">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#b98900]">Google reviews</p>
          <div className="flex items-end gap-2">
            <p className="text-3xl font-extrabold text-[#1c2b3a]">★ {reviews.rating != null ? reviews.rating.toFixed(1) : "—"}</p>
            <span className="mb-1 ml-auto text-lg text-[#9aa8b8]">›</span>
          </div>
          <p className="text-sm text-[#7b8a9c]">
            {reviews.count ?? 0} reviews{reviews.gained != null && reviews.gained > 0 ? ` · +${reviews.gained} new` : ""}
          </p>
        </Link>
      ) : (
        <Link href={`${base}/reviews`} className="flex items-center gap-3 rounded-2xl border border-dashed border-[#d9c98f] bg-[#fffdf5] p-4 active:opacity-80">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff7e0]"><Lock size={16} className="text-[#b98900]" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-[#1c2b3a]">Google Reviews</span>
            <span className="block text-xs text-[#7b8a9c]">{reviews.on ? "Connecting your Google listing…" : reviews.requestedAt ? "Request sent — your team will turn it on" : "Tap to turn it on"}</span>
          </span>
          <span className="text-lg text-[#9aa8b8]">›</span>
        </Link>
      )}

      {leads.length > 0 && (
        <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
          <div className="flex items-center">
            <p className="text-sm font-bold text-[#1c2b3a]">Latest leads</p>
            <Link href={`${base}/leads`} className="ml-auto text-xs font-semibold text-[#0e8f88]">See all</Link>
          </div>
          <ul>
            {leads.slice(0, 3).map((l, i) => (
              <li key={i} className="flex items-center gap-2 border-b border-[#eef3f8] py-2 last:border-0">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1c2b3a]">{l.name}</span>
                <span className="text-xs text-[#7b8a9c]">{day(l.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
