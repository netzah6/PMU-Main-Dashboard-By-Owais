/* "The last booking wins" (owner rule, 2026-11-05): when a lead ends up with
   two appointments for one session — the AI's chat booking and the funnel's
   — the older one is cancelled by the system, not by a person.

   A plain API cancel does not hold. Any API change to an appointment
   re-fires the account's "Customer Booked Appointment" workflow, which turns
   it back into a hold 10 minutes later and then confirms it again, with a
   second "your appointment is confirmed" text (13 cancels reverted,
   2026-10-25). Taking the contact out of that workflow a few seconds after
   the cancel stops it: 17 cancels done this way stayed cancelled and sent
   no text. Cancelling never texts the lead. */
const GHL = "https://services.leadconnectorhq.com";
const BOOKED_WORKFLOW = /customer booked appointment/i;

export async function cancelAppointmentQuietly(
  token: string, locationId: string, contactId: string, appointmentId: string,
  opts: { alsoLeave?: RegExp[] } = {},
): Promise<boolean> {
  const H = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
  let cancelled = false;
  for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 1200));
    cancelled = await fetch(`${GHL}/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, {
      method: "PUT", headers: { ...H, Version: "2021-04-15" }, body: JSON.stringify({ appointmentStatus: "cancelled" }),
    }).then((r) => r.ok).catch(() => false);
  }
  if (!cancelled) return false;
  await new Promise((r) => setTimeout(r, 5000));
  const wr = await fetch(`${GHL}/workflows/?locationId=${encodeURIComponent(locationId)}`, { headers: { ...H, Version: "2021-07-28" } }).catch(() => null);
  const wfs = wr?.ok ? ((((await wr.json().catch(() => null)) as { workflows?: Array<{ id?: string; name?: string }> } | null)?.workflows) ?? []) : [];
  // alsoLeave: other workflows that would act on this appointment later
  // (the AI-hold cleanup also leaves "Appointment Status Invalid -> Confirm").
  const leave = [BOOKED_WORKFLOW, ...(opts.alsoLeave ?? [])];
  const booked = wfs.filter((w) => w.id && leave.some((re) => re.test(String(w.name ?? ""))));
  // No such workflow on the account = nothing can bring the appointment back.
  if (wr?.ok && !booked.length) return true;
  let removed = booked.length > 0;
  for (const w of booked) {
    const ok = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(String(w.id))}`, {
      method: "DELETE", headers: { ...H, Version: "2021-07-28" },
    }).then((r) => r.ok).catch(() => false);
    if (!ok) removed = false;
  }
  // Cancelled, but the workflow may bring it back: the caller keeps its alert open.
  return removed;
}
