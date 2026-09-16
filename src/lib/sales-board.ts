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
/* Less than this share of the last 90 days' rows = not a real seat (see buildSalesBoard). */
const MIN_ACTIVE_SHARE = 0.05;
/* A close counts on its close date only if the demo (or sign-up) was within
   this long before it; an old row getting a new close date is a renewal of
   an existing client, not a sale. */
const MAX_CLOSE_LAG = 180 * DAY;
export const FORMER = "Former reps";

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
/* "Closed" on a reused row can be the OLD sale: Kim O'kelly, closed
   26/1/2023, demo again 11/9/2026 with the 2023 close date still in the
   cell. A close date well before the demo means the status is stale. */
const isWon = (d: Demo) => isClosed(d.status) && !(d.closeDate && d.demoAt && d.closeDate.getTime() < d.demoAt.getTime() - 30 * DAY);
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
  const closed = list.filter(isWon).length;
  const didntClose = list.filter((d) => isDidntClose(d.status)).length;
  const noShow = list.filter((d) => isNoShow(d.status)).length;
  const cancelled = list.filter((d) => isCancelled(d.status)).length;
  const noStatus = list.filter((d) => !d.status).length;
  const shown = total - noShow - cancelled;
  return { total, closed, didntClose, noShow, cancelled, noStatus, showUp: pct(shown, total), closeRate: pct(closed, shown), upfront: list.reduce((t, d) => t + (isWon(d) ? d.upfront : 0), 0) };
}

// ── To-do lists ──────────────────────────────────────────────────────────────
export type Todo = {
  name: string; who: string; sheetWho: string; kind: "no_show" | "cancelled" | "didnt_book" | "no_status" | "demo_no_show" | "didnt_close" | "upcoming" | "closed" | "booked";
  amount?: number; // closed: upfront collected
  /* booked (setter side): what happened to the demo this setter booked,
     from the demos sheet — so the setter sees a no-show and chases it. */
  demo?: { when: string | null; outcome: "showed" | "no_show" | "cancelled" | "upcoming" | "pending" | "missing" };
  when: string | null; ageDays: number; followUps: number; lastFollowUp: string; notes: string; status: string;
  urgent: boolean; // nothing logged yet, or stale
};

function fuIndex(rows: FollowUp[]): Map<string, FollowUp> {
  const m = new Map<string, FollowUp>();
  for (const r of rows) if (r.name) m.set(norm(r.name), r); // newest wins (sheet lists newest last in the left table)
  return m;
}
function todo(kind: Todo["kind"], name: string, who: string, when: Date | null, status: string, fu: FollowUp | undefined, now: number, notes = "", sheetWho = who): Todo {
  const fus = fu ? [fu.f1, fu.f2, fu.f3].filter(Boolean) : [];
  const ageDays = when ? Math.floor((now - when.getTime()) / DAY) : 0;
  return {
    name, who, sheetWho, kind, when: when ? when.toISOString() : null, ageDays, status,
    followUps: fus.length, lastFollowUp: fus[fus.length - 1] ?? "", notes: notes || fu?.notes || "",
    urgent: kind === "upcoming" || kind === "closed" || kind === "booked" ? false : fus.length === 0 || (fus.length < 3 && ageDays >= 2),
  };
}

export type SalesBoard = {
  generatedAt: string;
  setters: string[]; closers: string[];
  /* Names the sheet still uses on a few recent rows that aren't a real seat
     any more (row reused for a returning lead) → count in the last 90 days. */
  formerSetters: Record<string, number>; formerClosers: Record<string, number>;
  setterStats: Record<string, Record<Win, SetterStats>>;
  closerStats: Record<string, Record<Win, CloserStats>>;
  setterTodos: Todo[]; closerTodos: Todo[];
};

/* Won demos (for the closer payment tracker): every Closed row with a
   usable close date, newest first. */
