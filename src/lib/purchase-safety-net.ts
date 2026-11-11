import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { capiTokens, sendCapiWithTokens, recordCapi, pickFbc } from "@/lib/meta-capi";

/* Server Purchase for deposits the browser never reported (owner,
   11/11/2026: "fix the 4%").

   The Purchase normally starts in the lead's browser, the moment the
   checkout says "paid" (OB_ONPAID → pixel + /api/onebox/book, which logs
   it in capi_events). When that moment never happens — she paid from a
   follow-up link outside the funnel, closed the tab, or the heal cron
   booked her later — Meta never hears about the deposit: 12 of 326
   deposits since 10/14 (3.7%).

   Every 10 minutes (paid-tag-heal cron) each new deposit is matched to its
   funnel by Fanbasis product id and to its lead by email or exact name.
   It is sent only when NO Purchase with an event id was logged for that
   person — and, to never count one payment twice, also not when any
   Purchase landed on that funnel in the 3 hours before the payment synced
   (people often pay with another email; their browser Purchase is then
   under a phone we can't tie to the payment). The event id comes from the
   payment itself, so a payment is sent once even across runs. */

const GRACE_MS = 15 * 60_000;           // the browser's own report lands within seconds
const NEAR_MS = 3 * 3600_000;
const DAY = 86_400_000;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const last10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
/* Sheet dates are DD/MM/YYYY. */
function depositDay(v: unknown): number {
  const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}
/* ilike with the value taken literally (emails often contain "_"). */
const lit = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

type Funnel = { slug: string; config: Record<string, string> | null; extras: { metaPixelId?: string; capiToken?: string; template?: string; fanbasisProductId?: string } | null };
type Lead = { phone: string | null; visitor_id: string | null; click?: Record<string, string> | null; created_at: string };
type Logged = { slug: string; event_id: string | null; lead_phone: string | null; created_at: string };

