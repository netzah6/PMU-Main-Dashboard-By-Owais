import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPortalView, portalOwnerByToken } from "@/lib/ppa-portal";
import { BillingView, usd } from "@/components/client-app/BillingView";

/* Client-facing "My Billing" (owner, 11/11/2026). Public by secret link, read
   only, always live. Short on purpose: one number on top, detail behind a
   click. Opens inside the client's GoHighLevel menu or as a plain link. The
   same view is the Billing tab of the client app (/m/[token]). */

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata: Metadata = {
  title: "My Billing",
  robots: { index: false, follow: false },
  // The link itself is the key — never leak it to Square's receipt pages.
  referrer: "no-referrer",
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-[#f3f7fb] px-3 py-6 sm:py-10">
    <div className="mx-auto w-full max-w-xl space-y-3">{children}</div>
  </div>
);

export default async function MyBillingPage({ params }: { params: { token: string } }) {
  const svc = createServiceClient();
  const ownerKey = await portalOwnerByToken(svc, params.token);
  const v = ownerKey ? await buildPortalView(svc, ownerKey).catch(() => null) : null;
  if (!v) {
    return (
      <Shell>
        <div className="rounded-2xl border border-[#e4ebf2] bg-white p-6 text-center">
          <p className="text-base font-bold text-[#1c2b3a]">This billing page isn&apos;t available.</p>
          <p className="mt-1 text-sm text-[#7b8a9c]">Please ask your success coach for a new link.</p>
        </div>
      </Shell>
    );
  }
  const now = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

  return (
    <Shell>
      <header className="px-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#0e8f88]">My Billing</p>
        <h1 className="text-xl font-bold text-[#1c2b3a]">{v.business || v.ownerName}</h1>
        <p className="text-xs text-[#7b8a9c]">Live · updated {now} ET{!v.exempt && <> · {usd(v.fee)} per show</>}</p>
      </header>
      <BillingView v={v} />
      <p className="px-1 text-center text-xs text-[#9aa8b8]">Question about a charge? Message your success coach.</p>
    </Shell>
  );
}
