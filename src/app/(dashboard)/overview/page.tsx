"use client";
import { useEffect, useState, useRef } from "react";
import { motion, useInView } from "framer-motion";
import Link from "next/link";
import { useTableData } from "@/lib/hooks/useTableData";
import {
  Users, TrendingUp, DollarSign, Calendar,
  Phone, FileText, BarChart2, Map, ArrowRight,
  Activity, Target, Zap,
} from "lucide-react";
import { ClientHealthList } from "@/components/overview/ClientHealthList";

// Animated counter
function Counter({ to, prefix = "", suffix = "", duration = 1.5 }: {
  to: number; prefix?: string; suffix?: string; duration?: number;
}) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });

  useEffect(() => {
    if (!inView) return;
    let start = 0;
    const steps = 60;
    const inc = to / steps;
    const timer = setInterval(() => {
      start += inc;
      if (start >= to) { setCount(to); clearInterval(timer); }
      else setCount(Math.floor(start));
    }, (duration * 1000) / steps);
    return () => clearInterval(timer);
  }, [inView, to, duration]);

  return <span ref={ref}>{prefix}{count.toLocaleString()}{suffix}</span>;
}

import type { Variants } from "framer-motion";

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.08, duration: 0.5, ease: "easeOut" },
  }),
};

const TABS = [
  { label: "Clients", href: "/clients", icon: Users, color: "#15B7AE", desc: "Manage your client portfolio" },
  { label: "Performance", href: "/performance", icon: TrendingUp, color: "#6366f1", desc: "Track call & booking metrics" },
  { label: "Deposits", href: "/deposits", icon: DollarSign, color: "#10b981", desc: "Revenue & payment tracking" },
  { label: "Bookings", href: "/bookings", icon: Calendar, color: "#f59e0b", desc: "Appointment management" },
  { label: "Leads", href: "/leads", icon: Zap, color: "#ec4899", desc: "Incoming lead pipeline" },
  { label: "Calls", href: "/calls", icon: Phone, color: "#8b5cf6", desc: "Outgoing call log" },
  { label: "Agreements", href: "/agreements", icon: FileText, color: "#06b6d4", desc: "Signed client agreements" },
  { label: "CPL & Budget", href: "/cpl-7days", icon: BarChart2, color: "#f97316", desc: "Ad performance & spend" },
  { label: "LTV", href: "/ltv", icon: Target, color: "#14b8a6", desc: "Lifetime value analysis" },
  { label: "Map", href: "/map", icon: Map, color: "#84cc16", desc: "Geographic client view" },
  { label: "Reports", href: "/reports", icon: Activity, color: "#a855f7", desc: "Monthly analytics reports" },
];

