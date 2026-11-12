import { loadApp } from "@/lib/client-app";
import { BillingView, usd } from "@/components/client-app/BillingView";
import { FilterBox } from "@/components/client-app/FilterBox";

/* Billing tab: the same view as the standalone My Billing page. */
export default async function ClientAppBilling({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const v = app.view;
  return (
    <div className="space-y-3">
      {!v.exempt && <p className="px-1 text-xs text-[#7b8a9c]">{usd(v.fee)} per show · updates live</p>}
      <FilterBox target="billing-list" placeholder="Search a client or a payment…" />
      <div id="billing-list"><BillingView v={v} /></div>
      <p className="px-1 text-center text-xs text-[#9aa8b8]">Question about a charge? Message your success coach.</p>
    </div>
  );
}
