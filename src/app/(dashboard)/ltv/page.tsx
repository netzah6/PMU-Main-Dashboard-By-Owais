"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTableData } from "@/lib/hooks/useTableData";
import { useUser } from "@/lib/hooks/useUser";
import { DataTable, Column } from "@/components/ui/DataTable";
import { cn, formatCurrency, formatDate, formatPercent, sortNewestFirst } from "@/lib/utils";
import { Search } from "lucide-react";

const numv = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
};

// Payment source pill colors (match the sheet's color scheme)
function sourceStyle(s: string): { bg: string; text: string } {
  const u = s.toLowerCase();
  if (u === "square") return { bg: "#3f3f46", text: "#ffffff" };
  if (u === "fanbasis") return { bg: "#ffd9d9", text: "#b91c1c" };
  if (u === "paypal") return { bg: "#1d4ed8", text: "#ffffff" };
  if (u === "whop") return { bg: "#b91c1c", text: "#ffffff" };
  return { bg: "#f1f5f9", text: "#64748b" };
}

function Kpi({ label, value, bg }: { label: string; value: string; bg: string }) {
  return (
    <div className="rounded-lg px-3 py-2 text-center border border-black/5" style={{ background: bg }}>
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">{label}</p>
      <p className="text-sm font-bold text-[#0f1b2d] mt-0.5">{value}</p>
    </div>
  );
}

interface ClientLtv { name: string; signed: string; ltv: number }

