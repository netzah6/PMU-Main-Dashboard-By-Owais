"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Check, X, Undo2, ChevronDown, ChevronRight, Search, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

// Payment Check (owner 2026-10-18): each month of the Financing sheet matched
// against Square + dashboard charges. The owner taps Yes / Not paid on the
// rows that don't line up; later, clean matches can confirm on their own.
// The Financing sheet is only read — nothing here writes to it.

type Category = "declined" | "amount" | "unrecorded" | "norecord" | "late" | "match" | "scheduled" | "later" | "upfront" | "pps_none" | "noamount" | "inactive";
type Evidence = { kind: string; text: string; receiptUrl?: string | null };
type Row = { ownerKey: string; name: string; usd: number | null; sheetStatus: string; billing: string; payDay: string; notes: string; paidCents: number; evidence: Evidence[]; category: Category; suggested: "paid" | "not_paid" | null };
type Decision = { owner_key: string; decision: "paid" | "not_paid"; decided_by: string | null; decided_at: string };
type MonthTab = { month: string; tab: string; label: string };
type Unmatched = { id: string; customer: string; amountCents: number; at: string; note: string | null; receiptUrl: string | null };
type Payload = {
  months: MonthTab[]; month: string; tab: string; rows: Row[]; unmatched: Unmatched[]; squareChecked: boolean; warnings: string[];
  builtAt: string; decisions: Decision[]; autoconfirm: boolean; agreement: { agreed: number; total: number };
};

