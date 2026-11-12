import Link from "next/link";
import { Lock, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { loadApp } from "@/lib/client-app";
import { BUDGET_DEFAULT, BUDGET_OPTIONS, loadBudget } from "@/lib/client-app-budget";
import { BudgetPicker } from "@/components/client-app/BudgetPicker";

/* Payment method for her campaign (owner, 11/12/2026): "They are not techy
   and they need our help to add the card on file… I need them to send us the
   details." The team then adds the card to her Facebook ad account for her.
   He asked for: this name, WHY the card is needed, things that make her feel
   safe, and the daily budget — $25 a day to start, with the choice to change.

   The form below is the team's own "Secure Payment Method On File for
   Clients" — the same one the team already sends by link. What she types goes
   from her phone straight to that form, exactly as it does today. Our app and
   our server never see, pass on or keep a card number: nothing here reads the
   form, and there is no card field of our own.

   Every line on this screen has to stay TRUE: no "bank-level", no "we never
   keep it", no promise the team does not keep. */

const CARD_FORM = "https://api.leadconnectorhq.com/widget/form/Jaa9spmYBo2Sn3e94bdx";

export default async function ClientAppCard({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null; // the layout shows the "not available" card
  const budget = (await loadBudget(params.token).catch(() => null)) ?? { daily: BUDGET_DEFAULT, chosenAt: null };
  const SAFE = [
    { Icon: Lock, text: "Sent over a secure, encrypted connection" },
    { Icon: Users, text: "Only your PMU Bookings On Demand team sees it" },
    { Icon: ShieldCheck, text: "Used for your Facebook ad budget" },
    { Icon: RefreshCw, text: "Change it any time — just tell your coach" },
  ];
  return (
    <div className="space-y-3">
      <Link href={`/m/${params.token}/billing`} className="inline-block px-1 text-xs font-semibold text-[#0e8f88]">‹ Billing</Link>

      <section className="rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3">
        <p className="text-base font-extrabold text-[#1c2b3a]">Payment method for your campaign</p>
        <p className="mt-1 text-xs font-bold uppercase tracking-wide text-[#0e8f88]">Why we need it</p>
        <p className="text-sm leading-snug text-[#52627a]">
          Your ads run on Facebook, and Facebook charges the ad budget to your card. Without a card your ads can&apos;t run and new leads stop coming in.
          You send us the card here and we set it up in Facebook for you.
        </p>
      </section>

      <section className="rounded-2xl border border-[#c7edd4] bg-[#f6fdf8] px-4 py-3">
        <p className="flex items-center gap-1.5 text-sm font-bold text-[#15803d]"><ShieldCheck size={16} /> Safe and private</p>
        <ul className="mt-1.5 space-y-1.5">
          {SAFE.map(({ Icon, text }) => (
            <li key={text} className="flex items-center gap-2 text-sm text-[#3b4a5c]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white"><Icon size={13} className="text-[#15803d]" /></span>{text}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-3">
        <p className="text-sm font-bold text-[#1c2b3a]">Your daily ad budget</p>
        <p className="text-sm leading-snug text-[#7b8a9c]">We start with ${BUDGET_DEFAULT} a day. We will tell you when it is a good time to change it.</p>
        <BudgetPicker token={params.token} daily={budget.daily} options={BUDGET_OPTIONS} recommended={BUDGET_DEFAULT} />
      </section>

      <section className="overflow-hidden rounded-2xl border border-[#e4ebf2] bg-white">
        <p className="flex items-center gap-1.5 border-b border-[#eef3f8] px-4 py-2.5 text-xs font-bold text-[#52627a]"><Lock size={13} className="text-[#15803d]" /> Secure form · PMU Bookings On Demand</p>
        <iframe src={CARD_FORM} title="Payment method for your campaign" referrerPolicy="no-referrer" loading="eager"
          sandbox="allow-scripts allow-forms allow-same-origin"
          className="block w-full border-0" style={{ height: 820 }} />
      </section>
    </div>
  );
}
