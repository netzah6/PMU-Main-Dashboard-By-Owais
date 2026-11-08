import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

/* Client problems the assigned Client Success Coach must fix (owner,
   11/08/2026): "🚦 Leads but not Live" — ads bring leads but the client's
   status is not Live (Kobasic Brows: Offboarded) — and "welcome texts NOT
   sent" when a client reaches First Cycle without logins. They used to live
   only on the admin Alerts tab, so the coach never saw them. Same rows, same
   self-closing rules; this only shows a coach the ones for HER clients
   (alert meta.csm = the "Assigned" coach name, matched to the login's email
   name, e.g. "Viridiana" ↔ viridiana@…). Admins get every open one. */

export type CoachAlert = { id: string; type: string; title: string; detail: string | null; created_at: string; csm: string | null; link: string | null };

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ alerts: [] });
  const svc = createServiceClient();
  const { data, error } = await svc.from("alerts").select("id, type, title, detail, created_at, source_key, meta")
    .eq("status", "open").in("type", ["status", "onboarding"]).order("created_at", { ascending: false }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const me = (auth.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const alerts: CoachAlert[] = (data ?? [])
    .filter((a) => a.type === "status" || String(a.source_key).startsWith("first_cycle_blank:"))
    .map((a) => {
      const m = (a.meta ?? {}) as Record<string, unknown>;
      return { id: a.id, type: a.type, title: a.title, detail: a.detail, created_at: a.created_at, csm: typeof m.csm === "string" ? m.csm : null, link: typeof m.link === "string" ? m.link : null };
    })
    .filter((a) => auth.role === "admin" || (!!me && (a.csm ?? "").toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g, "") === me));
  return NextResponse.json({ alerts });
}
