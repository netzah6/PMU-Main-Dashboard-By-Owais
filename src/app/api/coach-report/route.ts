import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";

export const fetchCache = "force-no-store";

/* Coach Report — the monthly "Managed Accounts Accountability Report" the
   coaches used to file through a GHL form, submitted from the dashboard
   instead. The coach classifies every client in THEIR book (Clients Master
   "Assigned"); the server compares the answers against the dashboard's own
   status per client and stores the result; the admin reviews every
   submission (per-client answers, referrals, mismatches, pay line) on the
   Coach Report tab itself. Owner 2026-10-21: it used to also land as a
   "coach_tracker" card on the Alerts tab, which drowned that tab — no more. */

type Reported = "active" | "paused_resuming" | "churned";
const REPORTED_LABEL: Record<Reported, string> = {
  active: "Active ✅",
  paused_resuming: "Paused — resuming ≤14d ⏳",
  churned: "Paused — no resume date 😡",
};

const keyOf = (owner: string, biz: string) => `${owner.trim().toLowerCase()}|${biz.trim().toLowerCase()}`;

/* A referral = a NEW PMU artist brought in by a client the coach already
   manages. Each one is a $100 bonus on top of salary, so they are claimed on
   the same monthly report and land on the same alert for the admin to approve. */
const REFERRAL_BONUS = 100;
type Referral = { referred_name: string; referred_by: string; note: string };

type RosterRow = { owner: string; biz: string; status: string };

/* The coach's book straight from Clients Master: live + paused clients whose
   "Assigned" matches. Offboarded clients are not theirs to report. */
async function rosterFor(svc: ReturnType<typeof createServiceClient>, coach: string): Promise<RosterRow[]> {
  const norm = (v: string) => v.replace(/[^a-z]/gi, "").toLowerCase();
  const { data } = await svc.from("clients_master").select("data");
  return (data ?? [])
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, string>;
      return {
        owner: String(d["Owner Full Name"] ?? "").trim(),
        biz: String(d["Business Name"] ?? "").trim(),
        status: String(d["col_1"] ?? "").trim().toLowerCase(),
        coach: String(d["Assigned"] ?? "").trim(),
      };
    })
    .filter((r) => r.owner && (r.status === "live" || r.status === "paused") && norm(r.coach) === norm(coach))
    .map(({ owner, biz, status }) => ({ owner, biz, status }))
    /* A duplicated sheet row (same owner + business twice, e.g. the Jessica
       Phillips pair) must not become two report rows that share one React
       key and double-count in the alert — first row wins. */
    .filter((r, i, arr) => arr.findIndex((x) => keyOf(x.owner, x.biz) === keyOf(r.owner, r.biz)) === i)
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

/* Which coach this request acts for. A coach is always their own name; an
   admin may pick any coach via ?coach= / body.coach. */
async function resolveCoach(svc: ReturnType<typeof createServiceClient>, auth: { role: string | null; email: string | null; userId: string }, requested: string) {
  const scope = await getCoachScope(svc, auth, requested || undefined);
  return { coach: scope.coach, coaches: scope.coaches };
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const { coach, coaches } = await resolveCoach(svc, auth, String(req.nextUrl.searchParams.get("coach") ?? ""));

  const roster = coach ? await rosterFor(svc, coach) : [];
  /* Filter in the DB so limit(24) means "this coach's newest 24", and fail
     CLOSED for a non-admin whose login matches no book — an unmatched editor
     must see nothing, never everyone (the /api/credits leak class). */
  let q = svc
    .from("coach_reports")
    .select("id, coach, report_month, snapshot_date, entries, referrals, mismatches, extra, created_at, admin_edits")
    .order("created_at", { ascending: false })
    .limit(24);
  if (coach) q = q.ilike("coach", coach);
  const { data: subs } = coach || auth.role === "admin" ? await q : { data: [] };

  /* Pay line per report: live count in that month's 20th snapshot for that
     coach → $400 + $30 × live. Computed here rather than stored so an older
     report still shows it, and so a re-taken snapshot is reflected. */
  const dates = Array.from(new Set((subs ?? []).map((s) => s.snapshot_date).filter((d): d is string => !!d)));
  const liveBy = new Map<string, number>();
  if (dates.length) {
    const { data: snapRows } = await svc.from("coach_snapshots").select("taken_at, coach").in("taken_at", dates).eq("status", "Live");
    for (const r of snapRows ?? []) {
      const k = `${r.taken_at}|${String(r.coach).toLowerCase()}`;
      liveBy.set(k, (liveBy.get(k) ?? 0) + 1);
    }
  }
  const submissions = (subs ?? []).map((s) => {
    const live = s.snapshot_date ? liveBy.get(`${s.snapshot_date}|${String(s.coach).toLowerCase()}`) ?? 0 : null;
    return { ...s, snapshot_live: live, salary: live === null ? null : 400 + 30 * live };
  });

  return NextResponse.json({ coach, coaches: auth.role === "admin" ? coaches : [], roster, submissions });
}

