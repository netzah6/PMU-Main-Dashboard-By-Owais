import type { SupabaseClient } from "@supabase/supabase-js";

/* Sales board — the numbers and the to-do lists for the appointment setter
   (discovery calls) and the closer (demo calls). Everything comes from the
   synced sales sheets (see SHEET_MAP: sales_*). The sheet is the source of
   truth; nothing here writes back. */

type Svc = SupabaseClient;
type Row = Record<string, string>;

export const WINDOWS = [14, 30, 60, 90] as const;
export type Win = (typeof WINDOWS)[number];

/* Targets the trackers print in their headers ("OVER 75% IDEAL" …). */
export const TARGETS = { discShowUp: 75, bookRate: 70, demoShowUp: 80, closeRate: 30 };

const DAY = 86400_000;

/* Sheet dates come in three shapes: "15/09/2026 13:08" (day first),
   "Thursday, September 17, 2026 16:30" (spelled out) and "9/17/2026"
   (US, only in the helper columns). The spelled-out form is unambiguous;
   the slash forms are day-first everywhere except where noted. */
export function parseSheetDate(v: unknown, usOrder = false): Date | null {
  const s = String(v ?? "").trim();
  if (!s || s === "-" || s.toLowerCase() === "false") return null;
  if (/^[A-Za-z]+,/.test(s)) { const d = new Date(s.replace(/(\d{1,2}:\d{2})$/, "$1:00")); return isNaN(d.getTime()) ? null : d; }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    const [dd, mm] = usOrder ? [b, a] : [a, b];
    const d = new Date(y, mm - 1, dd, m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * DAY); // serial
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };

export type Discovery = {
  signUp: Date | null; name: string; status: string; setter: string;
  discoveryAt: Date | null; notes: string; area: string; revenue: string; years: string; adSet: string;
};
export type Demo = {
  date: Date | null; name: string; status: string; closer: string;
  demoAt: Date | null; closeDate: Date | null; upfront: number; revenue: string; years: string;
};
export type FollowUp = { name: string; who: string; when: Date | null; f1: string; f2: string; f3: string; notes: string };

function discovery(d: Row): Discovery {
  return {
    signUp: parseSheetDate(d["Date Sign Up"]), name: String(d["Full Name"] ?? "").trim(),
    // The sheet's header for the status column is literally "Didn't Schedule Demo".
    status: String(d["Didn't Schedule Demo"] ?? d["Status"] ?? "").trim(), setter: String(d["Assigned Person"] ?? "").trim(),
    discoveryAt: parseSheetDate(d["Discovery Date"]) ?? parseSheetDate(d["Discovery Date_2"], true),
    notes: /^(false|true)$/i.test(String(d["Notes Discoveries"] ?? "")) ? "" : String(d["Notes Discoveries"] ?? "").trim(),
    area: String(d["Area"] ?? "").trim(), revenue: String(d["Current Revenue"] ?? "").trim(),
    years: String(d["Years in business"] ?? "").trim(), adSet: String(d[" UTM Ad Set"] ?? d["UTM Ad Set"] ?? "").trim(),
  };
}
function demo(d: Row): Demo {
  return {
    date: parseSheetDate(d["Date"]), name: String(d["Full Name"] ?? "").trim(), status: String(d["Status"] ?? "").trim(),
    closer: String(d["Assigned Person"] ?? "").trim(),
    demoAt: parseSheetDate(d["Demo Date"]) ?? parseSheetDate(d["Demo Date_2"], true),
    closeDate: parseSheetDate(d["Close Date"]), upfront: money(d["Upfront Collected"]),
    revenue: String(d["Current Revenue"] ?? "").trim(), years: String(d["Years in business"] ?? "").trim(),
  };
}
function followUp(d: Row): FollowUp {
  return {
    name: String(d["Full Name"] ?? "").trim(), who: String(d["Assigned User"] ?? "").trim(),
    when: parseSheetDate(d["Appointment Time"]) ?? parseSheetDate(d["Date Sign Up"]),
    f1: String(d["Follow up 1"] ?? "").trim(), f2: String(d["Follow up 2"] ?? "").trim(), f3: String(d["Follow up 3"] ?? "").trim(),
    notes: String(d["Appointment Setter Notes"] ?? "").trim(),
  };
}

async function loadAll(svc: Svc, table: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from(table).select("data").order("sheet_row").range(from, from + 999);
    const rows = (data ?? []).map((r) => r.data as Row);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.filter((r) => String(r["Full Name"] ?? "").trim() !== "");
}

// ── Stats ────────────────────────────────────────────────────────────────────
const isNoShow = (s: string) => /no-?show/i.test(s);
const isCancelled = (s: string) => /cancel/i.test(s);
const isDisq = (s: string) => /disqualif/i.test(s);
const isDemoScheduled = (s: string) => /demo scheduled/i.test(s);
const isClosed = (s: string) => /^closed|deposit collected/i.test(s);
const isDidntClose = (s: string) => /didn'?t close/i.test(s);

