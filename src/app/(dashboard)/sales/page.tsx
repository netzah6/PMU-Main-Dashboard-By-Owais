"use client";

import { useState } from "react";
import type { DemoResult, DemoStatus } from "@/lib/demo-check";

const SECTIONS: Array<{ key: DemoStatus; label: string; emoji: string; tint: string; border: string }> = [
  { key: "showed",        label: "Showed",           emoji: "✅", tint: "#f0fbfa", border: "#15B7AE" },
  { key: "not_yet",       label: "Not happened yet", emoji: "📅", tint: "#f5f8fc", border: "#7f9cc4" },
  { key: "no_show",       label: "No-show",          emoji: "❌", tint: "#fdf3f3", border: "#d97070" },
  { key: "cancelled",     label: "Cancelled",        emoji: "⛔", tint: "#fbf7f1", border: "#d0a05e" },
  { key: "not_in_system", label: "Not in the system",emoji: "❓", tint: "#f7f7f9", border: "#a3adbb" },
];

export default function SalesPage() {
  const [raw, setRaw] = useState("");
  const [results, setResults] = useState<DemoResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const names = raw.split(/[\n,]/).map((n) => n.trim()).filter(Boolean);

  async function run() {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const r = await fetch("/api/sales/demo-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResults(j.results as DemoResult[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = results?.filter((r) => r.status === "showed").length ?? 0;
  const resolved = results?.filter((r) => r.status !== "not_yet" && r.status !== "not_in_system").length ?? 0;

  // The exact message the team posts in Slack after a check — same sections,
  // same emojis, "Showed" counted against everything checked.
  function copyForSlack() {
    if (!results) return;
    const blocks: string[] = [];
    for (const sec of SECTIONS) {
      const rows = results.filter((r) => r.status === sec.key);
      if (!rows.length) continue;
      const count = sec.key === "showed" ? `(${rows.length}/${results.length})` : `${rows.length}`;
      const lines = rows.map((r) => (r.note ? `${r.query} — ${r.note}` : r.query));
      blocks.push(`${sec.emoji} ${sec.label} — ${count}\n${lines.join("\n")}`);
    }
    navigator.clipboard.writeText(blocks.join("\n\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-[#1f3559] tracking-tight">💼 Sales — Demo Checker</h1>
      <p className="mt-1 text-sm text-[#697a91]">
        Paste contact names (one per line). Each is checked against its sales-pipeline stage — the stage is what proves
        whether the demo actually happened, since a past demo stays &ldquo;confirmed&rdquo; on the calendar either way.
      </p>

      <div className="mt-5 rounded-xl border border-[#e4ebf2] bg-white p-4">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
          placeholder={"Cynthia Lowry\nGina Alsaddi\nLiza Martinez"}
          className="w-full rounded-lg border border-[#e4ebf2] p-3 text-sm text-[#1f3559] outline-none focus:border-[#15B7AE] font-mono"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={run}
            disabled={busy || !names.length}
            className="rounded-lg bg-[#15B7AE] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? `Checking ${names.length}…` : `Check ${names.length || ""} contact${names.length === 1 ? "" : "s"}`}
          </button>
          <span className="text-xs text-[#8595a8]">
            {names.length > 25 ? "Large lists take a while — roughly a second per name." : " "}
          </span>
        </div>
      </div>

      {err && (
        <div className="mt-4 rounded-lg border border-[#d97070] bg-[#fdf3f3] p-3 text-sm text-[#8a3a3a]">{err}</div>
      )}

      {results && (
        <>
          <div className="mt-6 rounded-xl border border-[#e4ebf2] bg-white px-4 py-3 text-sm text-[#1f3559] flex items-center gap-3 flex-wrap">
            <span>
              <strong>{shown}</strong> showed out of <strong>{resolved}</strong> resolved
              {resolved > 0 && <> — <strong>{Math.round((shown / resolved) * 100)}%</strong> show rate</>}
              <span className="text-[#8595a8]"> · {results.length} checked</span>
            </span>
            <button
              onClick={copyForSlack}
              className="ml-auto rounded-lg border border-[#15B7AE] bg-[#f0fbfa] px-4 py-1.5 text-xs font-bold text-[#0e8f88] hover:bg-[#e0f6f4]"
            >
              {copied ? "Copied ✓ — paste it in Slack" : "📋 Copy for Slack"}
            </button>
          </div>

          {SECTIONS.map((s) => {
            const rows = results.filter((r) => r.status === s.key);
            if (!rows.length) return null;
            return (
              <div key={s.key} className="mt-5">
                <h2 className="text-sm font-bold text-[#1f3559] tracking-tight">
                  {s.emoji} {s.label} <span className="text-[#8595a8] font-semibold">— {rows.length}</span>
                </h2>
                <div className="mt-2 rounded-xl border border-[#e4ebf2] overflow-hidden">
                  {rows.map((r, i) => (
                    <div
                      key={`${r.query}-${i}`}
                      className="flex items-start gap-3 px-4 py-2.5 border-l-4"
                      style={{
                        background: i % 2 ? "#ffffff" : s.tint,
                        borderLeftColor: s.border,
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-[#1f3559]">{r.query}</div>
                        {(r.contactName || r.email) && (
                          <div className="text-xs text-[#8595a8] truncate">
                            {r.contactName}
                            {r.email ? ` · ${r.email}` : ""}
                          </div>
                        )}
                        {r.note && <div className="text-xs text-[#a3616b] mt-0.5">{r.note}</div>}
                        {r.alternates && r.alternates.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-xs text-[#697a91] cursor-pointer">
                              {r.alternates.length} other contact{r.alternates.length === 1 ? "" : "s"} with this name
                            </summary>
                            <ul className="mt-1 ml-3 list-disc text-xs text-[#8595a8]">
                              {r.alternates.map((a, k) => <li key={k}>{a}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {r.stage && <div className="text-xs font-medium text-[#34568a]">{r.stage}</div>}
                        {r.demoDate && <div className="text-[11px] text-[#a3adbb]">{r.demoDate}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