/* Coach vs dashboard. Shared by a fresh submission and an admin correction,
   so an edited report is re-flagged the same way. */
function computeMismatches(coach: string, roster: RosterRow[], entries: { owner: string; biz: string; reported: Reported }[], referrals: Referral[]): string[] {
  const rosterBy = new Map(roster.map((r) => [keyOf(r.owner, r.biz), r]));
  const entryKeys = new Set(entries.map((e) => keyOf(e.owner, e.biz)));
  const mismatches: string[] = [];
  for (const e of entries) {
    const truth = rosterBy.get(keyOf(e.owner, e.biz));
    if (!truth) { mismatches.push(`${e.owner} (${e.biz}): reported ${REPORTED_LABEL[e.reported]}, but the dashboard doesn't list them under ${coach} (live/paused)`); continue; }
    if (e.reported === "active" && truth.status !== "live") mismatches.push(`${e.owner} (${e.biz}): coach says Active, dashboard says ${truth.status}`);
    if (e.reported !== "active" && truth.status === "live") mismatches.push(`${e.owner} (${e.biz}): coach says ${REPORTED_LABEL[e.reported]}, dashboard says live`);
  }
  for (const r of roster) {
    if (!entryKeys.has(keyOf(r.owner, r.biz))) mismatches.push(`${r.owner} (${r.biz}): in ${coach}'s book (${r.status}) but missing from the report`);
  }
  /* The referrer should be a client this coach actually manages — that is the
     whole basis of the bonus. Flag it rather than reject it: sheet names drift
     (aliases in brackets), and the admin approves the payout anyway. */
  const rosterNames = roster.map((r) => `${r.owner} ${r.biz}`.toLowerCase());
  for (const r of referrals) {
    const needle = r.referred_by.toLowerCase();
    if (!rosterNames.some((n) => n.includes(needle) || needle.includes(n.split(" ")[0]))) {
      mismatches.push(`Referral "${r.referred_name}": referrer "${r.referred_by}" is not a client in ${coach}'s book — check the name before paying the bonus`);
    }
  }
  return mismatches;
}

/* Admin correction of a submitted report (owner, 10/21/2026: "sometimes the
   coach gets it wrong"). Only the client statuses and referrals change; the
   mismatches are recomputed and every edit is logged with who and when. */
