import { Loader2 } from "lucide-react";

/* Shown the moment she taps a tab or a card, while the next screen loads
   (owner, 11/12/2026: "when I click on something it's loading but shows
   nothing"). */
export default function ClientAppLoading() {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-[#7b8a9c]" role="status" aria-live="polite">
      <Loader2 size={28} className="animate-spin text-[#15B7AE]" />
      <p className="text-sm font-semibold">Loading…</p>
    </div>
  );
}