export type SetterStats = {
  total: number; noShow: number; cancelled: number; demoScheduled: number; didntBook: number; disqualified: number; noStatus: number;
  showUp: number | null; bookRate: number | null; bookRateExDisq: number | null; demoShowUp: number | null;
};
export type CloserStats = {
  total: number; closed: number; didntClose: number; noShow: number; cancelled: number; noStatus: number;
  showUp: number | null; closeRate: number | null; upfront: number;
};

function setterStats(list: Discovery[], demosByName: Map<string, Demo[]>): SetterStats {
  const total = list.length;
  const noShow = list.filter((d) => isNoShow(d.status)).length;
  const cancelled = list.filter((d) => isCancelled(d.status)).length;
  const demoScheduled = list.filter((d) => isDemoScheduled(d.status)).length;
  const disqualified = list.filter((d) => isDisq(d.status)).length;
  const didntBook = list.filter((d) => /didn'?t schedule/i.test(d.status) && !isDisq(d.status)).length;
  const noStatus = list.filter((d) => !d.status).length;
  const shown = total - noShow - cancelled;
  // Did the demos this setter booked actually happen? Match by name.
  let demosHeld = 0, demosDecided = 0;
  for (const d of list) {
    if (!isDemoScheduled(d.status)) continue;
    const ds = demosByName.get(norm(d.name)) ?? [];
    const latest = ds[ds.length - 1];
    if (!latest || !latest.status) continue;
    demosDecided++;
    if (!isNoShow(latest.status) && !isCancelled(latest.status)) demosHeld++;
  }
  return {
    total, noShow, cancelled, demoScheduled, didntBook, disqualified, noStatus,
    // Book rate the way the tracker sheet defines it: demos booked / all discoveries.
    showUp: pct(shown, total), bookRate: pct(demoScheduled, total), bookRateExDisq: pct(demoScheduled, total - disqualified),
    demoShowUp: pct(demosHeld, demosDecided),
  };
}
function closerStats(list: Demo[]): CloserStats {
  const total = list.length;
  const closed = list.filter((d) => isClosed(d.status)).length;
  const didntClose = list.filter((d) => isDidntClose(d.status)).length;
  const noShow = list.filter((d) => isNoShow(d.status)).length;
  const cancelled = list.filter((d) => isCancelled(d.status)).length;
  const noStatus = list.filter((d) => !d.status).length;
  const shown = total - noShow - cancelled;
  return { total, closed, didntClose, noShow, cancelled, noStatus, showUp: pct(shown, total), closeRate: pct(closed, shown), upfront: list.reduce((t, d) => t + d.upfront, 0) };
}

// ── To-do lists ──────────────────────────────────────────────────────────────
export type Todo = {
  name: string; who: string; kind: "no_show" | "cancelled" | "didnt_book" | "no_status" | "demo_no_show" | "didnt_close" | "upcoming";
  when: string | null; ageDays: number; followUps: number; lastFollowUp: string; notes: string; status: string;
  urgent: boolean; // nothing logged yet, or stale
};

function fuIndex(rows: FollowUp[]): Map<string, FollowUp> {
  const m = new Map<string, FollowUp>();
  for (const r of rows) if (r.name) m.set(norm(r.name), r); // newest wins (sheet lists newest last in the left table)
  return m;
}
function todo(kind: Todo["kind"], name: string, who: string, when: Date | null, status: string, fu: FollowUp | undefined, now: number, notes = ""): Todo {
  const fus = fu ? [fu.f1, fu.f2, fu.f3].filter(Boolean) : [];
  const ageDays = when ? Math.floor((now - when.getTime()) / DAY) : 0;
  return {
    name, who, kind, when: when ? when.toISOString() : null, ageDays, status,
    followUps: fus.length, lastFollowUp: fus[fus.length - 1] ?? "", notes: notes || fu?.notes || "",
    urgent: kind === "upcoming" ? false : fus.length === 0 || (fus.length < 3 && ageDays >= 2),
  };
}

export type SalesBoard = {
  generatedAt: string;
  setters: string[]; closers: string[];
  setterStats: Record<string, Record<Win, SetterStats>>;
  closerStats: Record<string, Record<Win, CloserStats>>;
  setterTodos: Todo[]; closerTodos: Todo[];
};

export async function buildSalesBoard(svc: Svc): Promise<SalesBoard> {
  const [dRows, mRows, fuNoShow, fuCancelled, fuDidntBook, fuDemoNoShow] = await Promise.all([
    loadAll(svc, "sales_discoveries"), loadAll(svc, "sales_demos"),
    loadAll(svc, "sales_fu_disc_noshow"), loadAll(svc, "sales_fu_disc_cancelled"), loadAll(svc, "sales_fu_didnt_book"), loadAll(svc, "sales_fu_demo_noshow"),
  ]);
  const now = Date.now();
  const discs = dRows.map(discovery).filter((d) => d.name && !/test/i.test(d.name));
  const demos = mRows.map(demo).filter((d) => d.name && !/test/i.test(d.name));
  const demosByName = new Map<string, Demo[]>();
  for (const d of demos) { const k = norm(d.name); demosByName.set(k, [...(demosByName.get(k) ?? []), d]); }

  // People = whoever has activity in the last 90 days (old reps drop off by themselves).
  const recent = (t: Date | null) => !!t && now - t.getTime() <= 90 * DAY;
  const setters = [...new Set(discs.filter((d) => recent(d.signUp) && d.setter).map((d) => d.setter))].sort();
  const closers = [...new Set(demos.filter((d) => recent(d.date) && d.closer).map((d) => d.closer))].sort();

  const inWin = (t: Date | null, w: Win) => !!t && now - t.getTime() <= w * DAY && t.getTime() <= now + DAY;
  const setterStatsOut: SalesBoard["setterStats"] = {};
  for (const p of [...setters, "ALL"]) {
    const mine = p === "ALL" ? discs : discs.filter((d) => d.setter === p);
    setterStatsOut[p] = Object.fromEntries(WINDOWS.map((w) => [w, setterStats(mine.filter((d) => inWin(d.signUp, w)), demosByName)])) as Record<Win, SetterStats>;
  }
  // Closer windows go by the DEMO date (the sheet's "Date" is the lead's
  // sign-up date, which can be weeks earlier); a close counts in the window
  // its close date falls in.
  const closerStatsOut: SalesBoard["closerStats"] = {};
  for (const p of [...closers, "ALL"]) {
    const mine = p === "ALL" ? demos : demos.filter((d) => d.closer === p);
    closerStatsOut[p] = Object.fromEntries(WINDOWS.map((w) => [w, closerStats(mine.filter((d) => inWin(d.demoAt ?? d.date, w) || (isClosed(d.status) && inWin(d.closeDate, w))))])) as Record<Win, CloserStats>;
  }

  // Setter to-dos: last 30 days of sign-ups that need a hand.
  const fuNS = fuIndex(fuNoShow.map(followUp)), fuCA = fuIndex(fuCancelled.map(followUp)), fuDB = fuIndex(fuDidntBook.map(followUp));
  const setterTodos: Todo[] = [];
  for (const d of discs) {
    if (!inWin(d.signUp, 30)) continue;
    const k = norm(d.name);
    if (isNoShow(d.status)) setterTodos.push(todo("no_show", d.name, d.setter, d.discoveryAt ?? d.signUp, d.status, fuNS.get(k), now, d.notes));
    else if (isCancelled(d.status)) setterTodos.push(todo("cancelled", d.name, d.setter, d.discoveryAt ?? d.signUp, d.status, fuCA.get(k), now, d.notes));
    else if (/didn'?t schedule/i.test(d.status) && !isDisq(d.status)) setterTodos.push(todo("didnt_book", d.name, d.setter, d.signUp, d.status, fuDB.get(k), now, d.notes));
    else if (!d.status && d.discoveryAt && d.discoveryAt.getTime() < now - 2 * 3600_000) {
      const t = todo("no_status", d.name, d.setter, d.discoveryAt, "", undefined, now, d.notes); t.urgent = true; setterTodos.push(t);
    }
  }
  // Closer to-dos.
  const fuDN = fuIndex(fuDemoNoShow.map(followUp));
  const closerTodos: Todo[] = [];
  for (const d of demos) {
    if (!inWin(d.date, 30) && !(d.demoAt && d.demoAt.getTime() > now)) continue;
    const k = norm(d.name);
    if (isNoShow(d.status)) closerTodos.push(todo("demo_no_show", d.name, d.closer, d.demoAt ?? d.date, d.status, fuDN.get(k), now));
    else if (isDidntClose(d.status)) { const t = todo("didnt_close", d.name, d.closer, d.demoAt ?? d.date, d.status, undefined, now); t.urgent = t.ageDays >= 1; closerTodos.push(t); }
    else if (!d.status && d.demoAt && d.demoAt.getTime() > now - 2 * 3600_000 && d.demoAt.getTime() < now + 7 * DAY) closerTodos.push(todo("upcoming", d.name, d.closer, d.demoAt, "", undefined, now));
    else if (!d.status && d.demoAt && d.demoAt.getTime() <= now - 2 * 3600_000) { const t = todo("no_status", d.name, d.closer, d.demoAt, "", undefined, now); t.urgent = true; closerTodos.push(t); }
  }
  const byUrgency = (a: Todo, b: Todo) => Number(b.urgent) - Number(a.urgent) || (b.when ?? "").localeCompare(a.when ?? "");
  setterTodos.sort(byUrgency); closerTodos.sort(byUrgency);

  return { generatedAt: new Date().toISOString(), setters, closers, setterStats: setterStatsOut, closerStats: closerStatsOut, setterTodos, closerTodos };
}