export default function OverviewPage() {
  const { data: clients } = useTableData<Record<string, unknown>>({ table: "clients_master", realtimeEnabled: true });
  const { data: leads } = useTableData<Record<string, unknown>>({ table: "leads_master" });
  const { data: deposits } = useTableData<Record<string, unknown>>({ table: "deposits" });
  const { data: bookings } = useTableData<Record<string, unknown>>({ table: "bookings" });

  const liveClients = clients.filter((c) => String(c["col_1"] ?? c.status ?? "").toLowerCase() === "live").length;
  const pausedClients = clients.filter((c) => String(c["col_1"] ?? c.status ?? "").toLowerCase() === "paused").length;

  const now = new Date();
  const thisMonthDeposits = deposits
    .filter((d) => {
      const dt = new Date(String(d["Date"] ?? d.date ?? ""));
      return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
    })
    .reduce((s, d) => {
      const v = parseFloat(String(d["Amount"] ?? d.amount ?? "").replace(/[$,]/g, ""));
      return s + (isNaN(v) ? 0 : v);
    }, 0);

  const thisMonthLeads = leads.filter((l) => {
    const dt = new Date(String(l["Date"] ?? l.date ?? ""));
    return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
  }).length;

  const stats = [
    { label: "Total Clients", value: clients.length, suffix: "", icon: Users, color: "#15B7AE", bg: "from-[#e6faf8] to-[#f2fbfa]" },
    { label: "Live", value: liveClients, suffix: "", icon: Zap, color: "#10b981", bg: "from-[#e6f7f0] to-[#f1faf6]" },
    { label: "This Month Leads", value: thisMonthLeads, suffix: "", icon: TrendingUp, color: "#6366f1", bg: "from-[#eaeeff] to-[#f3f5ff]" },
    { label: "This Month Revenue", value: Math.round(thisMonthDeposits), prefix: "$", suffix: "", icon: DollarSign, color: "#f59e0b", bg: "from-[#fff5e6] to-[#fffaf1]" },
    { label: "Total Bookings", value: bookings.length, suffix: "", icon: Calendar, color: "#ec4899", bg: "from-[#fdeaf2] to-[#fdf4f8]" },
    { label: "Paused", value: pausedClients, suffix: "", icon: Activity, color: "#f97316", bg: "from-[#fff0e6] to-[#fff7f1]" },
  ];

  // Status breakdown for donut-like bar
  const total = clients.length || 1;
  const livePct = (liveClients / total) * 100;
  const pausedPct = (pausedClients / total) * 100;
  const lostPct = 100 - livePct - pausedPct;

  return (
    <div className="overflow-y-auto h-full">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
        className="relative px-8 pt-10 pb-8 overflow-hidden border-b border-[#e4ebf2]"
        style={{ background: "linear-gradient(135deg, #ffffff 0%, #eef6f5 100%)" }}
      >
        {/* Animated background blobs */}
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.15, 0.25, 0.15] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-0 right-0 w-96 h-96 rounded-full blur-3xl"
          style={{ background: "#15B7AE20" }}
        />
        <motion.div
          animate={{ scale: [1.2, 1, 1.2], opacity: [0.1, 0.2, 0.1] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut", delay: 2 }}
          className="absolute bottom-0 left-1/3 w-72 h-72 rounded-full blur-3xl"
          style={{ background: "#6366f120" }}
        />

        <div className="relative z-10">
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-[#0e8f88] text-sm font-medium mb-1 tracking-widest uppercase"
          >
            PMU Bookings On Demand
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-4xl font-bold text-[#1f3559] mb-2"
          >
            Master Dashboard
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
            className="text-[#697a91] text-sm"
          >
            {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </motion.p>

          {/* Status bar */}
          {clients.length > 0 && (
            <motion.div
              initial={{ opacity: 0, scaleX: 0 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={{ delay: 0.5, duration: 0.8, ease: "easeOut" }}
              className="mt-6 max-w-md"
              style={{ transformOrigin: "left" }}
            >
              <div className="flex justify-between text-xs text-[#697a91] mb-1.5">
                <span>Client Status Distribution</span>
                <span>{clients.length} total</span>
              </div>
              <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5">
                <motion.div style={{ width: `${livePct}%`, background: "#10b981" }}
                  initial={{ width: 0 }} animate={{ width: `${livePct}%` }}
                  transition={{ delay: 0.7, duration: 0.8 }} className="rounded-l-full" />
                <motion.div style={{ width: `${pausedPct}%`, background: "#f59e0b" }}
                  initial={{ width: 0 }} animate={{ width: `${pausedPct}%` }}
                  transition={{ delay: 0.9, duration: 0.6 }} />
                <motion.div style={{ width: `${lostPct}%`, background: "#ef4444" }}
                  initial={{ width: 0 }} animate={{ width: `${lostPct}%` }}
                  transition={{ delay: 1.1, duration: 0.6 }} className="rounded-r-full flex-1" />
              </div>
              <div className="flex gap-4 mt-1.5 text-xs">
                <span className="text-[#0e8f88]">● Live {liveClients}</span>
                <span className="text-[#d97706]">● Paused {pausedClients}</span>
                <span className="text-[#e11d48]">● Other {clients.length - liveClients - pausedClients}</span>
              </div>
            </motion.div>
          )}
        </div>
      </motion.div>

      <div className="px-8 pb-10 space-y-8 mt-6">
        {/* Client health scores */}
        <ClientHealthList />

        {/* Stats grid */}
        <div>
          <motion.h2 initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
            className="text-xs font-semibold text-[#8595a8] uppercase tracking-widest mb-4">
            Key Metrics
          </motion.h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {stats.map((s, i) => (
              <motion.div key={s.label} custom={i} initial="hidden" animate="visible" variants={fadeUp}
                className={`relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br ${s.bg} border border-[#e4ebf2]`}
                whileHover={{ scale: 1.03, transition: { duration: 0.2 } }}
              >
                <motion.div
                  animate={{ rotate: [0, 5, -5, 0] }}
                  transition={{ duration: 4, repeat: Infinity, delay: i * 0.5 }}
                  className="mb-3"
                >
                  <s.icon size={20} style={{ color: s.color }} />
                </motion.div>
                <p className="text-2xl font-bold text-[#1f3559]">
                  <Counter to={s.value} prefix={s.prefix} suffix={s.suffix} />
                </p>
                <p className="text-xs text-[#697a91] mt-1">{s.label}</p>
                <div className="absolute -bottom-3 -right-3 w-14 h-14 rounded-full opacity-10"
                  style={{ background: s.color }} />
              </motion.div>
            ))}
          </div>
        </div>

        {/* Quick access tabs */}
        <div>
          <motion.h2 initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
            className="text-xs font-semibold text-[#8595a8] uppercase tracking-widest mb-4">
            Quick Access
          </motion.h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {TABS.map((tab, i) => (
              <motion.div key={tab.href} custom={i} initial="hidden" animate="visible" variants={fadeUp}>
                <Link href={tab.href}
                  className="flex flex-col gap-3 p-4 rounded-xl border border-[#e4ebf2] bg-white hover:bg-white hover:border-[#d7e0ea] transition-all group block"
                >
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                      style={{ background: `${tab.color}20` }}>
                      <tab.icon size={16} style={{ color: tab.color }} />
                    </div>
                    <ArrowRight size={13} className="text-[#a6b3c4] group-hover:text-[#34568a] group-hover:translate-x-0.5 transition-all" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#1e2a3a]">{tab.label}</p>
                    <p className="text-xs text-[#8595a8] mt-0.5 leading-snug">{tab.desc}</p>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
