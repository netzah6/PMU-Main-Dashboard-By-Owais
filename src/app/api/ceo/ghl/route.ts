import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getAppLocationToken } from "@/lib/ghl-app";

export const maxDuration = 60;

// GHL proxy for the CEO page's Setter & Closer section. The page was built
// against a standalone Vercel proxy that has since died (every call returned
// ghl_401); this one speaks the exact same contract but signs requests with
// this app's own marketplace-app token, which never reaches the browser.
//
// Contract (POST JSON):
//   {action:"appointments", locationId, userId, startTime, endTime}  → {ok, data}
//   {action:"calendars",    locationId}                              → {ok, data}
//   {action:"freeslots",    calendarId, startDate, endDate, timezone}→ {ok, data}
//   {action:"contactnames", ids:[...]}                               → {ok, names}

const GHL = "https://services.leadconnectorhq.com";
const AGENCY = "SfpNMJ5YU9lBkxss47lK"; // only this location is ever queried

async function gget(url: string, token: string, version: string) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ghl_${r.status}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, string | string[]>;
  const action = String(body.action ?? "");

  const tok = await getAppLocationToken(AGENCY);
  if (!tok.token) return NextResponse.json({ ok: false, error: tok.error ?? "no_token" });

  try {
    if (action === "appointments") {
      const p = new URLSearchParams({
        locationId: AGENCY,
        userId: String(body.userId ?? ""),
        startTime: String(body.startTime ?? ""),
        endTime: String(body.endTime ?? ""),
      });
      const data = await gget(`${GHL}/calendars/events?${p}`, tok.token, "2021-04-15");
      return NextResponse.json({ ok: true, data });
    }
    if (action === "calendars") {
      const data = await gget(`${GHL}/calendars/?locationId=${AGENCY}`, tok.token, "2021-04-15");
      return NextResponse.json({ ok: true, data });
    }
    if (action === "freeslots") {
      const p = new URLSearchParams({
        startDate: String(body.startDate ?? ""),
        endDate: String(body.endDate ?? ""),
        timezone: String(body.timezone ?? ""),
      });
      const data = await gget(
        `${GHL}/calendars/${encodeURIComponent(String(body.calendarId ?? ""))}/free-slots?${p}`,
        tok.token, "2021-04-15",
      );
      return NextResponse.json({ ok: true, data });
    }
    if (action === "contactnames") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 80).map(String);
      const names: Record<string, string> = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const j = await gget(`${GHL}/contacts/${encodeURIComponent(id)}`, tok.token!, "2021-07-28");
          const c = (j.contact ?? j) as Record<string, unknown>;
          const name = String(c.contactName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`).trim();
          if (name) names[id] = name;
        } catch { /* keep the page's first-name fallback */ }
      }));
      return NextResponse.json({ ok: true, names });
    }
    return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" });
  }
}
