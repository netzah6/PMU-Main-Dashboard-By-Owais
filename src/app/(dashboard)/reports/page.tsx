"use client";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useTableData } from "@/lib/hooks/useTableData";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, DollarSign, Calendar, Zap, Users, Phone } from "lucide-react";

function monthKey(dateStr: string): string | null {
  if (!dateStr) return null;
  // Handle DD/MM/YYYY and ISO
  const dmY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  let d: Date;
  if (dmY) d = new Date(parseInt(dmY[3]), parseInt(dmY[2]) - 1, parseInt(dmY[1]));
  else d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return isNaN(n) ? 0 : n;
};

export default function ReportsPage() {
  const { data: deposits } = useTableData<Record<string, unknown>>({ table: "deposits" });
  const { data: leads } = useTableData<Record<string, unknown>>({ table: "leads_master" });
  const { data: bookings } = useTableData<Record<string, unknown>>({ table: "bookings" });
  const { data: calls } = useTableData<Record<string, unknown>>({ table: "outgoing_calls" });
  const { data: agreements } = useTableData<Record<string, unknown>>({ table: "signed_agreements" });

  // Build a sorted list of all months present in the data
  const monthly = useMemo(() => {
    const map: Record<string, {
      revenue: number; leads: number; bookings: number; calls: number; agreements: number;
    }> = {};

    const ensure = (k: string) => (map[k] ??= { revenue: 0, leads: 0, bookings: 0, calls: 0, agreements: 0 });

    deposits.forEach((d) => {
      // The deposits sheet's date column header came through as "f"
      const k = monthKey(String(d["Date"] ?? d["f"] ?? d.date ?? ""));
      if (k) ensure(k).revenue += num(d["Amount"] ?? d.amount);
    });
    leads.forEach((l) => {
      const k = monthKey(String(l["Date"] ?? l.date ?? ""));
      if (k) ensure(k).leads += 1;
    });
    bookings.forEach((b) => {
      const k = monthKey(String(b["Date"] ?? b.date ?? ""));
      if (k) ensure(k).bookings += 1;
    });
    calls.forEach((c) => {
      const k = monthKey(String(c["Date"] ?? c.date ?? ""));
      if (k) ensure(k).calls += 1;
    });
    agreements.forEach((a) => {
      const k = monthKey(String(a["Signed Date"] ?? a["Date"] ?? a.date ?? ""));
      if (k) ensure(k).agreements += 1;
    });

    return Object.entries(map)
      .map(([key, v]) => ({ key, label: monthLabel(key), ...v }))
      .sort((a, b) => b.key.localeCompare(a.key)); // newest first
  }, [deposits, leads, bookings, calls, agreements]);

  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const current = monthly.find((m) => m.key === selectedMonth) ?? monthly[0];

  // Totals across all time
  const totals = useMemo(() => ({
    revenue: monthly.reduce((s, m) => s + m.revenue, 0),
    leads: monthly.reduce((s, m) => s + m.leads, 0),
    bookings: monthly.reduce((s, m) => s + m.bookings, 0),
    calls: monthly.reduce((s, m) => s + m.calls, 0),
    agreements: monthly.reduce((s, m) => s + m.agreements, 0),
  }), [monthly]);

  const maxRevenue = Math.max(...monthly.map((m) => m.revenue), 1);

  const cards = current ? [
    { label: "Revenue", value: formatCurrency(current.revenue), icon: DollarSign, color: "#10b981" },
    { label: "Leads", value: String(current.leads), icon: Zap, color: "#6366f1" },
    { label: "Bookings", value: String(current.bookings), icon: Calendar, color: "#f59e0b" },
    { label: "Calls", value: String(current.calls), icon: Phone, color: "#8b5cf6" },
    { label: "Agreements", value: String(current.agreements), icon: Users, color: "#06b6d4" },
  ] : [];

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559] flex items-center gap-2">
            <TrendingUp size={20} className="text-[#0e8f88]" />
            Monthly Reports
          </h1>
          <p className="text-sm text-[#697a91] mt-0.5">Aggregated metrics across all data</p>
        </div>
        {monthly.length > 0 && (
          <select value={current?.key ?? ""} onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-4 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]">
            {monthly.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        )}
      </div>

      {monthly.length === 0 ? (
        <div className="text-center text-[#8595a8] py-20">No dated records found — run a sync first.</div>
      ) : (
        <>
          {/* Selected month cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {cards.map((c, i) => (
              <motion.div key={c.label}
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.07 }}
                className="rounded-2xl p-5 bg-white border border-[#e4ebf2]"
              >
                <c.icon size={18} style={{ color: c.color }} className="mb-3" />
                <p className="text-2xl font-bold text-[#1f3559]">{c.value}</p>
                <p className="text-xs text-[#697a91] mt-1">{c.label}</p>
              </motion.div>
            ))}
          </div>

          {/* Revenue trend bar chart */}
          <div className="rounded-2xl border border-[#e4ebf2] bg-white p-6">
            <h2 className="text-sm font-semibold text-[#34568a] mb-5">Revenue Trend (last 12 months)</h2>
            <div className="flex items-end gap-2 h-48">
              {monthly.slice(0, 12).reverse().map((m, i) => {
                const heightPct = (m.revenue / maxRevenue) * 100;
                return (
                  <div key={m.key} className="flex-1 flex flex-col items-center gap-2 group">
                    <div className="relative w-full flex-1 flex items-end">
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max(heightPct, 2)}%` }}
                        transition={{ delay: i * 0.05, duration: 0.6, ease: "easeOut" }}
                        className="w-full rounded-t-lg relative"
                        style={{ background: "linear-gradient(180deg, #15B7AE, #00857a)" }}
                      >
                        <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs text-[#0e8f88] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          {formatCurrency(m.revenue)}
                        </span>
                      </motion.div>
                    </div>
                    <span className="text-xs text-[#8595a8] rotate-0 whitespace-nowrap">{m.label.split(" ")[0]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* All-time totals + monthly table */}
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="rounded-2xl border border-[#e4ebf2] bg-white p-6 space-y-3">
              <h2 className="text-sm font-semibold text-[#34568a] mb-2">All-Time Totals</h2>
              {[
                { label: "Total Revenue", value: formatCurrency(totals.revenue), color: "#10b981" },
                { label: "Total Leads", value: totals.leads.toLocaleString(), color: "#6366f1" },
                { label: "Total Bookings", value: totals.bookings.toLocaleString(), color: "#f59e0b" },
                { label: "Total Calls", value: totals.calls.toLocaleString(), color: "#8b5cf6" },
                { label: "Total Agreements", value: totals.agreements.toLocaleString(), color: "#06b6d4" },
              ].map((t) => (
                <div key={t.label} className="flex items-center justify-between py-2 border-b border-[#e4ebf2] last:border-0">
                  <span className="text-sm text-[#697a91]">{t.label}</span>
                  <span className="text-sm font-semibold" style={{ color: t.color }}>{t.value}</span>
                </div>
              ))}
            </div>

            <div className="lg:col-span-2 rounded-2xl border border-[#e4ebf2] bg-white overflow-hidden">
              <div className="px-6 py-4 border-b border-[#e4ebf2]">
                <h2 className="text-sm font-semibold text-[#34568a]">Month-by-Month Breakdown</h2>
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-[#e4ebf2]">
                      {["Month", "Revenue", "Leads", "Bookings", "Calls", "Agreements"].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs text-[#697a91] uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m, i) => (
                      <tr key={m.key} className={i % 2 === 0 ? "bg-white" : ""}>
                        <td className="px-4 py-2.5 text-[#1e2a3a] font-medium">{m.label}</td>
                        <td className="px-4 py-2.5 text-[#0e8f88]">{formatCurrency(m.revenue)}</td>
                        <td className="px-4 py-2.5 text-[#34568a]">{m.leads}</td>
                        <td className="px-4 py-2.5 text-[#34568a]">{m.bookings}</td>
                        <td className="px-4 py-2.5 text-[#34568a]">{m.calls}</td>
                        <td className="px-4 py-2.5 text-[#34568a]">{m.agreements}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
