import { getAppLocationToken } from "@/lib/ghl-app";

// Demo checker for the Sales tab.
//
// The question is only ever "did this person show up to their demo?". The
// calendar can't answer it — a past demo stays "confirmed" forever because the
// team never sets GHL's appointmentStatus to "showed". The opportunity's
// PIPELINE STAGE is the real record: sales moves the card as the deal
// progresses, so any stage downstream of "Demo - Booked" proves the demo
// happened, whatever happened afterwards.

const MAIN_LOCATION = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const SALES_PIPELINE = /sales pipeline/i;
// 🖥️ Demo Call + its reschedule calendar. Titles carry "Demo Call" too, which
// covers any demo calendar added later.
const DEMO_CALENDARS = new Set(["8N5925C8NxX7E0Cbw1oF", "RP7VFqOadCAfpKAfwM9F"]);
// Zone the sub-account's calendar times are expressed in.
const ACCOUNT_TZ = process.env.GHL_LOCATION_TZ || "America/Los_Angeles";

export type DemoStatus = "showed" | "not_yet" | "no_show" | "cancelled" | "not_in_system";

export type DemoResult = {
  query: string;              // the name exactly as it was pasted in
  status: DemoStatus;
  contactName?: string;
  email?: string;
  stage?: string;             // the pipeline stage the verdict came from
  demoDate?: string;          // YYYY-MM-DD of the most relevant demo appointment
  /** When the demo appointment was BOOKED and when it takes place — both in
   *  the sub-account's local time ("YYYY-MM-DD HH:MM:SS"), straight from the
   *  calendar. Set whenever a demo appointment exists; the owner asked for
   *  both dates on every demo that hasn't happened yet. */
  bookedAt?: string;
  appointmentAt?: string;
  note?: string;              // why, when the verdict needs explaining
  alternates?: string[];      // other contacts matching the same name
};

type Appt = { calendarId?: string; title?: string; startTime?: string; dateAdded?: string; appointmentStatus?: string; deleted?: boolean };

/** The demo appointment that matters for this contact: the next upcoming one
 *  if there is one, otherwise the most recent. Cancelled/invalid/deleted
 *  entries are junk on this board and are skipped. */
function pickDemoAppointment(events: Appt[], nowLocal: string): Appt | undefined {
  const demos = events.filter((e) =>
    !e.deleted &&
    !/cancel|invalid/i.test(String(e.appointmentStatus ?? "")) &&
    (DEMO_CALENDARS.has(String(e.calendarId ?? "")) || /demo/i.test(String(e.title ?? ""))) &&
    e.startTime
  );
  if (!demos.length) return undefined;
  demos.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  return demos.find((e) => String(e.startTime) >= nowLocal) ?? demos[demos.length - 1];
}

type Stage = { id: string; name: string; position: number };

