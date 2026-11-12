import type { PortalShow, PortalView } from "@/lib/ppa-portal";

/* The client's billing, as she sees it: one number on top, detail behind a
   click. Shared by the standalone /my-billing page and the client app's
   Billing tab, so both always read the same. Server component, no JS. */

export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const day = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
export const HOW: Record<string, { label: string; cls: string }> = {
  served: { label: "Paid a deposit", cls: "bg-[#e6f7ee] text-[#15803d]" },
  past_due: { label: "Paid a deposit", cls: "bg-[#e6f7ee] text-[#15803d]" },
  self_booked: { label: "Booked with you directly", cls: "bg-[#fff4e5] text-[#b45309]" },
  calendar_booked: { label: "On your calendar", cls: "bg-[#fff4e5] text-[#b45309]" },
  chat_booked: { label: "Booked in chat", cls: "bg-[#f3e8ff] text-[#7e22ce]" },
};

export function ShowRow({ s, fee }: { s: PortalShow; fee?: number }) {
  const how = HOW[s.how] ?? { label: "", cls: "" };
  return (
    <li className="flex items-center gap-2 py-2 border-b border-[#eef3f8] last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-[#1c2b3a] truncate">{s.name}</div>
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-[#7b8a9c]">
          {day(s.date) && <span>{day(s.date)}</span>}
          {how.label && <span className={`px-1.5 py-0.5 rounded font-semibold ${how.cls}`}>{how.label}</span>}
        </div>
      </div>
      {fee != null && <div className="text-sm font-bold text-[#1c2b3a]">{usd(fee)}</div>}
    </li>
  );
}

export function Fold({ title, count, children, open }: { title: string; count: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-2xl border border-[#e4ebf2] bg-white" open={open}>
      <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none select-none">
        <span className="text-sm font-bold text-[#1c2b3a]">{title}</span>
        <span className="ml-auto text-sm text-[#7b8a9c]">{count}</span>
        <span className="text-[#9aa8b8] transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-3">{children}</div>
    </details>
  );
}

export function BillingView({ v, showUpcoming = true }: { v: PortalView; showUpcoming?: boolean }) {
  return (
    <div className="space-y-3">
      {/* The one number that matters. */}
      <section className={`rounded-2xl border p-4 ${v.owed.count > 0 ? "border-[#fcd9a8] bg-[#fffdf7]" : "border-[#c7edd4] bg-[#f4fbf7]"}`}>
        {v.owed.count > 0 ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#b45309]">Not charged yet</p>
            <p className="text-3xl font-extrabold text-[#1c2b3a]">{usd(v.owed.amount)}</p>
            <p className="text-sm text-[#7b8a9c]">
              {v.owed.count} show{v.owed.count === 1 ? "" : "s"} × {usd(v.fee)} = {usd(v.owed.gross)}
              {v.owed.credit > 0 && <> − {usd(v.owed.credit)} credit</>}
            </p>
            <ul className="mt-2 rounded-xl bg-white border border-[#f3e3c7] px-3">
              {v.owed.shows.map((s, i) => <ShowRow key={i} s={s} fee={v.fee} />)}
            </ul>
          </>
        ) : (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#15803d]">Not charged yet</p>
            <p className="text-3xl font-extrabold text-[#1c2b3a]">$0</p>
            <p className="text-sm text-[#7b8a9c]">You&apos;re all paid up.</p>
          </>
        )}
      </section>

      {showUpcoming && v.upcoming.length > 0 && (
        <Fold title="Upcoming appointments" count={`${v.upcoming.length} · nothing owed yet`}>
          <ul>{v.upcoming.map((s, i) => <ShowRow key={i} s={s} />)}</ul>
        </Fold>
      )}

      <Fold title="Payments" count={v.payments.length ? `${v.payments.length} · ${usd(v.paidTotal)} paid` : "none yet"}>
        {v.payments.length === 0 ? (
          <p className="text-sm text-[#7b8a9c] py-1">No payments yet.</p>
        ) : (
          <ul>
            {v.payments.map((p, i) => (
              <li key={i} className="py-2 border-b border-[#eef3f8] last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-[#1c2b3a]">{p.creditOnly ? `${usd(p.credit)} credit used` : usd(p.total)}</span>
                  <span className="text-xs text-[#7b8a9c]">{day(p.at)}</span>
                  {p.receiptUrl && (
                    <a href={p.receiptUrl} target="_blank" rel="noreferrer noopener" className="ml-auto text-xs font-semibold text-[#0e8f88] underline">Receipt</a>
                  )}
                </div>
                <p className="text-xs text-[#52627a]">
                  {p.names.length} show{p.names.length === 1 ? "" : "s"}: {p.names.join(", ")}
                  {!p.creditOnly && p.credit > 0 && <> · {usd(p.gross)} − {usd(p.credit)} credit</>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Fold>

      {v.credits.length > 0 && (
        <Fold title="Credit" count={`${usd(v.creditLeft)} left`}>
          <ul>
            {v.credits.map((c, i) => (
              <li key={i} className="py-2 border-b border-[#eef3f8] last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-[#1c2b3a]">+{usd(c.amount)}</span>
                  <span className="text-xs text-[#7b8a9c]">{day(c.at)}</span>
                  <span className="ml-auto text-xs font-semibold text-[#15803d]">{usd(c.left)} left</span>
                </div>
                {c.reason && c.reason.trim().length > 1 && <p className="text-xs text-[#52627a]">{c.reason}</p>}
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </div>
  );
}
