import type { Agreement } from "@/lib/agreement";

// The agreement on screen, laid out like a real document: letterhead with
// the logo and company name, a teal rule, the title, the body, and the dark
// footer strip from the PDF. Used for the live preview in the Agreements tab
// and on the public signing page. `signatureSlot` replaces the empty
// signature lines; `meta` sits on the right of the letterhead.
export function AgreementView({ agreement, partnerName, signatureSlot, meta }: {
  agreement: Agreement; partnerName?: string; signatureSlot?: React.ReactNode; meta?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.05)] overflow-hidden">
      {/* Letterhead — normal flow (no absolute boxes), so the logo is never clipped. */}
      <div className="h-[6px] bg-[#2EC4C6]" />
      <div className="px-4 sm:px-10 pt-5 sm:pt-7 pb-4 sm:pb-5 flex items-center gap-3 sm:gap-5 flex-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand-logo.png" alt="PMU Bookings On Demand logo" width={350} height={280}
          className="h-[60px] sm:h-[78px] w-auto object-contain shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] sm:text-[21px] font-extrabold tracking-tight text-[#0f172a] leading-tight">PMU Bookings On Demand</div>
          <div className="text-[11px] sm:text-[12px] font-semibold uppercase tracking-[0.12em] text-[#0e9f99] mt-0.5">Partner Program Agreement</div>
        </div>
        {meta && <div className="w-full sm:w-auto text-[11px] sm:text-right text-[#64748b] leading-relaxed">{meta}</div>}
      </div>
      <div className="mx-4 sm:mx-10 border-t-2 border-[#2EC4C6]" />

      <div className="px-4 sm:px-10 pt-5 sm:pt-7 pb-7 sm:pb-9 break-words">
        <h2 className="text-[18px] sm:text-[22px] font-bold text-[#0f172a] leading-snug mb-5">{agreement.title}</h2>
        {agreement.blocks.map((b, i) => {
          if (b.type === "heading") return <h3 key={i} className="text-[14px] sm:text-[15px] font-bold text-[#0f172a] mt-6 mb-2">{b.text}</h3>;
          if (b.type === "paragraph") return <p key={i} className="text-[14px] text-[#1e293b] leading-[1.7] mb-3 whitespace-pre-line">{b.text}</p>;
          if (b.type === "bullets" || b.type === "numbered") {
            const L = b.type === "bullets" ? "ul" : "ol";
            return (
              <L key={i} className={`text-[14px] text-[#1e293b] leading-[1.7] mb-3 pl-5 marker:text-[#0e9f99] ${b.type === "bullets" ? "list-disc" : "list-decimal"}`}>
                {b.items.map((it, n) => <li key={n} className="mb-2 pl-1 whitespace-pre-line">{it}</li>)}
              </L>
            );
          }
          if (signatureSlot) return <div key={i} className="mt-9">{signatureSlot}</div>;
          return (
            <div key={i} className="mt-9 space-y-6 text-[12px] text-[#1e293b]">
              {["Partner Full Name", "Partner Signature", "Date"].map((l) => (
                <div key={l}><div className="w-[200px] max-w-full border-b border-[#94a3b8] mb-1 h-5" />{l}{l === "Partner Full Name" && partnerName ? `: ${partnerName}` : ""}</div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="relative min-h-[38px] bg-[#2b2b2b] flex items-center">
        <div className="absolute right-0 top-0 bottom-0 w-[22%] bg-[#2EC4C6]" />
        <p className="relative w-[78%] px-3 py-2.5 text-center text-white text-[10px] sm:text-[11px] font-bold leading-tight">{agreement.footer}</p>
      </div>
    </div>
  );
}