/* `dry` lists who WOULD be sent without sending or logging (back-tests). */
export async function sendMissedPurchases(svc: SupabaseClient, opts: { now?: number; days?: number; dry?: boolean } = {}): Promise<{ checked: number; sent: string[]; skipped: number; errors: string[] }> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 2;
  const sent: string[] = [], errors: string[] = [];
  let skipped = 0;

  const { data: depRows, error: dErr } = await svc.from("deposits").select("data, synced_at")
    .gte("synced_at", new Date(now - days * DAY).toISOString());
  if (dErr) throw new Error(dErr.message);
  const deps = ((depRows ?? []) as Array<{ data: Record<string, unknown>; synced_at: string }>).filter((r) =>
    depositDay(r.data["Date"]) >= now - (days + 2) * DAY // real new payments, not a bulk re-sync of old rows
    && now - Date.parse(r.synced_at) >= GRACE_MS
    && String(r.data["Email"] ?? "").includes("@")
    && !/^router\.test/i.test(String(r.data["Email"] ?? "")) // the payment router's own $1 setup test
    && !/demo/i.test(String(r.data["Business Name"] ?? ""))
    && parseFloat(String(r.data["Amount"] ?? "").replace(/[^0-9.-]/g, "")) > 0);
  if (!deps.length) return { checked: 0, sent, skipped, errors };

  /* Fanbasis product id → funnel. A product id used by two funnels can't
     say which one was paid → left alone. */
  const { data: fRows } = await svc.from("onebox_clients").select("slug, config, extras").neq("status", "draft");
  const byPid = new Map<string, Funnel | null>();
  for (const f of (fRows ?? []) as Funnel[]) {
    if (f.extras?.template === "b2b" || /demo/i.test(f.slug)) continue;
    const pid = String(f.config?.fanbasisProductId || f.extras?.fanbasisProductId || f.config?.fanbasisCode || "").trim();
    if (pid) byPid.set(pid, byPid.has(pid) ? null : f);
  }

  /* Every Purchase logged since the oldest of these payments (few rows). */
  const oldest = Math.min(...deps.map((d) => depositDay(d.data["Date"]))) - 2 * DAY;
  const logged: Logged[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc.from("capi_events").select("slug, event_id, lead_phone, created_at")
      .eq("event_name", "Purchase").gte("created_at", new Date(oldest).toISOString()).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    logged.push(...((data ?? []) as Logged[]));
    if (!data || data.length < 1000) break;
  }
  const withId = logged.filter((l) => String(l.event_id ?? "").trim());

  let checked = 0;
  for (const d of deps) {
    const pid = String(d.data["Product ID"] ?? "").trim();
    const f = byPid.get(pid);
    if (!f) continue;
    const email = String(d.data["Email"]).trim().toLowerCase();
    const name = String(d.data["Full Name"] ?? "").trim();
    const eventId = `dep-${sha(`${email}|${pid}|${d.data["Date"]}`).slice(0, 32)}`;
    if (logged.some((l) => l.event_id === eventId)) continue; // this payment was handled already
    checked++;
    try {
      /* Her lead rows on this funnel: by email, else by exact full name. */
      const pick = "phone, visitor_id, click, created_at";
      const byEmail = await svc.from("onebox_leads").select(pick).eq("slug", f.slug).ilike("answers->>email", lit(email))
        .order("created_at", { ascending: false }).limit(5);
      if (byEmail.error) throw new Error(byEmail.error.message);
      let leads = (byEmail.data ?? []) as Lead[];
      if (!leads.length && name.includes(" ")) {
        const byName = await svc.from("onebox_leads").select(pick).eq("slug", f.slug).ilike("full_name", lit(name))
          .order("created_at", { ascending: false }).limit(5);
        leads = (byName.data ?? []) as Lead[];
      }
      const phones = new Set(leads.map((l) => last10(l.phone)).filter((p) => p.length === 10));
      const payDay = depositDay(d.data["Date"]);
      const synced = Date.parse(d.synced_at);
      const browserSent = withId.some((l) => l.slug === f.slug && phones.has(last10(l.lead_phone)) && Date.parse(l.created_at) >= payDay - 2 * DAY);
      /* A browser Purchase (not one of ours) on this funnel shortly before
         the payment synced may be hers under another phone. */
      const nearSent = withId.some((l) => {
        if (l.slug !== f.slug || String(l.event_id).startsWith("dep-")) return false;
        const t = Date.parse(l.created_at);
        return t >= synced - NEAR_MS && t <= synced + GRACE_MS;
      });
      if (browserSent || nearSent) { skipped++; continue; }

      const phone = leads.find((l) => last10(l.phone).length === 10)?.phone ?? "";
      const pixelId = String(f.config?.metaPixelId || f.extras?.metaPixelId || "").replace(/\D/g, "");
      if (opts.dry) { sent.push(`${name || email} (${f.slug}${pixelId ? "" : ", no pixel"}${leads.length ? "" : ", no lead"})`); continue; }
      const tokens = capiTokens(f.extras);
      if (!pixelId || !tokens.length) {
        await recordCapi(svc, { slug: f.slug, eventName: "Purchase", eventId, pixelId, phone, ok: false, error: !pixelId ? "no pixel on funnel" : "no META_CAPI_TOKEN" });
        continue;
      }
      const fbcLead = leads.find((l) => l.click?.fbc);
      const fbc = pickFbc(null, fbcLead?.click?.fbc, null);
      const amount = parseFloat(String(d.data["Amount"] ?? "").replace(/[^0-9.]/g, ""));
      const res = await sendCapiWithTokens({
        pixelId, eventName: "Purchase", eventId,
        eventSourceUrl: `https://book.pmu-care.com/f/${f.slug}`,
        eventTime: Math.floor(Math.min(synced, now) / 1000),
        value: Number.isFinite(amount) ? amount : undefined,
        currency: "USD",
        user: {
          email, phone, fullName: name,
          fbc: fbc.fbc,
          fbp: String(leads.find((l) => l.click?.fbp)?.click?.fbp ?? ""),
          userAgent: leads.find((l) => l.click?.ua)?.click?.ua,
          externalId: (fbcLead ?? leads.find((l) => l.visitor_id))?.visitor_id ?? null,
        },
      }, tokens).catch(() => ({ ok: false, error: "send threw" }));
      await recordCapi(svc, { slug: f.slug, eventName: "Purchase", eventId, pixelId, phone, ok: res.ok, error: res.error, fbcSrc: fbc.src });
      if (res.ok) sent.push(`${name || email} (${f.slug})`);
      else errors.push(`${f.slug}: ${(res.error ?? "refused").slice(0, 80)}`);
    } catch (e) {
      errors.push(`${f.slug}: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`);
    }
  }
  return { checked, sent, skipped, errors };
}