export async function loadClosedDeals(svc: Svc): Promise<Demo[]> {
  const rows = await loadAll(svc, "sales_demos");
  const now = Date.now();
  // Same renewal guard as the KPIs: a close date far after the demo is an
  // existing client re-billed on their old row, not a closer's win.
  const fresh = (d: Demo) => { const base = d.demoAt ?? d.date; const c = d.closeDate; return !c || !base || (c.getTime() - base.getTime() <= MAX_CLOSE_LAG && c.getTime() <= now + DAY); };
  return rows.map(demo).filter((d) => d.name && !/test/i.test(d.name) && isWon(d) && fresh(d) && (d.closeDate ?? d.demoAt ?? d.date))
    .sort((a, b) => (b.closeDate ?? b.demoAt ?? b.date)!.getTime() - (a.closeDate ?? a.demoAt ?? a.date)!.getTime());
}

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

  // People = whoever has real activity in the last 90 days. The sheet's
  // "Assigned Person" is stale on a few rows — a returning lead gets written
  // into their OLD row, which still names the setter from years ago (Diego,
  // Edgar, George… all Jennifer's in GHL). Anyone under MIN_ACTIVE_SHARE of the rows is
  // therefore not a seat of their own; their rows are pooled under FORMER so
  // the leads still show up in "Everyone" and the to-do lists.
  const recent = (t: Date | null) => !!t && now - t.getTime() <= 90 * DAY;
  const tally = (names: string[]) => names.reduce<Record<string, number>>((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {});
  const dTally = tally(discs.filter((d) => recent(d.signUp) && d.setter).map((d) => d.setter));
  const mTally = tally(demos.filter((d) => recent(d.date) && d.closer).map((d) => d.closer));
  const minOf = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0) * MIN_ACTIVE_SHARE;
  const setters = Object.keys(dTally).filter((n) => dTally[n] >= minOf(dTally)).sort();
  const closers = Object.keys(mTally).filter((n) => mTally[n] >= minOf(mTally)).sort();
  const formerSetters = Object.fromEntries(Object.entries(dTally).filter(([n]) => !setters.includes(n)));
  const formerClosers = Object.fromEntries(Object.entries(mTally).filter(([n]) => !closers.includes(n)));
  const setterOf = (d: Discovery) => (setters.includes(d.setter) ? d.setter : FORMER);
  const closerOf = (d: Demo) => (closers.includes(d.closer) ? d.closer : FORMER);
  const seatSetters = Object.keys(formerSetters).length ? [...setters, FORMER] : setters;
  const seatClosers = Object.keys(formerClosers).length ? [...closers, FORMER] : closers;

  const inWin = (t: Date | null, w: Win) => !!t && now - t.getTime() <= w * DAY && t.getTime() <= now + DAY;
  const setterStatsOut: SalesBoard["setterStats"] = {};
  for (const p of [...seatSetters, "ALL"]) {
    const mine = p === "ALL" ? discs : discs.filter((d) => setterOf(d) === p);
    setterStatsOut[p] = Object.fromEntries(WINDOWS.map((w) => [w, setterStats(mine.filter((d) => inWin(d.signUp, w)), demosByName)])) as Record<Win, SetterStats>;
  }
  // Closer windows go by the DEMO date (the sheet's "Date" is the lead's
  // sign-up date, which can be weeks earlier); a close counts in the window
  // its close date falls in.
  const closerStatsOut: SalesBoard["closerStats"] = {};
  for (const p of [...seatClosers, "ALL"]) {
    const mine = p === "ALL" ? demos : demos.filter((d) => closerOf(d) === p);
    closerStatsOut[p] = Object.fromEntries(WINDOWS.map((w) => [w, closerStats(mine.filter((d) => inWin(d.demoAt ?? d.date, w) || (isWon(d) && inWin(d.closeDate, w) && !!(d.demoAt ?? d.date) && d.closeDate!.getTime() - (d.demoAt ?? d.date)!.getTime() <= MAX_CLOSE_LAG)))])) as Record<Win, CloserStats>;
  }

  // Lists cover the longest window (90 d); the page narrows them to the
  // selected 14/30/60/90 by each item's own date (ageDays).
  const fuNS = fuIndex(fuNoShow.map(followUp)), fuCA = fuIndex(fuCancelled.map(followUp)), fuDB = fuIndex(fuDidntBook.map(followUp));
  const fuDN = fuIndex(fuDemoNoShow.map(followUp));
  const setterTodos: Todo[] = [];
  for (const d of discs) {
    if (!inWin(d.signUp, 90)) continue;
    const k = norm(d.name);
    if (isDemoScheduled(d.status)) {
      const t = todo("booked", d.name, setterOf(d), d.discoveryAt ?? d.signUp, d.status, fuDN.get(k), now, d.notes, d.setter);
      const ds = demosByName.get(k) ?? [];
      const m = ds[ds.length - 1]; // newest demo row for this name
      const when = m?.demoAt ?? m?.date ?? null;
      // The setter only needs showed / didn't show — closed or not is the closer's business.
      const outcome: NonNullable<Todo["demo"]>["outcome"] = !m ? "missing"
        : isNoShow(m.status) ? "no_show" : isCancelled(m.status) ? "cancelled"
        : m.status ? "showed" : when && when.getTime() > now - 2 * 3600_000 ? "upcoming" : "pending";
      t.demo = { when: when ? when.toISOString() : null, outcome };
      // A demo no-show is the setter's to chase — same follow-up rule as the other lists.
      if (outcome === "no_show") { const age = when ? Math.floor((now - when.getTime()) / DAY) : 0; t.urgent = t.followUps === 0 || (t.followUps < 3 && age >= 2); }
      setterTodos.push(t);
    }
    else if (isNoShow(d.status)) setterTodos.push(todo("no_show", d.name, setterOf(d), d.discoveryAt ?? d.signUp, d.status, fuNS.get(k), now, d.notes, d.setter));
    else if (isCancelled(d.status)) setterTodos.push(todo("cancelled", d.name, setterOf(d), d.discoveryAt ?? d.signUp, d.status, fuCA.get(k), now, d.notes, d.setter));
    else if (/didn'?t schedule/i.test(d.status) && !isDisq(d.status)) setterTodos.push(todo("didnt_book", d.name, setterOf(d), d.signUp, d.status, fuDB.get(k), now, d.notes, d.setter));
    else if (!d.status && d.discoveryAt && d.discoveryAt.getTime() < now - 2 * 3600_000) {
      const t = todo("no_status", d.name, setterOf(d), d.discoveryAt, "", undefined, now, d.notes, d.setter); t.urgent = true; setterTodos.push(t);
    }
  }
  // Closer to-dos.
  const closerTodos: Todo[] = [];
  for (const d of demos) {
    const closedRecently = isWon(d) && inWin(d.closeDate, 90) && !!(d.demoAt ?? d.date) && d.closeDate!.getTime() - (d.demoAt ?? d.date)!.getTime() <= MAX_CLOSE_LAG;
    if (!inWin(d.demoAt ?? d.date, 90) && !(d.demoAt && d.demoAt.getTime() > now) && !closedRecently) continue;
    const k = norm(d.name);
    if (isWon(d)) { const t = todo("closed", d.name, closerOf(d), d.closeDate ?? d.demoAt ?? d.date, d.status, undefined, now, "", d.closer); t.amount = d.upfront; closerTodos.push(t); }
    else if (isClosed(d.status)) { const t = todo("no_status", d.name, closerOf(d), d.demoAt, "", undefined, now, `sheet says Closed on ${d.closeDate!.toLocaleDateString()} — that's the old sale, update the row`, d.closer); t.urgent = true; closerTodos.push(t); }
    else if (isNoShow(d.status)) closerTodos.push(todo("demo_no_show", d.name, closerOf(d), d.demoAt ?? d.date, d.status, fuDN.get(k), now, "", d.closer));
    else if (isDidntClose(d.status)) { const t = todo("didnt_close", d.name, closerOf(d), d.demoAt ?? d.date, d.status, undefined, now, "", d.closer); t.urgent = t.ageDays >= 1; closerTodos.push(t); }
    else if (!d.status && d.demoAt && d.demoAt.getTime() > now - 2 * 3600_000 && d.demoAt.getTime() < now + 7 * DAY) closerTodos.push(todo("upcoming", d.name, closerOf(d), d.demoAt, "", undefined, now, "", d.closer));
    else if (!d.status && d.demoAt && d.demoAt.getTime() <= now - 2 * 3600_000) { const t = todo("no_status", d.name, closerOf(d), d.demoAt, "", undefined, now, "", d.closer); t.urgent = true; closerTodos.push(t); }
  }
  const byUrgency = (a: Todo, b: Todo) => Number(b.urgent) - Number(a.urgent) || (b.when ?? "").localeCompare(a.when ?? "");
  setterTodos.sort(byUrgency); closerTodos.sort(byUrgency);

  return { generatedAt: new Date().toISOString(), setters: seatSetters, closers: seatClosers, formerSetters, formerClosers, setterStats: setterStatsOut, closerStats: closerStatsOut, setterTodos, closerTodos };
}