const REVIEW: Category[] = ["declined", "amount", "unrecorded", "norecord", "late"];
const LABEL: Record<Category, { text: string; cls: string }> = {
  declined: { text: "Card declined", cls: "bg-[#fde8ee] text-[#e11d48]" },
  amount: { text: "Different amount", cls: "bg-[#fff7ec] text-[#d97706]" },
  unrecorded: { text: "Paid, sheet not updated", cls: "bg-[#fff7ec] text-[#d97706]" },
  norecord: { text: "Sheet says paid, no payment found", cls: "bg-[#fff7ec] text-[#d97706]" },
  late: { text: "Pay day passed, not paid", cls: "bg-[#fde8ee] text-[#e11d48]" },
  match: { text: "Paid, matches sheet", cls: "bg-[#e6f7ee] text-[#15803d]" },
  scheduled: { text: "Scheduled", cls: "bg-[#e6f7f5] text-[#0e8f88]" },
  later: { text: "Pay day ahead", cls: "bg-[#f1f5f9] text-[#64748b]" },
  upfront: { text: "Paid upfront / prepaid plan", cls: "bg-[#f1f5f9] text-[#64748b]" },
  pps_none: { text: "PPS, no charges yet", cls: "bg-[#f1f5f9] text-[#64748b]" },
  noamount: { text: "No amount", cls: "bg-[#f1f5f9] text-[#64748b]" },
  inactive: { text: "Not billing", cls: "bg-[#f1f5f9] text-[#64748b]" },
};
const GROUPS: Array<{ cats: Category[]; title: string; hint: string }> = [
  { cats: ["scheduled"], title: "Scheduled to charge this month", hint: "Square or the dashboard will charge automatically." },
  { cats: ["later"], title: "Pay day still ahead", hint: "Has an amount, pay day hasn't come yet." },
  { cats: ["upfront"], title: "Paid upfront or on a prepaid plan", hint: "Covered by an earlier payment; no new charge expected." },
  { cats: ["pps_none"], title: "PPS with no charges this month", hint: "Pay-per-show, nothing billed yet." },
  { cats: ["noamount"], title: "No monthly amount", hint: "Deposit-only or $0 rows." },
  { cats: ["inactive"], title: "Paused, Grace or Need More Bookings", hint: "Not billing this month." },
];

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const usd = (v: number | null) => (v ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "");
const usDate = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function PaymentCheckPage() {
  const { role, loading: roleLoading } = useUser();
  const router = useRouter();
  useEffect(() => { if (!roleLoading && role !== "admin") router.replace("/clients"); }, [roleLoading, role, router]);

  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  const load = useCallback(async (m: string | null, refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (m) params.set("month", m);
      if (refresh) params.set("refresh", "1");
      const r = await fetch(`/api/payment-check?${params}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't load this month");
      setData(j);
      setMonth(j.month);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);
  useEffect(() => { if (role === "admin") load(null); }, [role, load]);

  const decided = useMemo(() => new Map((data?.decisions ?? []).map((d) => [d.owner_key, d])), [data]);

  const decide = useCallback(async (rows: Row[], decision: "paid" | "not_paid" | null, key: string) => {
    if (!data) return;
    setBusy(key);
    try {
      const r = await fetch("/api/payment-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decide", month: data.month, items: rows.map((x) => ({ ownerKey: x.ownerKey, clientName: x.name, decision, suggested: x.suggested })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      const keys = new Set(rows.map((x) => x.ownerKey));
      setData((d) => d && ({
        ...d,
        decisions: [
          ...d.decisions.filter((x) => !keys.has(x.owner_key)),
          ...(decision ? rows.map((x) => ({ owner_key: x.ownerKey, decision, decided_by: "you", decided_at: new Date().toISOString() })) : []),
        ],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, [data]);

  const setAuto = useCallback(async (enabled: boolean) => {
    setBusy("auto");
    try {
      const r = await fetch("/api/payment-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "autoconfirm", enabled }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save");
      setData((d) => d && ({ ...d, autoconfirm: enabled }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, []);

  const view = useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
    const by = (cats: Category[]) => rows.filter((r) => cats.includes(r.category));
    const review = by(REVIEW).sort((a, b) => REVIEW.indexOf(a.category) - REVIEW.indexOf(b.category) || a.name.localeCompare(b.name));
    const matches = by(["match"]);
    const openReview = review.filter((r) => !decided.has(r.ownerKey));
    const openMatches = data?.autoconfirm ? [] : matches.filter((r) => !decided.has(r.ownerKey));
    const collected = (data?.rows ?? []).reduce((s, r) => s + r.paidCents, 0);
    return { review, matches, openReview, openMatches, collected, by };
  }, [data, q, decided]);

  if (roleLoading || role !== "admin") return null;
  const label = data?.months.find((m) => m.month === month)?.label ?? "";

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Payment Check</h1>
          <p className="text-sm text-[#64748b] mt-0.5">Your Financing sheet matched against what Square and the dashboard actually charged. The sheet is only read, never changed.</p>
        </div>
        <div className="flex items-center gap-2">
          <select id="pc-month" value={month ?? ""} disabled={loading || refreshing || !data}
            onChange={(e) => load(e.target.value)}
            className="h-9 rounded-lg border border-[#d7e0ea] bg-white px-3 text-sm font-semibold text-[#1f3559]">
            {(data?.months ?? []).map((m) => <option key={m.month} value={m.month}>{m.label}</option>)}
          </select>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-[#0e8f88]" />}
          <button onClick={() => load(month, true)} disabled={loading || refreshing || !data}
            className="h-9 inline-flex items-center gap-1.5 rounded-lg border border-[#d7e0ea] bg-white px-3 text-sm font-semibold text-[#1f3559] hover:border-[#0e8f88] disabled:opacity-60">
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#e11d48]">{error}</div>}
      {loading && !data && <div className="flex items-center gap-2 text-sm text-[#64748b] py-10 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Matching payments… the first load of a month can take a minute.</div>}

      {data && (
        <>
          {data.warnings.map((w) => <div key={w} className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-sm text-[#b45309]">{w}</div>)}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat n={view.openReview.length + view.openMatches.length} label="left for you to check" tone="bad" />
            <Stat n={view.review.length} label="don't line up" tone="warn" />
            <Stat n={view.matches.length} label="paid and match" tone="ok" />
            <Stat n={view.by(["scheduled"]).length} label="scheduled this month" />
            <Stat text={money(view.collected)} label={`collected in ${label.split(" ")[0]}`} />
          </div>

          <div className="rounded-xl border border-[#d7e0ea] bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-[#1f3559]">
              <span className="font-semibold">Auto-confirm clean matches</span>
              <span className="text-[#64748b]"> · {data.autoconfirm ? "On: matches confirm themselves, you only see the odd ones." : "Off: you confirm every payment, matches included."}</span>
              {data.agreement.total > 0 && <span className="block text-xs text-[#64748b] mt-0.5">You agreed with the suggestion {data.agreement.agreed} of {data.agreement.total} times so far.</span>}
            </div>
            <button onClick={() => setAuto(!data.autoconfirm)} disabled={busy === "auto"}
              className={cn("h-8 inline-flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold border",
                data.autoconfirm ? "bg-[#0e8f88] border-[#0e8f88] text-white" : "bg-white border-[#d7e0ea] text-[#1f3559] hover:border-[#0e8f88]")}>
              {busy === "auto" && <Loader2 className="w-4 h-4 animate-spin" />}
              {data.autoconfirm ? "Turn off" : "Turn on"}
            </button>
          </div>

          <div className="relative max-w-xs">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#a6b3c4]" />
            <input id="pc-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client"
              className="h-9 w-full rounded-lg border border-[#d7e0ea] bg-white pl-8 pr-3 text-sm" />
          </div>

          <Section title="Needs your OK" hint="Money moved but the sheet doesn't say so, the sheet says paid with no payment found, a different amount, a declined card, or a pay day that passed.">
            {view.review.length ? view.review.map((r) => (
              <RowView key={r.ownerKey} r={r} d={decided.get(r.ownerKey)} busy={busy} onDecide={decide} />
            )) : <Empty text="Nothing to check here." />}
          </Section>

          <Section title="Paid and matches the sheet"
            hint={data.autoconfirm ? "Confirmed automatically." : "Tap Yes to confirm, or confirm them all at once."}
            action={!data.autoconfirm && view.openMatches.length > 0 && (
              <button onClick={() => decide(view.openMatches, "paid", "all")} disabled={busy === "all"}
                className="h-8 inline-flex items-center gap-1.5 rounded-lg bg-[#15803d] px-3 text-sm font-semibold text-white disabled:opacity-60">
                {busy === "all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Confirm all {view.openMatches.length}
              </button>
            )}>
            {view.matches.length ? view.matches.map((r) => (
              <RowView key={r.ownerKey} r={r} d={decided.get(r.ownerKey)} auto={data.autoconfirm} busy={busy} onDecide={decide} />
            )) : <Empty text="No matched payments yet." />}
          </Section>

          {GROUPS.map((g) => {
            const rows = view.by(g.cats);
            if (!rows.length) return null;
            const isOpen = !!open[g.title];
            return (
              <div key={g.title} className="rounded-xl border border-[#d7e0ea] bg-white">
                <button onClick={() => setOpen((o) => ({ ...o, [g.title]: !isOpen }))} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
                  <span className="text-sm font-semibold text-[#1f3559]">{g.title} <span className="text-[#64748b] font-normal">· {rows.length} · {g.hint}</span></span>
                  {isOpen ? <ChevronDown className="w-4 h-4 text-[#64748b]" /> : <ChevronRight className="w-4 h-4 text-[#64748b]" />}
                </button>
                {isOpen && <div className="border-t border-[#e8eef5]">{rows.map((r) => <RowView key={r.ownerKey} r={r} busy={busy} onDecide={decide} readOnly />)}</div>}
              </div>
            );
          })}

          {data.squareChecked && data.unmatched.length > 0 && (
            <div className="rounded-xl border border-[#d7e0ea] bg-white">
              <button onClick={() => setOpen((o) => ({ ...o, unmatched: !o.unmatched }))} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
                <span className="text-sm font-semibold text-[#1f3559]">Square payments not tied to a client <span className="text-[#64748b] font-normal">· {data.unmatched.length} · {money(data.unmatched.reduce((s, u) => s + u.amountCents, 0))}</span></span>
                {open.unmatched ? <ChevronDown className="w-4 h-4 text-[#64748b]" /> : <ChevronRight className="w-4 h-4 text-[#64748b]" />}
              </button>
              {open.unmatched && (
                <div className="border-t border-[#e8eef5] divide-y divide-[#e8eef5]">
                  {data.unmatched.map((u) => (
                    <div key={u.id} className="px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="text-[#1f3559] font-medium">{u.customer}{u.note && <span className="text-[#64748b] font-normal"> · {u.note}</span>}</span>
                      <span className="flex items-center gap-3 text-[#64748b]">
                        <span className="font-semibold text-[#1f3559] tabular-nums">{money(u.amountCents)}</span>{usDate(u.at)}
                        {u.receiptUrl && <a href={u.receiptUrl} target="_blank" rel="noreferrer" className="text-[#0e8f88]"><ExternalLink className="w-3.5 h-3.5" /></a>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-[#94a3b8]">Sheet tab: {data.tab} · matched {usDate(data.builtAt)} · sources: Square payments{data.squareChecked ? "" : " (not checked)"}, dashboard subscription charges, PPS charges, Square subscriptions. PayPal and Whop aren&apos;t connected.</p>
        </>
      )}
    </div>
  );
}

function Stat({ n, text, label, tone }: { n?: number; text?: string; label: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="rounded-lg border border-[#d7e0ea] bg-white px-3 py-2">
      <p className={cn("text-xl font-bold tabular-nums", tone === "bad" ? "text-[#e11d48]" : tone === "warn" ? "text-[#d97706]" : tone === "ok" ? "text-[#15803d]" : "text-[#1f3559]")}>{text ?? n}</p>
      <p className="text-xs text-[#64748b]">{label}</p>
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-[#1f3559]">{title}</h2>
          <p className="text-xs text-[#64748b] max-w-2xl">{hint}</p>
        </div>
        {action}
      </div>
      <div className="rounded-xl border border-[#d7e0ea] bg-white divide-y divide-[#e8eef5] overflow-hidden">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-4 text-sm text-[#94a3b8]">{text}</p>;
}

function RowView({ r, d, auto, busy, onDecide, readOnly }: {
  r: Row; d?: Decision; auto?: boolean; busy: string | null; readOnly?: boolean;
  onDecide: (rows: Row[], decision: "paid" | "not_paid" | null, key: string) => void;
}) {
  const lab = LABEL[r.category];
  const meta = [`Sheet: ${r.sheetStatus || "blank"}`, usd(r.usd), r.payDay && `pay day ${r.payDay}`, r.billing].filter(Boolean).join(" · ");
  const yesKey = `yes:${r.ownerKey}`, noKey = `no:${r.ownerKey}`, undoKey = `undo:${r.ownerKey}`;
  return (
    <div className="px-4 py-3 grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="font-semibold text-[#1f3559] truncate">{r.name}</p>
        <p className="text-xs text-[#64748b]">{meta}</p>
      </div>
      <div className="min-w-0 text-sm space-y-0.5">
        <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-bold", lab.cls)}>{lab.text}</span>
        {r.evidence.length ? r.evidence.map((e, i) => (
          <p key={i} className="text-[#1f3559]">{e.text}{e.receiptUrl && <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex text-[#0e8f88] align-middle"><ExternalLink className="w-3.5 h-3.5" /></a>}</p>
        )) : <p className="text-[#94a3b8]">No payment found in Square or the dashboard</p>}
        {r.notes && <p className="text-xs text-[#94a3b8]">Note: {r.notes}</p>}
      </div>
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5 md:justify-end">
          {d ? (
            <>
              <span className={cn("inline-flex items-center rounded-full px-2 py-1 text-xs font-bold", d.decision === "paid" ? "bg-[#e6f7ee] text-[#15803d]" : "bg-[#fde8ee] text-[#e11d48]")}>
                {d.decision === "paid" ? "Confirmed paid" : "Marked not paid"}
              </span>
              <button onClick={() => onDecide([r], null, undoKey)} disabled={busy === undoKey}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-[#64748b] hover:text-[#1f3559]">
                {busy === undoKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo
              </button>
            </>
          ) : auto && r.category === "match" ? (
            <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-bold bg-[#e6f7ee] text-[#15803d]">Auto-confirmed</span>
          ) : (
            <>
              <button onClick={() => onDecide([r], "paid", yesKey)} disabled={!!busy}
                className="h-8 inline-flex items-center gap-1 rounded-lg bg-[#15803d] px-3 text-sm font-semibold text-white disabled:opacity-60">
                {busy === yesKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Yes, paid
              </button>
              <button onClick={() => onDecide([r], "not_paid", noKey)} disabled={!!busy}
                className="h-8 inline-flex items-center gap-1 rounded-lg border border-[#d7e0ea] bg-white px-3 text-sm font-semibold text-[#e11d48] disabled:opacity-60">
                {busy === noKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Not paid
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
