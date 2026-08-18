"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { MakeRoutesReport } from "@/lib/make-routes";

// Read-only viewer for the Fanbasis Make scenario: every router route as a
// searchable table row, with duplicate/no-webhook/missing-client flags.
// No action buttons on purpose — editing routes happens in the Make editor.

export default function MakeRoutesPage() {
  const [report, setReport] = useState<MakeRoutesReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  async function load() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/onboarding/make-routes");
      const j = (await r.json()) as MakeRoutesReport & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setReport(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const dupIdx = useMemo(() => new Set((report?.duplicates ?? []).flatMap((d) => d.routeIdxs)), [report]);
  const rows = useMemo(() => {
    const list = report?.routes ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((r) =>
      [r.matchedBusiness, r.label, r.filterText, r.webhook, String(r.idx)].join(" ").toLowerCase().includes(needle)
    );
  }, [report, q]);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="text-2xl font-bold text-[#1f3559] tracking-tight">🔀 Make routes</h1>
        <div className="flex items-center gap-2">
          <Link href="/onboarding" className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f1f5f9] text-[#34568a] border border-[#e4ebf2] hover:bg-[#e6f7f5]">
            ← Onboarding
          </Link>
          <button onClick={load} disabled={busy}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f1f5f9] text-[#34568a] border border-[#e4ebf2] hover:bg-[#e6f7f5] disabled:opacity-50">
            {busy ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="text-sm text-[#697a91] mb-4">
        View-only map of the Fanbasis scenario{report?.scenarioName ? <> — <span className="font-medium">{report.scenarioName}</span></> : null}.
        Reading it uses no Make operations. Edit routes in the Make editor.
      </p>

      {err && (
        <div className="rounded-lg border border-[#d97070] bg-[#fdf3f3] p-3 text-sm text-[#8a3a3a] mb-4">{err}</div>
      )}
      {busy && !report && <div className="text-sm text-[#697a91]">Reading the scenario…</div>}

      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
              <div className="text-xs text-[#8595a8]">Total routes</div>
              <div className="text-2xl font-bold text-[#1f3559]">{report.routes.length}</div>
            </div>
            <div className={`rounded-xl p-3 ${report.duplicates.length ? "bg-[#fdf3f3] border border-[#f0b9b9]" : "border border-[#e4ebf2] bg-white"}`}>
              <div className={`text-xs ${report.duplicates.length ? "text-[#a32d2d]" : "text-[#8595a8]"}`}>Duplicate routes</div>
              <div className={`text-2xl font-bold ${report.duplicates.length ? "text-[#a32d2d]" : "text-[#1f3559]"}`}>{report.duplicates.length}</div>
            </div>
            <div className={`rounded-xl p-3 ${report.noWebhook.length ? "bg-[#fbf7f1] border border-[#ecd3a8]" : "border border-[#e4ebf2] bg-white"}`}>
              <div className={`text-xs ${report.noWebhook.length ? "text-[#854f0b]" : "text-[#8595a8]"}`}>No webhook in route</div>
              <div className={`text-2xl font-bold ${report.noWebhook.length ? "text-[#854f0b]" : "text-[#1f3559]"}`}>{report.noWebhook.length}</div>
            </div>
            <div className={`rounded-xl p-3 ${report.missingClients.length ? "bg-[#fbf7f1] border border-[#ecd3a8]" : "border border-[#e4ebf2] bg-white"}`}>
              <div className={`text-xs ${report.missingClients.length ? "text-[#854f0b]" : "text-[#8595a8]"}`}>Live clients with no route</div>
              <div className={`text-2xl font-bold ${report.missingClients.length ? "text-[#854f0b]" : "text-[#1f3559]"}`}>{report.missingClients.length}</div>
            </div>
          </div>

          {report.duplicates.length > 0 && (
            <div className="rounded-xl border border-[#f0b9b9] bg-[#fdf3f3] p-3 mb-4 text-sm text-[#8a3a3a]">
              <span className="font-semibold">Duplicates — each extra route writes the deposit twice:</span>{" "}
              {report.duplicates.map((d) => `${d.business} (routes ${d.routeIdxs.join(" + ")})`).join(" · ")}
            </div>
          )}
          {report.missingClients.length > 0 && (
            <div className="rounded-xl border border-[#ecd3a8] bg-[#fbf7f1] p-3 mb-4 text-sm text-[#6b4d16]">
              <span className="font-semibold">Live clients with no route (deposits can’t reach the sheet):</span>{" "}
              {report.missingClients.join(" · ")}
            </div>
          )}

          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search client, business, route number, or webhook…"
            className="w-full rounded-lg border border-[#e4ebf2] p-2.5 text-sm text-[#1f3559] outline-none focus:border-[#15B7AE] mb-3"
          />

          <div className="rounded-xl border border-[#e4ebf2] overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#8595a8] border-b border-[#e4ebf2]">
                  <th className="px-3 py-2 font-semibold w-14">#</th>
                  <th className="px-3 py-2 font-semibold">Client</th>
                  <th className="px-3 py-2 font-semibold hidden sm:table-cell">Filter matches on</th>
                  <th className="px-3 py-2 font-semibold">Webhook</th>
                  <th className="px-3 py-2 font-semibold w-32">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.idx} className="border-b border-[#f1f5f9] last:border-0">
                    <td className="px-3 py-2 text-[#8595a8]">{r.idx}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-[#1f3559]">{r.matchedBusiness ?? <span className="text-[#a3adbb]">unmatched</span>}</div>
                      {r.label && <div className="text-[11px] text-[#a3adbb]">{r.label}</div>}
                      {r.matchedStatus && r.matchedStatus !== "Live" && (
                        <div className="text-[11px] text-[#8595a8]">{r.matchedStatus}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-[#697a91] hidden sm:table-cell max-w-[220px] truncate" title={r.filterText}>{r.filterText}</td>
                    <td className="px-3 py-2 text-xs text-[#697a91] max-w-[180px] truncate" title={r.webhook ?? undefined}>
                      {r.webhook ? `…/${r.webhook.split("/").slice(-1)[0]}` : <span className="text-[#b58324]">none</span>}
                    </td>
                    <td className="px-3 py-2">
                      {dupIdx.has(r.idx) ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#fdecec] text-[#a32d2d]">duplicate</span>
                      ) : !r.webhook ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#fbf3e2] text-[#854f0b]">no webhook</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#e7f6ec] text-[#15803d]">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-[#8595a8]">No routes match that search.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#9aa8bc] mt-2">
            Read {new Date(report.fetchedAt).toLocaleString()} · scenario id {report.scenarioId} · zone {report.zone}
          </p>
        </>
      )}
    </div>
  );
}
