// Keeps the client's GoHighLevel contact owner ("Assigned to") in step with the
// dashboard's Assigned column (owner request 10/21/2026: Ngoc Nguyen showed
// Stephanie on the dashboard but Nicolas in GHL — the dashboard only ever
// wrote the Google Sheet).
import { getAppLocationToken } from "@/lib/ghl-app";

const AGENCY_LOCATION_ID = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const BASE = "https://services.leadconnectorhq.com";

export type AssignSyncResult =
  | { ok: true; userName: string }
  | { ok: false; skipped?: boolean; error: string };

const isContactId = (s: string) => /^[A-Za-z0-9]{20}$/.test(s);

/** Dashboard names are first names ("Stephanie"); GHL users have full names. */
export async function syncAssignedToGhl(contactIdRaw: unknown, assignedRaw: unknown): Promise<AssignSyncResult> {
  const contactId = String(contactIdRaw ?? "").trim();
  const assigned = String(assignedRaw ?? "").trim();
  if (!isContactId(contactId)) return { ok: false, skipped: true, error: "no GHL contact linked" };
  if (!assigned) return { ok: false, skipped: true, error: "blank Assigned — GHL left as is" };

  const { token, error } = await getAppLocationToken(AGENCY_LOCATION_ID);
  if (!token) return { ok: false, error: error ?? "no GHL token" };
  const H = { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" };

  const ur = await fetch(`${BASE}/users/?locationId=${AGENCY_LOCATION_ID}`, { headers: H });
  if (!ur.ok) return { ok: false, error: `users HTTP ${ur.status}` };
  const users = ((await ur.json()) as { users?: { id: string; firstName?: string; lastName?: string; deleted?: boolean }[] }).users ?? [];
  const want = assigned.toLowerCase();
  const full = (u: { firstName?: string; lastName?: string }) => `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  const hits = users.filter((u) => !u.deleted && (full(u).toLowerCase() === want || (u.firstName ?? "").trim().toLowerCase() === want));
  if (hits.length !== 1) return { ok: false, error: hits.length ? `"${assigned}" matches ${hits.length} GHL users` : `no GHL user named "${assigned}"` };

  const pr = await fetch(`${BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ assignedTo: hits[0].id }),
  });
  if (!pr.ok) return { ok: false, error: `contact update HTTP ${pr.status}: ${(await pr.text()).slice(0, 120)}` };
  return { ok: true, userName: full(hits[0]) };
}
