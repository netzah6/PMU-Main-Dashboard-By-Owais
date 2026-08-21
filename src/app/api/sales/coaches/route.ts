import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";

// Coach Tracker: current Live/Paused/Offboarded per Client Success Coach from
// Clients Master, compared against the newest snapshot older than today
// (snapshots are taken automatically on the 20th of each month — the day these
// numbers are reviewed — plus the 2026-08-21 baseline). Churn is a real
// transition: a client who was Live in the previous snapshot and isn't now.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const sb = createServiceClient();

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

  const list = [...coaches.values()]
    .filter((c) => c.live + c.paused + c.prevLive > 0) // skip pure-offboarded history buckets
    .sort((a, b) => b.live - a.live);
  return NextResponse.json({ prevDate, coaches: list });
}
