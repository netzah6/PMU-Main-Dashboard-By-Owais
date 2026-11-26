import type { Agreement } from "@/lib/agreement";

// The agreement on screen, laid out like the PDF: teal bar, logo, headings,
// lists. Used for the live preview in the E-Sign tab and on the public
// signing page. `signatureSlot` replaces the empty signature lines.
export function AgreementView({ agreement, partnerName, signatureSlot }: { agreement: Agreement; partnerName?: string; signatureSlot?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white shadow-sm overflow-hidden">
      <div className="relative h-[54px]">
        <div className="absolute left-0 right-0 top-[18px] h-[16px] bg-[#2EC4C6]" />
        <div className="absolute left-4 sm:left-8 top-0 h-[54px] w-[96px] bg-white flex flex-col items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-logo.png" alt="PMU Bookings On Demand" className="h-[32px] w-auto object-contain" />
          <span className="text-[6.5px] font-bold text-[#171717] leading-tight">PMU Bookings On Demand</span>
        </div>
      </div>
      <div className="px-4 sm:px-8 py-5 max-w-[760px] break-words">
        <h2 className="text-[15px] font-bold text-[#171717] mb-4">{agreement.title}</h2>
        {agreement.blocks.map((b, i) => {
          if (b.type === "heading") return <h3 key={i} className="text-[13px] font-bold text-[#171717] mt-5 mb-1.5">{b.text}</h3>;
          if (b.type === "paragraph") return <p key={i} className="text-[13px] text-[#171717] leading-relaxed mb-2 whitespace-pre-line">{b.text}</p>;
          if (b.type === "bullets" || b.type === "numbered") {
            const L = b.type === "bullets" ? "ul" : "ol";
            return (
              <L key={i} className={`text-[13px] text-[#171717] leading-relaxed mb-2 pl-5 ${b.type === "bullets" ? "list-disc" : "list-decimal"}`}>
                {b.items.map((it, n) => <li key={n} className="mb-1.5 whitespace-pre-line">{it}</li>)}
              </L>
            );
          }
          if (signatureSlot) return <div key={i} className="mt-8">{signatureSlot}</div>;
          return (
            <div key={i} className="mt-8 space-y-5 text-[12px] text-[#171717]">
              {["Partner Full Name", "Partner Signature", "Date"].map((l) => (
                <div key={l}><div className="w-[150px] border-b border-dashed border-[#171717] mb-1" />{l}{l === "Partner Full Name" && partnerName ? `: ${partnerName}` : ""}</div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="relative min-h-[34px] bg-[#2b2b2b] flex items-center">
        <div className="absolute right-0 top-0 bottom-0 w-[22%] bg-[#2EC4C6]" />
        <p className="relative w-[78%] px-2 py-2 text-center text-white text-[10px] font-bold leading-tight">{agreement.footer}</p>
      </div>
    </div>
  );
}
