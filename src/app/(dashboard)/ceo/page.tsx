"use client";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2 } from "lucide-react";

// CEO view — the standalone agency dashboard the team already trusts,
// embedded whole so every section and number carries over unchanged:
// clients live/paused/churn, new cash vs recurring, upfront ROI, setter &
// closer capacity (live from GHL), monthly cash, missing-upfront hygiene
// list, and agency P&L. Served through an authenticated route; admins only.
export default function CeoPage() {
  const { role, loading } = useUser();
  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin") return <div className="p-8 text-sm text-[#697a91]">Admins only.</div>;
  return (
    <iframe
      src="/api/ceo/html"
      title="CEO Dashboard"
      className="w-full border-0 bg-[#0b0f17] min-h-[calc(100vh-52px)]"
    />
  );
}