export async function PATCH(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { id?: number; entries?: { owner?: string; biz?: string; reported?: string }[]; referrals?: { referred_name?: string; referred_by?: string; note?: string }[] } | null;
  const id = Number(body?.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const svc = createServiceClient();
  const { data: row } = await svc.from("coach_reports").select("id, coach, entries, referrals, admin_edits").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const prevEntries = (row.entries ?? []) as { owner: string; biz: string; reported: Reported }[];
  const prevRefs = (row.referrals ?? []) as Referral[];

  let entries = prevEntries;
  if (Array.isArray(body?.entries)) {
    entries = [];
    for (const e of body!.entries!) {
      const reported = String(e.reported ?? "") as Reported;
      if (!["active", "paused_resuming", "churned"].includes(reported)) return NextResponse.json({ error: `Every client needs a status (missing on ${e.owner ?? "?"})` }, { status: 400 });
      const owner = clean(e.owner), biz = clean(e.biz);
      if (!owner || entries.some((x) => keyOf(x.owner, x.biz) === keyOf(owner, biz))) continue;
      entries.push({ owner, biz, reported });
    }
  }
  let referrals = prevRefs;
  if (Array.isArray(body?.referrals)) {
    referrals = [];
    for (const r of body!.referrals!) {
      const referred_name = clean(r.referred_name), referred_by = clean(r.referred_by);
      if (!referred_name && !referred_by) continue;
      if (!referred_name || !referred_by) return NextResponse.json({ error: `Every referral needs both the new artist's name and who referred them (check "${referred_name || referred_by}")` }, { status: 400 });
      if (referrals.some((x) => x.referred_name.toLowerCase() === referred_name.toLowerCase())) continue;
      referrals.push({ referred_name: referred_name.slice(0, 120), referred_by: referred_by.slice(0, 120), note: clean(r.note).slice(0, 200) });
      if (referrals.length >= 25) break;
    }
  }

  // What changed, in words, for the edit log.
  const changes: string[] = [];
  const prevBy = new Map(prevEntries.map((e) => [keyOf(e.owner, e.biz), e.reported]));
  for (const e of entries) { const was = prevBy.get(keyOf(e.owner, e.biz)); if (was && was !== e.reported) changes.push(`${e.owner}: ${REPORTED_LABEL[was]} → ${REPORTED_LABEL[e.reported]}`); }
  const prevNames = new Set(prevRefs.map((r) => r.referred_name.toLowerCase()));
  const nowNames = new Set(referrals.map((r) => r.referred_name.toLowerCase()));
  for (const r of referrals) if (!prevNames.has(r.referred_name.toLowerCase())) changes.push(`referral added: ${r.referred_name} (by ${r.referred_by})`);
  for (const r of prevRefs) if (!nowNames.has(r.referred_name.toLowerCase())) changes.push(`referral removed: ${r.referred_name}`);
  for (const r of referrals) { const p = prevRefs.find((x) => x.referred_name.toLowerCase() === r.referred_name.toLowerCase()); if (p && (p.referred_by !== r.referred_by || p.note !== r.note)) changes.push(`referral edited: ${r.referred_name}`); }
  if (!changes.length) return NextResponse.json({ ok: true, unchanged: true });

  const roster = await rosterFor(svc, String(row.coach));
  const mismatches = computeMismatches(String(row.coach), roster, entries, referrals);
  const admin_edits = [...((row.admin_edits ?? []) as unknown[]), { at: new Date().toISOString(), by: auth.email ?? auth.userId, changes }];
  const { error } = await svc.from("coach_reports").update({ entries, referrals, mismatches, admin_edits }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, changes, mismatchCount: mismatches.length });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { coach?: string; month?: string; entries?: { owner?: string; biz?: string; reported?: string }[]; referrals?: { referred_name?: string; referred_by?: string; note?: string }[]; extra?: string; confirm?: boolean } | null;
  if (!body || !/^\d{4}-\d{2}$/.test(String(body.month ?? "")) || !Array.isArray(body.entries) || body.entries.length === 0) {
    return NextResponse.json({ error: "month + entries required" }, { status: 400 });
  }
  if (!body.confirm) return NextResponse.json({ error: "Please tick the confirmation first" }, { status: 400 });

  const svc = createServiceClient();
  const { coach } = await resolveCoach(svc, auth, String(body.coach ?? ""));
  if (!coach) return NextResponse.json({ error: "No coach book matches your login — ask an admin to check your email" }, { status: 400 });

  /* Coach-typed text is embedded into the alert card — flatten whitespace so
     a crafted name/note can't forge extra "system" lines. */
  const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const entries: { owner: string; biz: string; reported: Reported }[] = [];
  for (const e of body.entries) {
    const reported = String(e.reported ?? "") as Reported;
    if (!["active", "paused_resuming", "churned"].includes(reported)) return NextResponse.json({ error: `Every client needs a status (missing on ${e.owner ?? "?"})` }, { status: 400 });
    const owner = clean(e.owner), biz = clean(e.biz);
    if (entries.some((x) => keyOf(x.owner, x.biz) === keyOf(owner, biz))) continue; // duplicate row in the payload
    entries.push({ owner, biz, reported });
  }

  /* Compare against the dashboard's CURRENT truth (Clients Master). The
     roster is re-read server-side so a stale browser can't misreport. */
  const roster = await rosterFor(svc, coach);

  /* Referrals. Both names are required — a claim with no referrer cannot be
     checked, and each one is real money. Capped so a runaway paste can't
     invent a payday. */
  const referrals: Referral[] = [];
  for (const r of body.referrals ?? []) {
    const referred_name = clean(r.referred_name);
    const referred_by = clean(r.referred_by);
    if (!referred_name && !referred_by) continue; // blank row from the form
    if (!referred_name || !referred_by) {
      return NextResponse.json({ error: `Every referral needs both the new artist's name and who referred them (check "${referred_name || referred_by}")` }, { status: 400 });
    }
    if (referrals.some((x) => x.referred_name.toLowerCase() === referred_name.toLowerCase())) continue; // same claim twice
    referrals.push({ referred_name: referred_name.slice(0, 120), referred_by: referred_by.slice(0, 120), note: clean(r.note).slice(0, 200) });
    if (referrals.length >= 25) break;
  }
  const mismatches = computeMismatches(coach, roster, entries, referrals);

  /* The month is paid from its 20th snapshot — remember which one applies.
     Range is [1st, 1st-of-next-month): a "-31" upper bound is an invalid
     date in months with 30 days and Postgres rejects the whole query.
     Snapshot statuses are initcap ("Live") — take_coach_snapshot writes
     them that way. */
  const month = String(body.month); // YYYY-MM
  const [my, mm] = month.split("-").map(Number);
  const nextMonth = `${mm === 12 ? my + 1 : my}-${String(mm === 12 ? 1 : mm + 1).padStart(2, "0")}-01`;
  const { data: snapDates } = await svc.from("coach_snapshots").select("taken_at").gte("taken_at", `${month}-01`).lt("taken_at", nextMonth).order("taken_at", { ascending: false }).limit(1);
  const snapshotDate: string | null = snapDates?.[0]?.taken_at ?? null;
  const extra = clean(body.extra).slice(0, 1000);

  const { data: inserted, error: insErr } = await svc
    .from("coach_reports")
    .insert({ coach, coach_email: auth.email ?? "", report_month: `${month}-01`, snapshot_date: snapshotDate, entries, referrals, extra, mismatches })
    .select("id")
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, id: inserted.id, mismatchCount: mismatches.length, referrals: referrals.length, referralBonus: referrals.length * REFERRAL_BONUS });
}
