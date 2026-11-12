import Link from "next/link";
import { Lock, Star } from "lucide-react";
import { loadApp } from "@/lib/client-app";
import { AskReviewsButton } from "@/components/client-app/AskReviewsButton";

/* Google Reviews. Shown to every client, LOCKED until the team turns it on
   for her (owner, 11/11/2026): she sees what it is and can ask for it. Once
   on: her rating, how many reviews, how many she gained, the latest ones. */
const Stars = ({ n }: { n: number }) => (
  <span className="inline-flex gap-0.5" aria-label={`${n} stars`}>
    {[1, 2, 3, 4, 5].map((i) => <Star key={i} size={14} className={i <= n ? "fill-[#f5b301] text-[#f5b301]" : "text-[#d5dde6]"} />)}
  </span>
);
const sinceLabel = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

export default async function ClientAppReviews({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const r = app.reviews;
  const back = <Link href={`/m/${params.token}`} className="inline-block rounded-full border border-[#e4ebf2] bg-white px-3 py-1 text-sm font-semibold text-[#0e8f88]">‹ Home</Link>;

  if (!r.on) {
    return (
      <div className="space-y-3">
        {back}
        <section className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#fff7e0]"><Lock size={20} className="text-[#b98900]" /></span>
          <p className="mt-2 text-lg font-extrabold text-[#1c2b3a]">Google Reviews</p>
          <p className="mt-1 text-sm text-[#52627a]">See your Google rating, how many reviews you have, and how many new ones you gained — right here.</p>
          <div className="mx-auto mt-3 flex max-w-xs items-center justify-center gap-4 rounded-xl bg-[#f6f8fb] px-3 py-3 opacity-60" aria-hidden>
            <div><p className="text-2xl font-extrabold text-[#1c2b3a]">★ —</p><p className="text-[11px] font-semibold text-[#7b8a9c]">Rating</p></div>
            <div><p className="text-2xl font-extrabold text-[#1c2b3a]">—</p><p className="text-[11px] font-semibold text-[#7b8a9c]">Reviews</p></div>
            <div><p className="text-2xl font-extrabold text-[#1c2b3a]">+ —</p><p className="text-[11px] font-semibold text-[#7b8a9c]">New</p></div>
          </div>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[#b98900]">Not turned on yet</p>
        </section>
        <AskReviewsButton token={params.token} sent={!!r.requestedAt} />
      </div>
    );
  }

  if (!r.connected) {
    return (
      <div className="space-y-3">
        {back}
        <section className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
          <p className="text-lg font-extrabold text-[#1c2b3a]">Google Reviews</p>
          <p className="mt-1 text-sm text-[#52627a]">We&apos;re connecting your Google listing. Your reviews will show here soon.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {back}
      <section className="grid grid-cols-3 gap-2">
        <div className="rounded-2xl border border-[#f3e3b3] bg-white px-3 py-3 text-center">
          <p className="text-2xl font-extrabold text-[#1c2b3a]">★ {r.rating != null ? r.rating.toFixed(1) : "—"}</p>
          <p className="text-[11px] font-semibold text-[#52627a]">Rating</p>
        </div>
        <div className="rounded-2xl border border-[#f3e3b3] bg-white px-3 py-3 text-center">
          <p className="text-2xl font-extrabold text-[#1c2b3a]">{r.count ?? "—"}</p>
          <p className="text-[11px] font-semibold text-[#52627a]">Reviews</p>
        </div>
        <div className="rounded-2xl border border-[#c7edd4] bg-white px-3 py-3 text-center">
          <p className="text-2xl font-extrabold text-[#15803d]">{r.gained != null ? `+${Math.max(0, r.gained)}` : "—"}</p>
          <p className="text-[11px] font-semibold text-[#52627a]">{r.gained != null ? `Since ${sinceLabel(r.since)}` : "New"}</p>
        </div>
      </section>
      {r.gained == null && <p className="px-1 text-xs text-[#7b8a9c]">We started counting today. New reviews will show here from now on.</p>}

      {r.latest.length > 0 && (
        <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-2">
          <p className="py-1 text-sm font-bold text-[#1c2b3a]">What clients say</p>
          <ul>
            {r.latest.map((x, i) => (
              <li key={i} className="border-b border-[#eef3f8] py-2.5 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1c2b3a]">{x.name}</span>
                  <Stars n={x.stars} />
                </div>
                <p className="mt-0.5 text-sm leading-snug text-[#52627a]">{x.text}</p>
                {x.when && <p className="mt-0.5 text-[11px] text-[#9aa8b8]">{x.when}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
