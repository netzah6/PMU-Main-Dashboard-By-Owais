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

export type DemoStatus = "showed" | "not_yet" | "no_show" | "cancelled" | "not_in_system";

export type DemoResult = {
  query: string;              // the name exactly as it was pasted in
  status: DemoStatus;
  contactName?: string;
  email?: string;
  stage?: string;             // the pipeline stage the verdict came from
  demoDate?: string;          // YYYY-MM-DD of the most relevant demo appointment
  note?: string;              // why, when the verdict needs explaining
  alternates?: string[];      // other contacts matching the same name
};

type Stage = { id: string; name: string; position: number };

function norm(s: string): string {
  // Stage names carry emoji and stray spaces — strip to letters for matching.
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
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

  const out: DemoResult[] = [];
  for (const query of names) {
    const name = query.trim();
    if (!name) continue;

    const cs = (await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${MAIN_LOCATION}&query=${encodeURIComponent(name)}&limit=5`,
      { headers: H }
    )
      .then((r) => r.json())
      .catch(() => ({}))) as { contacts?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }> };

    const contacts = cs.contacts ?? [];
    if (!contacts.length) {
      out.push({ query: name, status: "not_in_system", note: "No contact with this name in the sub-account" });
      continue;
    }

    // A name can match several contacts. Score each by whether it has a sales
    // opportunity, and report the rest as alternates so nothing is hidden.
    type Cand = { label: string; email: string; stage?: string; status?: DemoStatus; note?: string; updated: string };
    const cands: Cand[] = [];
    for (const c of contacts.slice(0, 4)) {
      const label = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(no name)";
      const os = (await fetch(
        `https://services.leadconnectorhq.com/opportunities/search?location_id=${MAIN_LOCATION}&contact_id=${c.id}&limit=10`,
        { headers: H }
      )
        .then((r) => r.json())
        .catch(() => ({}))) as { opportunities?: Array<{ pipelineId: string; pipelineStageId: string; updatedAt?: string }> };

      const sales = (os.opportunities ?? []).filter((o) => SALES_PIPELINE.test(pipeName.get(o.pipelineId) ?? ""));
      if (!sales.length) {
        cands.push({ label, email: c.email ?? "", updated: "" });
        continue;
      }
      sales.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      const o = sales[0];
      const st = stageById.get(o.pipelineStageId);
      const stageName = st?.name ?? o.pipelineStageId;
      const verdict = classify(stageName, st, demoIdx);
      cands.push({
        label,
        email: c.email ?? "",
        stage: stageName,
        status: verdict.status,
        note: verdict.note,
        updated: String(o.updatedAt ?? "").slice(0, 10),
      });
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

    withOpp.sort((a, b) => b.updated.localeCompare(a.updated));
    const best = withOpp[0];
    out.push({
      query: name,
      status: best.status!,
      contactName: best.label,
      email: best.email,
      stage: best.stage,
      note: best.note,
      demoDate: best.updated || undefined,
      alternates: cands.filter((c) => c !== best).map((c) => `${c.label} <${c.email}>${c.stage ? ` — ${c.stage}` : " — no opportunity"}`),
    });
  }

  return out;
}
