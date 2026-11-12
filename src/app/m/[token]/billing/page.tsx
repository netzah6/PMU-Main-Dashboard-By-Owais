import Link from "next/link";
import { CreditCard } from "lucide-react";
import { loadApp } from "@/lib/client-app";
import { BillingView } from "@/components/client-app/BillingView";
import { FilterBox } from "@/components/client-app/FilterBox";

/* Billing tab: the same view as the standalone My Billing page. */
export default async function ClientAppBilling({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const v = app.view;
  return (
    <div className="space-y-3">
      {/* Payment method for her campaign: she sends the card, the team adds it to Facebook for her. */}
      <Link href={`/m/${params.token}/card`} className="flex items-center gap-3 rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3 active:opacity-80">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e6f7f5]"><CreditCard size={17} className="text-[#0e8f88]" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-[#1c2b3a]">Payment method for your campaign</span>
          <span className="block text-xs text-[#7b8a9c]">Add or change your card — we set it up for you</span>
        </span>
        <span className="text-lg text-[#9aa8b8]">›</span>
      </Link>
      <FilterBox target="billing-list" placeholder="Search a client or a payment…" />
      <div id="billing-list"><BillingView v={v} /></div>
      <p className="px-1 text-center text-xs text-[#9aa8b8]">Question about a charge? Message your success coach.</p>
    </div>
  );
}
