import { loadApp, type AppLead } from "@/lib/client-app";
import { day } from "@/components/client-app/BillingView";

/* Leads: who came in, and how far each one got. Names, dates and a status —
   the conversation itself stays in the messaging app for now. */
const STATE: Record<AppLead["state"], { label: string; cls: string }> = {
  paid: { label: "Paid a deposit", cls: "bg-[#e6f7ee] text-[#15803d]" },
  booked: { label: "Picked a time", cls: "bg-[#fff4e5] text-[#b45309]" },
  talking: { label: "In conversation", cls: "bg-[#f1f5f9] text-[#52627a]" },
};

export default async function ClientAppLeads({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const { leads, leads30, booked30, paid30 } = app;
  return (
    <div className="space-y-3">
      <section className="grid grid-cols-3 gap-2">
        {[
          { n: leads30, label: "New leads" },
          { n: booked30, label: "Picked a time" },
          { n: paid30, label: "Paid a deposit" },
        ].map((k) => (
          <div key={k.label} className="rounded-2xl border border-[#c9dbfb] bg-white px-3 py-2 text-center">
            <p className="text-2xl font-extrabold text-[#1c2b3a]">{k.n}</p>
            <p className="text-[11px] font-semibold text-[#52627a]">{k.label}</p>
          </div>
        ))}
      </section>
      <p className="px-1 text-xs text-[#7b8a9c]">Last 30 days</p>

      <section className="rounded-2xl border border-[#e4ebf2] bg-white px-4 py-1">
        {leads.length === 0 ? (
          <p className="py-3 text-sm text-[#7b8a9c]">No leads yet.</p>
        ) : (
          <ul>
            {leads.map((l, i) => (
              <li key={i} className="flex items-center gap-2 border-b border-[#eef3f8] py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#1c2b3a]">{l.name}</p>
                  <p className="text-xs text-[#7b8a9c]">{day(l.at)}</p>
                </div>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATE[l.state].cls}`}>{STATE[l.state].label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