export default function LtvPage() {
  const [activeTab, setActiveTab] = useState<"payments" | "summary">("payments");
  // LTV is admin-only — bounce anyone else who reaches this URL directly.
  const { role, loading: roleLoading } = useUser();
  const router = useRouter();
  useEffect(() => {
    if (!roleLoading && role !== "admin") router.replace("/overview");
  }, [roleLoading, role, router]);
  const { data: payments, loading: lp, error: ep } = useTableData<Record<string, unknown>>({ table: "ltv_sheet1" });
  const { data: summary, loading: ls, error: es } = useTableData<Record<string, unknown>>({ table: "ltv_sheet2" });
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("All");

  // ── Payments: newest first, filter by source + client search ──
  const paymentSources = useMemo(
    () => ["All", ...Array.from(new Set(payments.map((r) => String(r["Source"] ?? "").trim()).filter(Boolean))).sort()],
    [payments]
  );
  const paymentsRows = useMemo(() => {
    let rows = sortNewestFirst(payments);
    if (sourceFilter !== "All") rows = rows.filter((r) => String(r["Source"] ?? "").trim() === sourceFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        `${r["Full Name (On Payment)"] ?? ""} ${r["Full Name (When Sign Up)"] ?? ""} ${r["Email"] ?? ""}`.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [payments, search, sourceFilter]);

  const paymentTotal = useMemo(
    () => paymentsRows.reduce((s, r) => s + (numv(r["Amount"]) ?? 0), 0),
    [paymentsRows]
  );

  const paymentCols = useMemo<Column<Record<string, unknown>>[]>(() => [
    { key: "Date", header: "Date", render: (r) => formatDate(String(r["Date"] ?? "")) },
    { key: "Full Name (On Payment)", header: "Name (On Payment)", render: (r) => <span className="font-medium text-[#1f3559]">{String(r["Full Name (On Payment)"] ?? r["Full Name (When Sign Up)"] ?? "—")}</span> },
    { key: "Email", header: "Email", render: (r) => (r["Email"] ? String(r["Email"]) : <span className="text-[#a6b3c4]">—</span>) },
    { key: "Amount", header: "Amount", render: (r) => <span className="font-semibold text-[#0e8f88]">{formatCurrency(String(r["Amount"] ?? ""))}</span> },
    {
      key: "Source", header: "Source", render: (r) => {
        const s = String(r["Source"] ?? "").trim();
        if (!s) return <span className="text-[#a6b3c4]">—</span>;
        const st = sourceStyle(s);
        return <span className="inline-block px-3 py-0.5 rounded-full text-xs font-semibold" style={{ background: st.bg, color: st.text }}>{s}</span>;
      },
    },
  ], []);

  // ── Summary KPI aggregates (rows 2 & 4, columns E–J) ──
  const kpis = useMemo(() => {
    const r2 = summary.find((r) => Number(r._row_number) === 2) ?? {};
    const r4 = summary.find((r) => Number(r._row_number) === 4) ?? {};
    const c = (v: unknown) => (numv(v) != null ? formatCurrency(numv(v)!) : "—");
    return [
      { label: "Average LTV", value: c(r2["Average LTV"]), bg: "#ffe2ad" },
      { label: "Collected", value: c(r2["Collected"]), bg: "#5ee65a" },
      { label: "Goal", value: c(r2["Goal"]), bg: "#5fe6ff" },
      { label: "Goal %", value: numv(r2["Goal %"]) != null ? formatPercent(numv(r2["Goal %"])!) : "—", bg: "#ff66e0" },
      { label: "Ad Spent", value: c(r2["Ad Spent"]), bg: "#ffe2ad" },
      { label: "ROI", value: numv(r2["ROI"]) != null ? numv(r2["ROI"])!.toFixed(2) : "—", bg: "#5ee65a" },
      { label: "Real LTV ($250 & Deposits)", value: c(r4["Average LTV"]), bg: "#ffe2ad" },
      { label: "Left", value: c(r4["Collected"]), bg: "#5fe6ff" },
      { label: "Close More", value: numv(r4["Goal"]) != null ? Math.round(numv(r4["Goal"])!).toLocaleString() : "—", bg: "#ff9f1a" },
      { label: "Goal $", value: String(r4["Goal %"] ?? "—"), bg: "#5fe6ff" },
      { label: "Discoveries Goal", value: numv(r4["Ad Spent"]) != null ? String(numv(r4["Ad Spent"])) : "—", bg: "#5fe6ff" },
      { label: "New Clients/mo", value: numv(r4["ROI"]) != null ? String(numv(r4["ROI"])) : "—", bg: "#5fe6ff" },
    ];
  }, [summary]);

  const clients = useMemo<ClientLtv[]>(() => {
    return summary
      .map((r) => ({
        name: String(r["(Name On Payment)"] ?? "").trim(),
        signed: String(r["(Name on Signed Up)"] ?? "").trim(),
        ltv: numv(r["Lifetime Value"]) ?? NaN,
      }))
      .filter((c) => c.name && !isNaN(c.ltv))
      .sort((a, b) => b.ltv - a.ltv);
  }, [summary]);

  const filteredClients = useMemo(() => {
    if (!search) return clients;
    const q = search.toLowerCase();
    return clients.filter((c) => `${c.name} ${c.signed}`.toLowerCase().includes(q));
  }, [clients, search]);

  const totalLtv = useMemo(() => clients.reduce((s, c) => s + c.ltv, 0), [clients]);

  const clientCols = useMemo<Column<Record<string, unknown>>[]>(() => [
    { key: "name", header: "Name (On Payment)", render: (r) => <span className="font-medium text-[#1f3559]">{String(r.name)}</span> },
    { key: "signed", header: "Name (Signed Up)", render: (r) => (r.signed ? String(r.signed) : <span className="text-[#a6b3c4]">—</span>) },
    { key: "ltv", header: "Lifetime Value", render: (r) => <span className="font-semibold text-[#0e8f88]">{formatCurrency(Number(r.ltv))}</span> },
  ], []);

  // Hold rendering until the role resolves; non-admins are redirected above.
  if (roleLoading || role !== "admin") return null;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-lg font-semibold text-[#1f3559]">LTV</h1>
      <div className="flex gap-1 border-b border-[#e4ebf2]">
        {(["payments", "summary"] as const).map((tab) => (
          <button key={tab} onClick={() => { setActiveTab(tab); setSearch(""); setSourceFilter("All"); }}
            className={cn("px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2",
              activeTab === tab ? "text-[#0e8f88] border-[#15B7AE]" : "text-[#697a91] border-transparent hover:text-[#1e2a3a]")}>
            {tab}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input type="text" placeholder={activeTab === "summary" ? "Search client…" : "Search client or email…"} value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        {activeTab === "payments" && (
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {paymentSources.map((s) => <option key={s} value={s}>{s === "All" ? "All sources" : s}</option>)}
          </select>
        )}
      </div>

      {activeTab === "payments" ? (
        <>
          <div className="flex items-center justify-end">
            <span className="text-xs text-[#697a91]">{paymentsRows.length} payments · total <strong className="text-[#0e8f88]">{formatCurrency(paymentTotal)}</strong></span>
          </div>
          <DataTable columns={paymentCols} data={paymentsRows} loading={lp} error={ep} exportFilename="ltv-payments.csv" emptyMessage="No payments match" />
        </>
      ) : (
        <div className="space-y-5">
          {!ls && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {kpis.map((k) => <Kpi key={k.label} {...k} />)}
            </div>
          )}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#34568a]">Client Lifetime Value</h2>
            <span className="text-xs text-[#697a91]">{filteredClients.length} clients · total <strong className="text-[#0e8f88]">{formatCurrency(totalLtv)}</strong></span>
          </div>
          <DataTable columns={clientCols} data={filteredClients as unknown as Record<string, unknown>[]} loading={ls} error={es} exportFilename="ltv-summary.csv" emptyMessage="No client LTV data" />
        </div>
      )}
    </div>
  );
}
