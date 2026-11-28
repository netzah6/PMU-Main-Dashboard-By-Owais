import type { Metadata } from "next";
import { googleUrlFor, loadCalendarEntry, whenText } from "@/lib/add-to-calendar";

/* Public "add to my calendar" page (no login, 11/28/2026). The client opens it
   from the booking text: /cal/<studio location id>/<her contact id>. It shows
   her next confirmed appointment and two buttons: Apple/Outlook (.ics file)
   and Google Calendar. Read only; see src/lib/add-to-calendar.ts. */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add to my calendar",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function AddToCalendarPage({ params }: { params: { loc: string; cid: string } }) {
  const e = await loadCalendarEntry(params.loc, params.cid).catch(() => null);

  return (
    <main className="min-h-screen bg-[#faf7f8] px-4 py-10 text-[#1d1b24]">
      <div className="mx-auto flex max-w-sm flex-col gap-5">
        {e ? (
          <>
            <div className="text-center text-sm font-medium uppercase tracking-wider text-[#8a2f5c]">Your appointment</div>
            <div className="rounded-2xl border border-[#eadfe4] bg-white p-5 shadow-sm">
              <h1 className="text-xl font-semibold leading-snug">{e.title}</h1>
              <p className="mt-3 text-[15px]">{whenText(e)}</p>
              {e.address ? <p className="mt-1 text-[15px] text-[#6b6876]">{e.address}</p> : null}
            </div>
            <a
              href={`/api/cal/${encodeURIComponent(params.loc)}/${encodeURIComponent(params.cid)}`}
              className="block rounded-xl bg-[#1d1b24] px-4 py-3.5 text-center text-[15px] font-semibold text-white"
            >
              Add to Apple Calendar
            </a>
            <a
              href={googleUrlFor(e)}
              className="block rounded-xl border border-[#1d1b24] bg-white px-4 py-3.5 text-center text-[15px] font-semibold text-[#1d1b24]"
            >
              Add to Google Calendar
            </a>
            <p className="text-center text-sm text-[#6b6876]">Need to change the time? Just reply to our text and we&apos;ll help.</p>
          </>
        ) : (
          <div className="rounded-2xl border border-[#eadfe4] bg-white p-5 text-center shadow-sm">
            <h1 className="text-lg font-semibold">We couldn&apos;t find your appointment</h1>
            <p className="mt-2 text-[15px] text-[#6b6876]">It may have been moved or cancelled. Just reply to our text and we&apos;ll help.</p>
          </div>
        )}
      </div>
    </main>
  );
}
