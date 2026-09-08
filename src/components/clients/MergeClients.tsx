"use client";
import { useMemo, useState } from "react";
import { Loader2, GitMerge, X, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Merge two duplicate Clients Master rows. The admin picks a keeper and then,
// for every field the two rows disagree on, which value survives. The other
// row is marked VOID in the sheet (the row itself is kept, so a mistake can be
// undone by hand in Google Sheets).

type Row = Record<string, unknown>;

// Sheet bookkeeping the admin should never have to choose between.
const HIDDEN = new Set(["row_number", "_supabase_id", "_row_number"]);

const label = (k: string) => (k === "col_1" ? "Status" : k);
const show = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s === "" ? "—" : s;
};

export function MergeClients({ rows, onDone }: { rows: Row[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [aRow, setARow] = useState<number | null>(null);
  const [bRow, setBRow] = useState<number | null>(null);
  const [keep, setKeep] = useState<"a" | "b">("a");
  const [picks, setPicks] = useState<Record<string, "a" | "b">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const byRow = useMemo(() => {
    const m = new Map<number, Row>();
    for (const r of rows) {
      const n = Number(r.row_number ?? r._row_number);
      if (n) m.set(n, r);
    }
    return m;
  }, [rows]);

  // Owners appearing on more than one row — the whole point of the tool.
  const duplicates = useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const [n, r] of byRow) {
      const owner = String(r["Owner Full Name"] ?? "").trim().toLowerCase();
      if (!owner) continue;
      groups.set(owner, [...(groups.get(owner) ?? []), n]);
    }
    return [...groups.entries()]
      .filter(([, ns]) => ns.length > 1)
      .map(([owner, ns]) => ({ owner, rows: ns.sort((x, y) => x - y) }))
      .sort((x, y) => x.owner.localeCompare(y.owner));
  }, [byRow]);

  const a = aRow ? byRow.get(aRow) : null;
  const b = bRow ? byRow.get(bRow) : null;

  // Every field where the two rows disagree — those are the only decisions.
  const conflicts = useMemo(() => {
    if (!a || !b) return [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !HIDDEN.has(k)));
    return [...keys]
      .filter((k) => String(a[k] ?? "").trim() !== String(b[k] ?? "").trim())
      .sort();
  }, [a, b]);

  function choosePair(owner: string, ns: number[]) {
    setARow(ns[0]);
    setBRow(ns[1]);
    setKeep("a");
    setPicks({});
    setError(null);
    setDone(null);
    void owner;
  }

  async function merge() {
    if (!a || !b || !aRow || !bRow || busy) return;
    setBusy(true);
    setError(null);
    const keepRow = keep === "a" ? aRow : bRow;
    const dropRow = keep === "a" ? bRow : aRow;
    // Default for an untouched field is the keeper's own value.
    const values: Record<string, unknown> = {};
    for (const k of conflicts) {
      const from = picks[k] ?? keep;
      values[k] = (from === "a" ? a : b)[k] ?? "";
    }
    try {
      const r = await fetch("/api/clients/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepRow, dropRow, values }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Merge failed");
      setDone(`Merged into row ${keepRow}; row ${dropRow} marked VOID in the sheet.`);
      setARow(null);
      setBRow(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <GitMerge size={14} className="text-[#0e8f88] shrink-0" />
        <span className="text-sm font-bold text-[#1f3559]">Merge duplicate clients</span>
        {duplicates.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">
            {duplicates.length} with two rows
          </span>
        )}
        <span className="ml-auto text-[#8595a8] text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {done && (
            <p className="text-xs text-[#15803d] bg-[#e6f7ee] border border-[#c7edd4] rounded-lg px-2.5 py-1.5">{done}</p>
          )}
          {error && (
            <p className="text-xs text-[#e11d48] bg-[#fde8ee] border border-[#f5c2cf] rounded-lg px-2.5 py-1.5">{error}</p>
          )}

          {!a || !b ? (
            duplicates.length === 0 ? (
              <p className="text-xs text-[#8595a8]">No client appears twice right now.</p>
            ) : (
              <ul className="space-y-1">
                {duplicates.map((d) => (
                  <li key={d.owner}>
                    <button onClick={() => choosePair(d.owner, d.rows)}
                      className="w-full flex items-center gap-2 rounded-lg border border-[#e4ebf2] bg-[#fafcfe] px-2.5 py-1.5 text-left hover:border-[#15B7AE]">
                      <span className="text-[13px] font-semibold text-[#1f3559] capitalize">{d.owner}</span>
                      <span className="text-[11px] text-[#8595a8]">
                        rows {d.rows.join(" & ")} ·{" "}
                        {d.rows.map((n) => String(byRow.get(n)?.["Business Name"] ?? "—")).join(" / ")}
                      </span>
                      <span className="ml-auto text-[11px] font-semibold text-[#0e8f88]">Compare →</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[#697a91]">Keep which row?</span>
                {(["a", "b"] as const).map((side) => {
                  const row = side === "a" ? a : b;
                  const n = side === "a" ? aRow : bRow;
                  return (
                    <button key={side} onClick={() => setKeep(side)}
                      className={cn("px-2.5 py-1 rounded-lg text-xs font-semibold border",
                        keep === side ? "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]" : "bg-white text-[#34568a] border-[#d7e0ea]")}>
                      Row {n} · {show(row["Business Name"])}
                    </button>
                  );
                })}
                <button onClick={() => { setARow(null); setBRow(null); }}
                  className="ml-auto text-[#8595a8] hover:text-[#1f3559]" title="Pick a different pair"><X size={14} /></button>
              </div>

              {conflicts.length === 0 ? (
                <p className="text-xs text-[#697a91]">These rows hold identical data — merging just voids the spare.</p>
              ) : (
                <>
                  <p className="text-[11px] text-[#697a91]">
                    {conflicts.length} field{conflicts.length === 1 ? "" : "s"} differ. Click the value you want to keep;
                    anything you leave alone keeps the chosen row&apos;s value.
                  </p>
                  <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-[#eef3f8]">
                    {conflicts.map((k) => {
                      const picked = picks[k] ?? keep;
                      return (
                        <div key={k} className="grid grid-cols-[110px_1fr_1fr] gap-1.5 items-center px-2 py-1 border-b border-[#eef3f8] last:border-b-0">
                          <span className="text-[11px] font-semibold text-[#697a91] truncate" title={k}>{label(k)}</span>
                          {(["a", "b"] as const).map((side) => (
                            <button key={side} onClick={() => setPicks((p) => ({ ...p, [k]: side }))}
                              className={cn("text-left text-[12px] px-2 py-1 rounded border truncate",
                                picked === side
                                  ? "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] font-semibold"
                                  : "bg-white text-[#34568a] border-[#e4ebf2] hover:border-[#15B7AE]")}
                              title={show((side === "a" ? a : b)[k])}>
                              {show((side === "a" ? a : b)[k])}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={merge} disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#15B7AE] text-[#1f3559] disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Merge into row {keep === "a" ? aRow : bRow}
                </button>
                <span className="flex items-center gap-1 text-[11px] text-[#b45309]">
                  <AlertTriangle size={11} />
                  Row {keep === "a" ? bRow : aRow} gets marked VOID in the sheet.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