function norm(s: string): string {
  // Stage names carry emoji and stray spaces — strip to letters for matching.
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const CLIENT_JOURNEY = /client journey/i;
// How far along each verdict is — used to pick between several sales deals.
const STATUS_RANK: Record<DemoStatus, number> = { showed: 4, not_yet: 3, no_show: 2, cancelled: 1, not_in_system: 0 };

/** True when every word of the pasted name starts a word of `full`
 *  ("Xuan" ~ "Xuan Luong", "annie l" ~ "Annie Luong"). An email that merely
 *  contains the letters does not count. */
function namesMatch(pasted: string, full: string): boolean {
  const words = norm(full).split(" ").filter(Boolean);
  const want = norm(pasted).split(" ").filter(Boolean);
  return want.length > 0 && want.every((w) => words.some((x) => x.startsWith(w)));
}

/**
 * Classify a stage name.
 *
 * The keyword rules are deliberately scoped to stages naming the DEMO. The
 * board also carries "Discovery - Cancelled" and "Discovery - No show", which
 * are a different call entirely — an unscoped /no show/ rule would report those
 * people as demo no-shows when no demo was ever booked.
 *
 * Everything else falls through to board position: the sales pipeline is
 * ordered, so any stage sitting after "Demo - Booked" means the demo happened,
 * and anything before it means it hasn't. That keeps new stages classifying
 * correctly without a code change.
 */
function classify(stageName: string, stage: Stage | undefined, demoIdx: number): { status: DemoStatus; note?: string } {
  const n = norm(stageName);
  const isDemoStage = /demo/.test(n);
  if (isDemoStage && /no show/.test(n)) return { status: "no_show" };
  if (isDemoStage && /cancel/.test(n)) return { status: "cancelled" };
  if (isDemoStage && /booked/.test(n)) return { status: "not_yet" };

  if (stage && demoIdx >= 0) {
    if (stage.position > demoIdx) return { status: "showed" };
    // Pre-demo stages — still a lead, discovery, or nurture. No demo on the
    // board, so "not happened yet" is the right bucket, but say why.
    return { status: "not_yet", note: `Still at "${stageName.trim()}" — no demo booked yet` };
  }
  return { status: "showed" };
}

export async function checkDemos(names: string[]): Promise<DemoResult[]> {
  const { token, error } = await getAppLocationToken(MAIN_LOCATION);
  if (!token) throw new Error(error || "Could not mint a GHL location token");
  const H = { Authorization: `Bearer ${token}`, Version: "2021-07-28" };

  // Stage map for the sales pipeline, in board order.
  const pipes = (await fetch(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${MAIN_LOCATION}`,
    { headers: H }
  ).then((r) => r.json())) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };

  const stageById = new Map<string, Stage>();
  const pipeName = new Map<string, string>();
  let demoIdx = -1;
  for (const p of pipes.pipelines ?? []) {
    pipeName.set(p.id, p.name);
    (p.stages ?? []).forEach((s, i) => {
      stageById.set(s.id, { id: s.id, name: s.name, position: i });
      if (SALES_PIPELINE.test(p.name) && /demo booked/.test(norm(s.name))) demoIdx = i;
    });
  }

  // Appointment times come back as naive local strings ("2026-09-21 12:00:00")
  // in the sub-account's zone; compare against "now" written the same way.
  const nowLocal = new Date().toLocaleString("sv-SE", { timeZone: ACCOUNT_TZ }).replace("T", " ");

  const out: DemoResult[] = [];
  for (const query of names) {
    const name = query.trim();
    if (!name) continue;

    // Who could this name be? Two searches, merged by contact:
    //  - contacts whose CURRENT name/email/phone matches, and
    //  - contacts whose DEAL is named that way. Deals keep the name the person
    //    booked under, so a client who later renamed themselves in the CRM
    //    (pasted "Xuan", contact now "Annie Luong") is only findable this way.
    //    Without it the contact search fell back to whoever had "xuan" in an
    //    email address — an unrelated 2025 lead with a cancelled demo.
    const cs = (await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${MAIN_LOCATION}&query=${encodeURIComponent(name)}&limit=5`,
      { headers: H }
    )
      .then((r) => r.json())
      .catch(() => ({}))) as { contacts?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }> };
    const byDeal = (await fetch(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${MAIN_LOCATION}&q=${encodeURIComponent(name)}&limit=20`,
      { headers: H }
    )
      .then((r) => r.json())
      .catch(() => ({}))) as { opportunities?: Array<{ contactId?: string; contact?: { id?: string; name?: string; email?: string } }> };

    type Hit = { id: string; label: string; email: string };
    const hits = new Map<string, Hit>();
    for (const c of cs.contacts ?? []) {
      hits.set(c.id, { id: c.id, label: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(no name)", email: c.email ?? "" });
    }
    for (const o of byDeal.opportunities ?? []) {
      const id = o.contactId || o.contact?.id;
      if (!id || hits.has(id)) continue;
      hits.set(id, { id, label: o.contact?.name?.trim() || "(no name)", email: o.contact?.email ?? "" });
    }
    if (!hits.size) {
      out.push({ query: name, status: "not_in_system", note: "No contact or deal with this name in the sub-account" });
      continue;
    }

    // A name can match several contacts. Read each one's deals, and report the
    // ones not chosen as alternates so nothing is hidden.
    type Cand = Hit & { stage?: string; status?: DemoStatus; note?: string; updated: string; nameMatch: boolean; dealNames: string[] };
    const cands: Cand[] = [];
    for (const c of [...hits.values()].slice(0, 6)) {
      const os = (await fetch(
        `https://services.leadconnectorhq.com/opportunities/search?location_id=${MAIN_LOCATION}&contact_id=${c.id}&limit=20`,
        { headers: H }
      )
        .then((r) => r.json())
        .catch(() => ({}))) as { opportunities?: Array<{ name?: string; pipelineId: string; pipelineStageId: string; updatedAt?: string }> };

      const opps = os.opportunities ?? [];
      const dealNames = opps.map((o) => String(o.name ?? "").trim()).filter(Boolean);
      // Does the pasted name actually NAME this person (contact or any deal),
      // rather than just appearing inside an email address?
      const nameMatch = [c.label, ...dealNames].some((n) => namesMatch(name, n));
      const sales = opps.filter((o) => SALES_PIPELINE.test(pipeName.get(o.pipelineId) ?? ""));
      const journey = opps.filter((o) => CLIENT_JOURNEY.test(pipeName.get(o.pipelineId) ?? ""));
      const lastTouch = [...opps].map((o) => String(o.updatedAt ?? "")).sort().pop() ?? "";
      if (!sales.length && !journey.length) {
        cands.push({ ...c, updated: lastTouch.slice(0, 10), nameMatch, dealNames });
        continue;
      }
      // A person can carry SEVERAL sales deals (a re-booked demo opens a fresh
      // card while the old one moves on). The furthest-along one wins: one card
      // past the demo proves the demo happened, whatever the other says.
      const verdicts = sales.map((o) => {
        const st = stageById.get(o.pipelineStageId);
        const stageName = st?.name ?? o.pipelineStageId;
        return { stageName, ...classify(stageName, st, demoIdx) };
      });
      verdicts.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
      let v: { stageName: string; status: DemoStatus; note?: string } | undefined = verdicts[0];
      // A Client Journey card = they closed and are onboarding — the demo
      // obviously happened, even if the sales card was never moved.
      if (journey.length && (!v || v.status !== "showed")) {
        const st = stageById.get(journey[0].pipelineStageId);
        v = { stageName: st?.name ?? "Client Journey", status: "showed", note: "Closed — in the Client Journey pipeline" };
      }
      cands.push({ ...c, stage: v!.stageName, status: v!.status, note: v!.note, updated: lastTouch.slice(0, 10), nameMatch, dealNames });
    }

    const withOpp = cands.filter((c) => c.status);
    if (!withOpp.length) {
      out.push({
        query: name,
        status: "not_in_system",
        contactName: cands[0]?.label,
        email: cands[0]?.email,
        note: "Contact exists but has no sales-pipeline opportunity",
        alternates: cands.slice(1).map((c) => `${c.label} <${c.email}>`),
      });
      continue;
    }

    // Real name matches first (contact or deal named this), then the most
    // recently touched.
    withOpp.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.updated.localeCompare(a.updated));
    const best = withOpp[0];
    // Say so when the person now goes by another name in the CRM.
    const renamed = !namesMatch(name, best.label) && best.dealNames.some((n) => namesMatch(name, n));
    if (renamed) best.note = [`Now named "${best.label}" in the CRM (deal still says "${best.dealNames.find((n) => namesMatch(name, n))}")`, best.note].filter(Boolean).join(" · ");

    // The calendar can't say whether a demo happened, but it is the only
    // place that says WHEN it was booked and when it is — which is what the
    // owner wants for every demo still ahead.
    const ap = (await fetch(`https://services.leadconnectorhq.com/contacts/${best.id}/appointments`, { headers: H })
      .then((r) => r.json())
      .catch(() => ({}))) as { events?: Appt[] };
    const demo = pickDemoAppointment(ap.events ?? [], nowLocal);
    // "Demo - Booked" with a demo time already behind us means nobody moved
    // the card — the demo is not "still ahead", its outcome is just unrecorded.
    let note = best.note;
    if (best.status === "not_yet" && demo?.startTime && demo.startTime < nowLocal) {
      note = `Demo time has passed but the card is still in "Demo - Booked" — outcome not recorded, check the conversation`;
    }

    out.push({
      query: name,
      status: best.status!,
      contactName: best.label,
      email: best.email,
      stage: best.stage,
      note,
      demoDate: demo?.startTime?.slice(0, 10) ?? best.updated ?? undefined,
      bookedAt: demo?.dateAdded ?? undefined,
      appointmentAt: demo?.startTime ?? undefined,
      alternates: cands.filter((c) => c !== best).map((c) => `${c.label} <${c.email}>${c.stage ? ` — ${c.stage}` : " — no opportunity"}`),
    });
  }

  return out;
}

/** Collapse a pasted list to unique names (case/space-insensitive), keeping
 *  first-seen order, and report what was pasted more than once — the owner
 *  wants duplicates flagged, not counted twice. */
export function dedupeNames(names: string[]): { unique: string[]; duplicates: string[] } {
  const seen = new Map<string, string>();
  const dupes = new Map<string, number>();
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const k = n.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) { dupes.set(seen.get(k)!, (dupes.get(seen.get(k)!) ?? 1) + 1); continue; }
    seen.set(k, n);
  }
  return { unique: [...seen.values()], duplicates: [...dupes.entries()].map(([n, c]) => `${n} (pasted ${c}×)`) };
}
