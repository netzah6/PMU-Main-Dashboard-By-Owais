import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { loadApp } from "@/lib/client-app";

/* Card for her ads (owner, 11/12/2026): "They are not techy and they need our
   help to add the card on file… I need them to send us the details." The team
   then adds the card to her Facebook ad account for her.

   This screen only SHOWS the team's own form — "Secure Payment Method On File
   for Clients", the same one the team already sends by link. What she types
   goes from her phone straight to that form, exactly as it does today. Our
   app and our server never see, pass on or keep a card number: nothing here
   reads the form, and there is no card field of our own. */

const CARD_FORM = "https://api.leadconnectorhq.com/widget/form/Jaa9spmYBo2Sn3e94bdx";

export default async function ClientAppCard({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null; // the layout shows the "not available" card
  return (
    <div className="space-y-3">
      <Link href={`/m/${params.token}/billing`} className="inline-block px-1 text-xs font-semibold text-[#0e8f88]">‹ Billing</Link>
      <section className="rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3">
        <p className="text-base font-extrabold text-[#1c2b3a]">Card for your ads</p>
        <p className="text-sm text-[#7b8a9c]">Send us your card and your team adds it to your Facebook ads for you. Use it for a new card or when a card changed.</p>
        <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-[#15803d]"><ShieldCheck size={14} /> Goes straight to your PMU Bookings team</p>
      </section>
      <section className="overflow-hidden rounded-2xl border border-[#e4ebf2] bg-white">
        <iframe src={CARD_FORM} title="Card for your ads" referrerPolicy="no-referrer" loading="eager"
          sandbox="allow-scripts allow-forms allow-same-origin"
          className="block w-full border-0" style={{ height: 820 }} />
      </section>
    </div>
  );
}
