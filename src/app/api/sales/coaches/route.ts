import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/onebox-insights";

// Coach Tracker: current Live/Paused/Offboarded per Client Success Coach from
// Clients Master, compared against the newest snapshot older than today
// (snapshots are taken automatically on the 20th of each month — the day these
// numbers are reviewed — plus the 2026-08-21 baseline). Churn is a real
// transition: a client who was Live in the previous snapshot and isn't now.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const sb = createServiceClient();

  /* Drill-down: ?coach=X&date=YYYY-MM-DD (a snapshot date) or date=current.
     Returns that coach's clients with status then, plus what changed vs the
     previous snapshot — so every count is auditable client by client. */
  const qCoach = req.nextUrl.searchParams.get("coach");
  if (qCoach) {
    const qDate = req.nextUrl.searchParams.get("date") || "current";
    const { data: dateRows } = await sb.from("coach_snapshots").select("taken_at").order("taken_at");
    const dates = [...new Set((dateRows ?? []).map((r) => r.taken_at as string))].sort().reverse();
    type CRow = { owner: string; biz: string; status: string };
    const key = (r: CRow) => `${r.owner.toLowerCase()}|${r.biz.toLowerCase()}`;
    const snapAt = async (d: string): Promise<CRow[]> =>
      (await fetchAllRows((from, to) =>
        sb.from("coach_snapshots").select("coach, owner_name, business_name, status")
          .eq("taken_at", d).eq("coach", qCoach).order("owner_name").range(from, to)))
        .map((r) => ({ owner: String(r.owner_name ?? ""), biz: String(r.business_name ?? ""), status: String(r.status ?? "").toLowerCase() }));
    let cur: CRow[];
    let prevD: string | null;
    if (qDate === "current") {
      const { data: cm } = await sb.from("clients_master").select("data");
      cur = (cm ?? []).map((r) => {
        const d = (r.data ?? {}) as Record<string, string>;
        return { owner: String(d["Owner Full Name"] ?? "").trim(), biz: String(d["Business Name"] ?? "").trim(), status: String(d["col_1"] ?? "").trim().toLowerCase(), coach: String(d["Assigned"] ?? "").trim() || "(unassigned)" };
      }).filter((r) => (r as CRow & { coach: string }).coach === qCoach && r.owner && r.status);
      prevD = dates[0] ?? null;
    } else {
      cur = await snapAt(qDate);
      prevD = dates.find((d) => d < qDate) ?? null;
    }
    const prev = prevD ? await snapAt(prevD) : [];
    const prevBy = new Map(prev.map((r) => [key(r), r.status]));
    const clientsOut = cur
      .map((r) => ({ owner: r.owner, biz: r.biz, status: r.status, prevStatus: prevBy.get(key(r)) ?? null }))
      .sort((a, b) => (a.status === b.status ? a.owner.localeCompare(b.owner) : a.status.localeCompare(b.status)));
    /* clients the coach HAD at the previous snapshot but no longer has at
       this one (reassigned away or removed) — they explain drops too */
    const curKeys = new Set(cur.map(key));
    const gone = prev.filter((r) => !curKeys.has(key(r))).map((r) => ({ owner: r.owner, biz: r.biz, was: r.status }));
    return NextResponse.json({ coach: qCoach, date: qDate, prevDate: prevD, dates, clients: clientsOut, gone });
  }

  const { data: clients } = await sb.from("clients_master").select("data");
  type Row = { coach: string; owner: string; biz: string; status: string };
  const now: Row[] = (clients ?? [])
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, string>;
      const status = String(d["col_1"] ?? "").trim().toLowerCase();
      return {
        coach: String(d["Assigned"] ?? "").trim() || "(unassigned)",
        owner: String(d["Owner Full Name"] ?? "").trim(),
        biz: String(d["Business Name"] ?? "").trim(),
        status,
      };
    })
    .filter((r) => r.owner && r.status);

  const { data: dates } = await sb
    .from("coach_snapshots")
    .select("taken_at")
    .lt("taken_at", new Date().toISOString().slice(0, 10))
    .order("taken_at", { ascending: false })
    .limit(1);
  const prevDate: string | null = dates?.[0]?.taken_at ?? null;

  let prev: Row[] = [];
  if (prevDate) {
    const { data: snap } = await sb
      .from("coach_snapshots")
      .select("coach, owner_name, business_name, status")
      .eq("taken_at", prevDate);
    prev = (snap ?? []).map((r) => ({
      coach: r.coach || "(unassigned)",
      owner: r.owner_name,
      biz: r.business_name,
      status: String(r.status ?? "").toLowerCase(),
    }));
  }

  const key = (r: Row) => `${r.owner.toLowerCase()}|${r.biz.toLowerCase()}`;
  const nowByKey = new Map(now.map((r) => [key(r), r]));
  const prevByKey = new Map(prev.map((r) => [key(r), r]));

  const coaches = new Map<string, {
    coach: string;
    live: number; paused: number; offboarded: number;
    prevLive: number; prevPaused: number; prevOffboarded: number;
    churned: { name: string; to: string }[];   // was Live then, not Live now
    newLive: string[];                          // Live now, wasn't Live then
  }>();
  const bucket = (c: string) => {
    if (!coaches.has(c)) coaches.set(c, { coach: c, live: 0, paused: 0, offboarded: 0, prevLive: 0, prevPaused: 0, prevOffboarded: 0, churned: [], newLive: [] });
    return coaches.get(c)!;
  };

  for (const r of now) {
    const b = bucket(r.coach);
    if (r.status === "live") b.live++;
    else if (r.status === "paused") b.paused++;
    else if (r.status === "offboarded") b.offboarded++;
  }
  for (const r of prev) {
    const b = bucket(r.coach);
    if (r.status === "live") b.prevLive++;
    else if (r.status === "paused") b.prevPaused++;
    else if (r.status === "offboarded") b.prevOffboarded++;
  }
  // transitions, attributed to the coach who held the client in the previous snapshot
  for (const r of prev) {
    if (r.status !== "live") continue;
    const cur = nowByKey.get(key(r));
    if (!cur || cur.status !== "live") {
      bucket(r.coach).churned.push({ name: r.owner || r.biz, to: cur ? cur.status : "removed" });
    }
  }
  for (const r of now) {
    if (r.status !== "live") continue;
    const was = prevByKey.get(key(r));
    if (prevDate && (!was || was.status !== "live")) bucket(r.coach).newLive.push(r.owner || r.biz);
  }

  /* Salary breakdown: live-client count per coach at EVERY snapshot (the
     20th of each month + the baseline) — the payroll cutoff Netzah pays
     against ($400 base + $30/client, computed client-side). */
  /* Paginated: coach_snapshots is already past PostgREST's silent 1,000-row
     cap (1,283 rows on 2026-09-21) — the unpaginated first version of this
     fetch truncated the history and misreported salaries (Dana showed 11 of
     her real 27; the same trap as the onebox_hits undercount of Sep 12). */
  const hist = await fetchAllRows((from, to) =>
    sb.from("coach_snapshots").select("taken_at, coach, status").order("taken_at").order("owner_name").range(from, to));
  const histMap = new Map<string, Map<string, number>>();
  for (const r of hist ?? []) {
    if (String(r.status ?? "").toLowerCase() !== "live") continue;
    const c = (r.coach || "(unassigned)").trim() || "(unassigned)";
    if (!histMap.has(c)) histMap.set(c, new Map());
    const m = histMap.get(c)!;
    m.set(r.taken_at as string, (m.get(r.taken_at as string) ?? 0) + 1);
  }
  const list = [...coaches.values()]
    .filter((c) => c.live + c.paused + c.prevLive > 0) // skip pure-offboarded history buckets
    .sort((a, b) => b.live - a.live)
    .map((c) => ({
      ...c,
      history: [...(histMap.get(c.coach) ?? new Map<string, number>()).entries()]
        .map(([date, liveCount]) => ({ date, live: liveCount }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    }));
  const { data: hiddenRows } = await sb.from("coach_tracker_hidden").select("coach");
  const hidden = (hiddenRows ?? []).map((r) => r.coach as string);
  return NextResponse.json({ prevDate, coaches: list, hidden });
}

/* Hide a former coach (or the owner) from the tracker, reversibly — the
   snapshots keep their history, and "(unassigned)" can never be hidden
   (it is the missed-contacts safety net). */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; coach?: string };
  const coach = String(body.coach ?? "").trim();
  if (!coach || coach === "(unassigned)") return NextResponse.json({ error: "bad coach" }, { status: 400 });
  const sb = createServiceClient();
  if (body.action === "hide") {
    await sb.from("coach_tracker_hidden").upsert({ coach, hidden_by: auth.email ?? "admin" });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "unhide") {
    await sb.from("coach_tracker_hidden").delete().eq("coach", coach);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
