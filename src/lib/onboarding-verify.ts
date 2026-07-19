import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken, getAppAgencyToken } from "@/lib/ghl-app";
import { listCheckoutTransactions, getProductCheckoutUrl } from "@/lib/fanbasis";
import { ONBOARDING_STEPS } from "@/lib/onboarding-steps";

// Auto-verify an onboarding's technical setup. For each checklist step we CAN
// inspect programmatically (funnel pages, Fanbasis product, GHL custom values,
// the sheets), we return pass/fail with a reason. Steps that live in external
// tools we can't reach (Facebook, Make.com, CloseBot, physical phone/A2P) are
// returned as "manual" so the UI shows them as still-your-job rather than
// pretending they passed.

export type CheckStatus = "pass" | "fail" | "manual" | "skip";
export type Check = { key: string; status: CheckStatus; detail: string };

const BASE = "https://services.leadconnectorhq.com";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function ghlGet(url: string, token: string, version = "2021-07-28") {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } });
    return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { ok: false, status: 0, json: {} as Record<string, unknown> }; }
}

// Resolve a business name to its GHL location id (clients_master/ghl_sync_status
// first, then a live GHL locations search for brand-new sub-accounts).
async function resolveLocationId(business: string): Promise<string | null> {
  const svc = createServiceClient();
  const bn = norm(business);
  const { data: cm } = await svc.from("clients_master").select("data");
  let owner: string | null = null;
  for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
    if (norm(String(r.data?.["Business Name"] ?? "")) === bn) { owner = String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase(); break; }
  }
  if (owner) {
    const { data: ss } = await svc.from("ghl_sync_status").select("location_id").eq("owner_key", owner).maybeSingle();
    if (ss?.location_id) return ss.location_id as string;
  }
  const agency = await getAppAgencyToken();
  if (agency) {
    const r = await ghlGet(`${BASE}/locations/search?limit=500`, agency.token);
    for (const loc of (r.json.locations as Array<Record<string, unknown>> | undefined) ?? []) {
      if (norm(String(loc.name ?? "")) === bn) return String(loc.id ?? loc._id ?? "") || null;
    }
  }
  return null;
}

export type FunnelUrls = { survey: string; booking: string; lastStep: string; thankYou: string };
export type UserInfo = { name: string; role: string; permissions: string[] };

// US area code → state, for the purchased-phone "local number" check. Grouped
// by state so it stays readable; expanded into a lookup map below.
const STATE_CODES: Record<string, number[]> = {
  AL: [205, 251, 256, 334, 659, 938], AK: [907], AZ: [480, 520, 602, 623, 928],
  AR: [479, 501, 870],
  CA: [209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951],
  CO: [303, 719, 720, 970, 983], CT: [203, 475, 860, 959], DE: [302], DC: [202, 771],
  FL: [239, 305, 321, 352, 386, 407, 448, 561, 656, 689, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  GA: [229, 404, 470, 478, 678, 706, 762, 770, 912, 943], HI: [808], ID: [208, 986],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872],
  IN: [219, 260, 317, 463, 574, 765, 812, 930], IA: [319, 515, 563, 641, 712],
  KS: [316, 620, 785, 913], KY: [270, 364, 502, 606, 859], LA: [225, 318, 337, 504, 985],
  ME: [207], MD: [227, 240, 301, 410, 443, 667], MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MI: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989],
  MN: [218, 320, 507, 612, 651, 763, 952], MS: [228, 601, 662, 769],
  MO: [235, 314, 417, 557, 573, 636, 660, 816, 975], MT: [406], NE: [308, 402, 531],
  NV: [702, 725, 775], NH: [603], NJ: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973],
  NM: [505, 575], NY: [212, 315, 329, 332, 347, 363, 516, 518, 585, 607, 624, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934],
  NC: [252, 336, 472, 704, 743, 828, 910, 919, 980, 984], ND: [701],
  OH: [216, 220, 234, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937],
  OK: [405, 539, 572, 580, 918], OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878],
  RI: [401], SC: [803, 821, 839, 843, 854, 864], SD: [605],
  TN: [423, 615, 629, 731, 865, 901, 931],
  TX: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 903, 915, 936, 940, 945, 956, 972, 979],
  UT: [385, 435, 801], VT: [802], VA: [276, 434, 540, 571, 686, 703, 757, 804, 826, 948],
  WA: [206, 253, 360, 425, 509, 564], WV: [304, 681], WI: [262, 274, 414, 534, 608, 715, 920],
  WY: [307], PR: [787, 939],
};
const AREA_STATE: Record<string, string> = {};
for (const [st, codes] of Object.entries(STATE_CODES)) for (const c of codes) AREA_STATE[String(c)] = st;

// Sub-account user permission template (from the team's screenshots): ONLY
// these may be ON — everything else must be OFF. Keys are GHL's classic
// permission booleans; labels are the plain-English names shown in reports.
const PERM_LABELS: Record<string, string> = {
  appointmentsEnabled: "Calendars & appointments", contactsEnabled: "Contacts",
  conversationsEnabled: "Conversations", dashboardStatsEnabled: "Dashboard (view)",
  mediaStorageEnabled: "Medias", onlineListingsEnabled: "Listings",
  opportunitiesEnabled: "Opportunities", reviewsEnabled: "Reviews",
  leadValueEnabled: "Opportunities lead value", phoneCallEnabled: "Phone call stats",
  reportingEnabled: "Reporting", adwordsReportingEnabled: "Adwords reporting",
  facebookAdsReportingEnabled: "Facebook Ads reporting", attributionsReportingEnabled: "Attribution reporting",
  agentReportingEnabled: "Agent reporting", bulkRequestsEnabled: "Bulk actions (contacts)",
  opportunitiesBulkActionsEnabled: "Bulk actions (opportunities)", campaignsEnabled: "Campaigns",
  campaignsReadOnly: "Campaigns (read)", workflowsEnabled: "Workflows", workflowsReadOnly: "Workflows (read)",
  triggersEnabled: "Triggers", funnelsEnabled: "Funnels", websitesEnabled: "Websites",
  membershipEnabled: "Memberships", communitiesEnabled: "Communities", certificatesEnabled: "Certificates",
  paymentsEnabled: "Payments", invoiceEnabled: "Invoices", refundsEnabled: "Refunds",
  recordPaymentEnabled: "Record payments", cancelSubscriptionEnabled: "Cancel subscriptions",
  exportPaymentsEnabled: "Export payments", marketingEnabled: "Marketing", socialPlanner: "Social planner",
  bloggingEnabled: "Blogging", contentAiEnabled: "Content AI", botService: "Bot / Ask AI",
  adPublishingEnabled: "Ad publishing", adPublishingReadOnly: "Ad publishing (read)",
  affiliateManagerEnabled: "Affiliate manager", gokollabEnabled: "Gokollab", wordpressEnabled: "WordPress",
  assignedDataOnly: "Assigned data only", settingsEnabled: "Settings", tagsEnabled: "Tags",
};
const permLabel = (k: string) => PERM_LABELS[k] ?? k;
const EXPECTED_PERMS_ON = new Set([
  "appointmentsEnabled", "contactsEnabled", "conversationsEnabled", "dashboardStatsEnabled",
  "mediaStorageEnabled", "onlineListingsEnabled", "opportunitiesEnabled", "reviewsEnabled",
]);
// Optional — fine ON or OFF, never graded: custom-menu-link keys aren't
// visible in the permissions UI, and "View opportunities lead value" is
// allowed either way per the team.
const PERM_IGNORE = new Set(["customMenuLinkReadOnly", "customMenuLinkWrite", "leadValueEnabled"]);

const areaCode = (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").slice(0, 3);
const fmtPhone = (p: string) => { const d = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

export async function verifyOnboarding(form: Record<string, unknown>, opts: { locationId?: string | null } = {}): Promise<{ checks: Check[]; locationId: string | null; depositUrl: string | null; funnelUrls: FunnelUrls | null; productId: string | null; checkoutUrl: string | null; usersInfo: UserInfo[]; version: string }> {
  const business = String(form.business_name ?? "").trim();
  const productId = String(form.product_id ?? "").trim();
  const address = String(form.address ?? "").trim();
  const checks: Check[] = [];
  const push = (key: string, status: CheckStatus, detail: string) => checks.push({ key, status, detail });

  // Sheet-side checks (fast, no external calls).
  const svc = createServiceClient();
  const bn = norm(business);
  const { data: cm } = await svc.from("clients_master").select("data");
  const inMaster = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).some((r) => norm(String(r.data?.["Business Name"] ?? "")) === bn);

  const locationId = (opts.locationId && String(opts.locationId).trim()) || (await resolveLocationId(business));
  const { data: ss } = locationId
    ? await svc.from("ghl_sync_status").select("location_id").eq("location_id", locationId).maybeSingle()
    : { data: null };
  push("fin_keys", ss ? "pass" : "manual", ss ? "Sub-account is connected (location tracked)" : "Couldn't confirm the keys-sheet/location entry");

  // Client version (V1 / V2.3 / V3): prefer the onboarding form, else the
  // Master sheet's "Version". Drives which checks apply — Make.com and the
  // CloseBot section are V3-only. Unknown version → treat as V3 (show all)
  // rather than silently hiding checks.
  let masterVersion = "";
  let masterServices = "";
  for (const r of ((cm ?? []) as Array<{ data: Record<string, unknown> }>))
    if (norm(String(r.data?.["Business Name"] ?? "")) === bn) {
      masterVersion = String(r.data?.["Version"] ?? "").trim();
      masterServices = String(r.data?.["PMU Services"] ?? "").trim();
      break;
    }
  const versionRaw = String(form.version ?? "").trim() || masterVersion;
  const isV3 = norm(versionRaw).startsWith("v3");
  const knownNotV3 = !!versionRaw && !isV3;

  // "Update the V status" — the client's status on OUR dashboard (the Master
  // data's Version column) must be set to a V value (V1 / V2.3 / V3).
  if (!inMaster) push("fin_master", "fail", "Not found in the Master sheet — add the client and set their V status");
  else if (/v\s*\d/i.test(masterVersion)) push("fin_master", "pass", `V status: ${masterVersion}`);
  else push("fin_master", "fail", masterVersion ? `Status is "${masterVersion}" — should be V1 / V2.3 / V3` : "Version is EMPTY in the Master sheet — set the V status");

  // Pull the sub-account's custom values once: the live funnel URL AND the
  // fill-state of the fields the "Funnel + Reactivation Form" populates.
  // Reuse the same location token for the calendar checks below.
  let depositUrl: string | null = null;
  const customValues: Array<{ name: string; value: string }> = [];
  let locTok: string | undefined;
  if (locationId) {
    locTok = (await getAppLocationToken(locationId)).token;
    if (locTok) {
      const cv = await ghlGet(`${BASE}/locations/${locationId}/customValues`, locTok);
      for (const v of (cv.json.customValues as Array<Record<string, unknown>> | undefined) ?? []) {
        const nm = String(v.name ?? "");
        const val = String(v.value ?? "").trim();
        customValues.push({ name: nm, value: val });
        // Prefer the V3 deposit funnel url; any "deposit funnel url" works.
        if (nm.toLowerCase().includes("deposit funnel url") && val.startsWith("http") && (!depositUrl || nm.toLowerCase().includes("v3"))) depositUrl = val;
      }
    }
  }

  // Custom-values-filled check — the exact fields the "Funnel + Reactivation
  // Form" populates. 🔵 fields are required only for V3 clients; the rest are
  // required for every version (V1 / V2.3 / V3). norm() strips spaces, punctuation
  // and the 🔵/🟢 emoji so the substrings match the live custom-value names.
  if (customValues.length) {
    const ALWAYS = [ // non-🔵 — required for all versions
      "business phone number", "fb business page", "full business address",
      "funnel logo", "ig business page", "offer",
    ];
    const V3_ONLY = [ // 🔵 — required additionally for V3
      "owners name", "business hours", "deposit amount", "deposit funnel url v3",
      "discounted price", "original price", "permanent makeup services",
      "permanent makeup transformation calendar", "when is the first touch", "years in business",
    ];
    // Version: prefer the onboarding form; else the Master sheet's "Version"
    // ("(V3)", "(V2.3)", "(V1)"…) — resolved once above.
    const needed = isV3 ? [...ALWAYS, ...V3_ONLY] : ALWAYS;
    const missing: string[] = [];
    for (const need of needed) {
      const key = norm(need);
      const matches = customValues.filter((v) => norm(v.name).includes(key));
      if (!matches.length || !matches.some((v) => v.value)) missing.push(need);
    }
    const vLabel = versionRaw || "version unknown";
    if (missing.length) push("form_reactivation", "fail", `${vLabel}: ${needed.length - missing.length}/${needed.length} required custom values filled — missing: ${missing.join(", ")}`);
    else push("form_reactivation", "pass", `All ${needed.length} ${vLabel} custom values filled`);

    // Professional formatting of the contact custom values (these render on
    // the funnel, so sloppy formatting is client-facing):
    //   phone   → exactly "(317) 268-5519"
    //   address → "street, city, ST zip" — no periods ("Rd" not "Rd."),
    //             clean comma/space usage.
    const phoneV = customValues.find((v) => /business phone number/i.test(v.name))?.value ?? "";
    const addrV = customValues.find((v) => /full business address/i.test(v.name))?.value ?? "";
    const fmtIssues: string[] = [];
    if (!phoneV) fmtIssues.push("phone is empty");
    else if (!/^\(\d{3}\) \d{3}-\d{4}$/.test(phoneV)) {
      const digits = phoneV.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      fmtIssues.push(`phone "${phoneV}" → should be "${digits.length === 10 ? fmtPhone(phoneV) : "(xxx) xxx-xxxx"}"`);
    }
    if (!addrV) fmtIssues.push("address is empty");
    else {
      const a: string[] = [];
      if (/\./.test(addrV)) a.push(`remove periods ("Rd" not "Rd.")`);
      if (!/^[^,]+, [^,]+, [A-Z]{2} \d{5}(-\d{4})?$/.test(addrV.replace(/\./g, ""))) a.push(`use "street, city, ST zip" (e.g. "10089b Allisonville Rd, Fishers, IN 46038")`);
      if (/\s{2,}/.test(addrV)) a.push("remove double spaces");
      if (/\s,/.test(addrV) || /,(?!\s)/.test(addrV)) a.push("comma then one space");
      if (a.length) fmtIssues.push(`address "${addrV}" → ${a.join("; ")}`);
    }
    if (!fmtIssues.length) push("form_contact_format", "pass", `${phoneV} · ${addrV}`);
    else push("form_contact_format", "fail", fmtIssues.join(" | "));

    // Charm pricing (V3): the funnel prices must NOT be round numbers — they
    // should end in 7 or 9 ($397 / $399 / $349 / $299…), never $400 / $350.
    if (isV3) {
      const priceOf = (re: RegExp) => customValues.find((v) => re.test(v.name))?.value ?? "";
      const origV = priceOf(/original price for brows/i);
      const discV = priceOf(/discounted price for brows/i);
      const priceIssue = (label: string, raw: string): string | null => {
        if (!raw.trim()) return `${label} is empty`;
        const m = raw.replace(/,/g, "").match(/(\d+)(?:\.\d+)?/);
        if (!m) return `${label} "${raw}" has no number in it`;
        const num = parseInt(m[1], 10);
        const last = num % 10;
        if (last === 7 || last === 9) return null;
        // Suggest same-decade charm prices; a fully round number ($400, $350)
        // drops to the decade below ($397/$399, $347/$349).
        const decade = last === 0 ? num - 10 : num - last;
        return `${label} "${raw}" is a round number — use charm pricing like $${decade + 7} or $${decade + 9}`;
      };
      const pIssues = [priceIssue("Original price", origV), priceIssue("Discounted price", discV)].filter(Boolean) as string[];
      if (!pIssues.length) push("funnel_pricing", "pass", `Original ${origV} · Discounted ${discV}`);
      else push("funnel_pricing", "fail", pIssues.join(" | "));
    }
  } else if (locationId) {
    push("form_reactivation", "manual", "Couldn't read the sub-account's custom values");
  }

  // Users are needed by both the user checks AND the calendar-availability
  // check, so fetch them once up front. The location listing doesn't include
  // the permission map, so each user's detail is fetched with the agency
  // token; usersInfo carries the plain-English names of the ON permissions.
  let users: Array<Record<string, unknown>> = [];
  let usersOk = false;
  const usersInfo: UserInfo[] = [];
  const userPerms = new Map<string, Record<string, boolean>>(); // name → permission map
  if (locationId && locTok) {
    const ur = await ghlGet(`${BASE}/users/?locationId=${locationId}`, locTok);
    usersOk = ur.status === 200;
    users = (ur.json.users as Array<Record<string, unknown>> | undefined) ?? [];
    const agency = users.length ? await getAppAgencyToken() : null;
    for (const u of users) {
      const roles = (u.roles ?? {}) as Record<string, unknown>;
      const name = String(u.name ?? u.email ?? "?");
      let perms: Record<string, boolean> = {};
      if (agency) {
        const det = await ghlGet(`${BASE}/users/${String(u.id ?? "")}`, agency.token);
        if (det.ok) perms = (det.json.permissions as Record<string, boolean> | undefined) ?? {};
      }
      if (Object.keys(perms).length) userPerms.set(name, perms);
      usersInfo.push({
        name,
        role: String(roles.role ?? "?"),
        permissions: Object.keys(perms).filter((k) => perms[k] && !PERM_IGNORE.has(k)).map(permLabel).sort(),
      });
    }
  }

  // Calendar checks (we have the calendars scope). Grade the calendar's team
  // members, meeting location, Look-Busy, and that the assigned team member
  // is a real sub-account user (My Staff → User Availability → calendar).
  let activeCalId = "";
  if (locationId && locTok) {
    const cal = await ghlGet(`${BASE}/calendars/?locationId=${locationId}`, locTok);
    const cals = (cal.json.calendars as Array<Record<string, unknown>> | undefined) ?? [];
    if (!cals.length) {
      for (const k of ["cal_team", "cal_location", "cal_lookbusy", "cal_availability"]) push(k, "fail", "No calendar found on the sub-account");
    } else {
      // Prefer the active calendar; else the first.
      const c = cals.find((x) => x.isActive) ?? cals[0];
      activeCalId = String(c.id ?? "");
      const team = (c.teamMembers as Array<Record<string, unknown>> | undefined) ?? [];
      const selected = team.filter((t) => t.selected);
      push("cal_team", selected.length ? "pass" : "fail", selected.length ? `${selected.length} team member(s) selected` : "No team members selected on the calendar");

      const loc = selected.map((t) => String(t.meetingLocation ?? "")).find((v) => v.trim()) ?? String(team[0]?.meetingLocation ?? "");
      const hasAddr = /full_address|address/i.test(loc) || (!!address && loc.includes(address.split(",")[0]));
      push("cal_location", hasAddr ? "pass" : "fail", hasAddr ? `Meeting location set (${loc})` : loc ? `Meeting location = ${loc} — not the full address` : "No meeting location set");

      const lb = (c.lookBusyConfig as Record<string, unknown> | undefined) ?? {};
      const lbOn = !!lb.enabled;
      const lbPct = Number(lb.lookBusyPercentage ?? 0);
      push("cal_lookbusy", lbOn && lbPct === 75 ? "pass" : lbOn ? "fail" : "fail", lbOn ? `Look Busy on at ${lbPct}%${lbPct === 75 ? "" : " (should be 75%)"}` : "Look Busy is off (should be 75%)");

      // Calendar ↔ user connection: every selected team member must be a real
      // sub-account user (proves the user is wired into the calendar settings).
      if (usersOk) {
        const userIds = new Set(users.map((u) => String(u.id ?? "")));
        const connected = selected.filter((t) => userIds.has(String(t.userId ?? "")));
        const orphans = selected.filter((t) => !userIds.has(String(t.userId ?? "")));
        const names = connected.map((t) => String(users.find((u) => String(u.id) === String(t.userId))?.name ?? "?"));
        if (!selected.length) push("cal_availability", "fail", "No team member on the calendar to connect");
        else if (orphans.length) push("cal_availability", "fail", `${orphans.length} calendar team member(s) are not sub-account users — reconnect them in My Staff`);
        else push("cal_availability", "pass", `Calendar connected to user${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
      }
    }
  }

  // Sub-account user, Workflow assign-user, and the AREA custom field —
  // unlocked by the app's v2.0.0 scopes (users/workflows/customFields.readonly).
  if (locationId && locTok) {
    if (usersOk) {
      // User exists?
      push("user_add", users.length ? "pass" : "fail",
        users.length ? `${users.length} user(s): ${users.map((u) => String(u.name ?? u.email ?? "?")).join(", ")}` : "No user on the sub-account");

      // Permissions: every sub-account user must match the SOP template —
      // ONLY the EXPECTED_PERMS_ON set on, everything else off. Reported in
      // plain English (extra ON / missing) instead of raw keys.
      if (users.length) {
        const verdicts: string[] = [];
        let anyBad = false;
        let anyUnknown = false;
        for (const u of usersInfo) {
          const perms = userPerms.get(u.name);
          if (!perms) { anyUnknown = true; verdicts.push(`${u.name}: couldn't read permissions`); continue; }
          const extras = Object.keys(perms).filter((k) => perms[k] && !EXPECTED_PERMS_ON.has(k) && !PERM_IGNORE.has(k)).map(permLabel).sort();
          const missing = [...EXPECTED_PERMS_ON].filter((k) => !perms[k]).map(permLabel).sort();
          if (!extras.length && !missing.length) verdicts.push(`${u.name}: matches the template ✓`);
          else {
            anyBad = true;
            verdicts.push(`${u.name}: ${extras.length ? `should be OFF → ${extras.join(", ")}` : ""}${extras.length && missing.length ? " · " : ""}${missing.length ? `should be ON → ${missing.join(", ")}` : ""}`);
          }
        }
        push("user_permissions", anyBad ? "fail" : anyUnknown ? "manual" : "pass", verdicts.join(" | "));
      }

      // Purchased (LeadConnector) phone number must be local to the business:
      // its area code should match the business address state (or the business
      // phone's area code). lcPhone on the user maps locationId → number.
      const purchased = users
        .map((u) => String(((u.lcPhone ?? {}) as Record<string, unknown>)[locationId] ?? ""))
        .find((v) => v.trim()) ?? "";
      const bizPhone = customValues.find((v) => /business phone number/i.test(v.name))?.value ?? "";
      const fullAddr = address || (customValues.find((v) => /full business address/i.test(v.name))?.value ?? "");
      if (!purchased) push("user_phone", "fail", `No purchased (LeadConnector) number on the sub-account users${fullAddr ? ` · Address: ${fullAddr}` : ""}`);
      else {
        const pac = areaCode(purchased);
        const bac = areaCode(bizPhone);
        const pState = AREA_STATE[pac];
        const addrState = (fullAddr.match(/\b([A-Z]{2})\b[ ,]*\d{5}/) ?? [])[1] ?? "";
        const line = `Purchased: ${fmtPhone(purchased)}${pState ? ` (${pState})` : ""} · Business: ${bizPhone ? fmtPhone(bizPhone) : "—"} · ${fullAddr || "no address on file"}`;
        const localMatch = (!!bac && pac === bac) || (!!pState && !!addrState && pState === addrState) || (!!pState && !!bac && AREA_STATE[bac] === pState);
        if (localMatch) push("user_phone", "pass", line);
        else if (!pState && !addrState && !bac) push("user_phone", "manual", `${line} — couldn't determine the local area code`);
        else push("user_phone", "fail", `${line} — area code ${pac} doesn't look local to the business`);
      }
    }

    // Workflow "CC- Funnel Survey" published + assign-user evidence. The API
    // doesn't expose a workflow's internal steps, so we look at recent
    // contacts: the workflow's first action assigns every lead to a user —
    // assigned contacts prove the step is configured and firing.
    const wr = await ghlGet(`${BASE}/workflows/?locationId=${locationId}`, locTok);
    if (wr.status === 200) {
      const wfs = (wr.json.workflows as Array<Record<string, unknown>> | undefined) ?? [];
      const surveyWf = wfs.find((w) => /funnel\s*survey/i.test(String(w.name ?? "")));
      if (!surveyWf) push("wf_assign", "fail", `"CC- Funnel Survey" workflow not found (${wfs.length} workflows on the account)`);
      else if (String(surveyWf.status) !== "published") push("wf_assign", "fail", `Workflow "${surveyWf.name}" is ${surveyWf.status} — publish it`);
      else {
        const cr = await ghlGet(`${BASE}/contacts/?locationId=${locationId}&limit=20`, locTok);
        const cts = (cr.json.contacts as Array<Record<string, unknown>> | undefined) ?? [];
        const assignedIds = cts.map((c) => String(c.assignedTo ?? "")).filter(Boolean);
        const uname = users.find((u) => assignedIds.includes(String(u.id ?? "")))?.name;
        if (assignedIds.length) push("wf_assign", "pass", `Workflow published · ${assignedIds.length}/${cts.length} recent contacts assigned${uname ? ` to ${uname}` : ""}`);
        else push("wf_assign", "manual", cts.length ? "Workflow is published but no recent contacts are assigned — check its Assign User step" : "Workflow is published; no contacts yet to confirm the assign step");
      }
    }

    // AREA custom field: its options must cover the areas for the services
    // this client offers (services → treated-area mapping below).
    const fr = await ghlGet(`${BASE}/locations/${locationId}/customFields?model=contact`, locTok);
    if (fr.status === 200) {
      const fields = (fr.json.customFields as Array<Record<string, unknown>> | undefined) ?? [];
      const areaField = fields.find((f) => /which\s*area/i.test(String(f.name ?? "")));
      if (!areaField) push("wf_area", "fail", `"CC - Which Area(s) Would You Like Treated?" field not found`);
      else {
        const options = ((areaField.picklistOptions ?? areaField.options ?? []) as unknown[]).map(String).filter(Boolean);
        const AREA_OF: Record<string, string> = {
          "powder brows": "Eyebrows", "microblading": "Eyebrows", "microshading": "Eyebrows",
          "nano brows": "Eyebrows", "combo brows": "Eyebrows", "ombre brows": "Eyebrows",
          "lip blush": "Lips", "eyeliner": "Eyeliner",
          "scalp micropigmentation": "Scalp Micropigmentation",
          "areola micropigmentation": "Areola",
          "scar camouflage": "Scar Camouflage", "tattoo removal": "Tattoo Removal",
        };
        // Services to compare, in order of trust: onboarding form → the V3
        // custom value → the client's signup "PMU Services" on the dashboard
        // (clients_master) — so V2.3/V1 clients get compared too.
        let servicesRaw = String(form.services ?? "").trim();
        if (!servicesRaw) servicesRaw = customValues.find((v) => /permanent makeup services/i.test(v.name))?.value ?? "";
        if (!servicesRaw) servicesRaw = masterServices;
        const svcList = servicesRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const expected = new Set<string>();
        const unmapped: string[] = [];
        for (const s of svcList) {
          const a = AREA_OF[s.toLowerCase()];
          if (a) expected.add(a);
          else unmapped.push(s);
        }
        const optNorm = options.map((o) => o.toLowerCase());
        const missing = [...expected].filter((a) => !optNorm.some((o) => o.includes(a.toLowerCase())));
        const breakdown = `Areas: ${options.join(", ") || "—"}${svcList.length ? ` · Services: ${svcList.join(", ")}` : ""}${unmapped.length ? ` · (no area mapping: ${unmapped.join(", ")})` : ""}`;
        if (!svcList.length) push("wf_area", "manual", `${breakdown} — no services on file to compare`);
        else if (missing.length) push("wf_area", "fail", `${breakdown} — MISSING area option(s): ${missing.join(", ")}`);
        else push("wf_area", "pass", breakdown);
      }
    }
  }

  // Make.com: the Fanbasis_Make.com_GHL scenario must have a ROUTE for this
  // business (each route = filter on name/business/product + an HTTP module
  // posting to that client's GHL webhook). Needs MAKE_API_TOKEN in the env
  // (+ optional MAKE_ZONE, MAKE_SCENARIO_ID); without it the steps stay manual.
  const makeToken = process.env.MAKE_API_TOKEN;
  if (makeToken && locationId && !knownNotV3) {
    try {
      // The token's home zone is unknown, so try each until /organizations
      // answers 200 with data. Diagnostics are collected so a failure explains
      // itself in the panel instead of a generic "not found".
      const zones = process.env.MAKE_ZONE ? [process.env.MAKE_ZONE] : ["us1", "us2", "eu1", "eu2"];
      let zone = zones[0];
      const mk = async (path: string) => {
        const r = await fetch(`https://${zone}.make.com/api/v2${path}`, { headers: { Authorization: `Token ${makeToken}`, Accept: "application/json" } });
        return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
      };
      // Route extraction from a scenario blueprint (router modules carry a
      // `routes` array; each route = filter + modules).
      const extractRoutes = (blueprint: unknown): string[] => {
        const routes: string[] = [];
        const walk = (node: unknown) => {
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (node && typeof node === "object") {
            const n = node as Record<string, unknown>;
            if (Array.isArray(n.routes)) for (const r of n.routes) routes.push(JSON.stringify(r));
            for (const v of Object.values(n)) walk(v);
          }
        };
        walk(blueprint);
        return routes;
      };
      const getRoutes = async (id: string): Promise<{ routes: string[]; status: number }> => {
        const bp = await mk(`/scenarios/${id}/blueprint`);
        const blueprint = ((bp.json.response as Record<string, unknown> | undefined)?.blueprint ?? bp.json) as unknown;
        return { routes: extractRoutes(blueprint), status: bp.status };
      };

      // Find the Fanbasis scenario(s) (zone → org → teams → scenarios) unless
      // pinned by env. Several scenarios can carry "fanbasis" in the name
      // (clones/backups) — use whichever actually has router routes.
      let routes: string[] = [];
      let usedName = "";
      let diag = "";
      const pinned = process.env.MAKE_SCENARIO_ID ?? "";
      if (pinned) {
        const g = await getRoutes(pinned);
        routes = g.routes;
        usedName = `scenario ${pinned}`;
        if (!routes.length) diag = `Pinned scenario ${pinned}: blueprint HTTP ${g.status}, 0 router routes`;
      } else {
        const zoneNotes: string[] = [];
        const seenNames: string[] = [];
        const candidates: Array<{ id: string; name: string }> = [];
        for (const z of zones) {
          zone = z;
          const orgs = await mk(`/organizations`);
          const orgList = (orgs.json.organizations as Array<Record<string, unknown>> | undefined) ?? [];
          zoneNotes.push(`${z}:${orgs.status}${orgs.ok ? `/${orgList.length} org` : ""}`);
          if (!orgs.ok || !orgList.length) continue;
          for (const o of orgList) {
            const teams = await mk(`/teams?organizationId=${o.id}`);
            for (const t of ((teams.json.teams as Array<Record<string, unknown>> | undefined) ?? [])) {
              const sc = await mk(`/scenarios?teamId=${t.id}`);
              for (const s of ((sc.json.scenarios as Array<Record<string, unknown>> | undefined) ?? [])) {
                const nm = String(s.name ?? "");
                seenNames.push(nm);
                if (/fanbasis/i.test(nm)) candidates.push({ id: String(s.id), name: nm });
              }
            }
          }
          break; // the token lives on exactly one zone — stop at the first that answered
        }
        if (!candidates.length) {
          const all401 = zoneNotes.every((n) => /:(401|403)/.test(n));
          diag = all401
            ? `Make token rejected on every zone (${zoneNotes.join(" · ")}) — the token value in Vercel is wrong or lacks organizations:read + teams:read`
            : seenNames.length
              ? `Connected (${zoneNotes.join(" · ")}) but no scenario named *fanbasis* among: ${seenNames.slice(0, 8).join(", ")}${seenNames.length > 8 ? "…" : ""}`
              : `Connected but found no scenarios (${zoneNotes.join(" · ")}) — token may lack teams/scenarios scopes`;
        } else {
          const notes: string[] = [];
          for (const c of candidates.slice(0, 5)) {
            const g = await getRoutes(c.id);
            notes.push(`"${c.name}": ${g.routes.length} routes${g.status !== 200 ? ` (blueprint HTTP ${g.status})` : ""}`);
            if (g.routes.length > routes.length) { routes = g.routes; usedName = c.name; }
          }
          if (!routes.length) diag = `Found ${candidates.length} Fanbasis scenario(s) but none has router routes — ${notes.join(" · ")}`;
        }
      }

      if (!routes.length) {
        for (const k of ["make_http", "make_filter"]) push(k, "manual", diag || "Make scenario not found");
      } else {
        const own = norm(String(form.owner_name ?? ""));
        const route = routes.find((r) => {
          const rn = norm(r);
          return (!!bn && rn.includes(bn)) || (!!productId && r.includes(productId)) || (!!own && rn.includes(own));
        });
        if (!route) {
          push("make_filter", "fail", `No route for "${business}" in "${usedName}" (${routes.length} routes checked)`);
          push("make_http", "fail", "No route → no GHL webhook for this business in Make");
        } else {
          push("make_filter", "pass", `Route found in "${usedName}" (${routes.length} routes total)`);
          if (route.includes(locationId)) push("make_http", "pass", "Route's HTTP module posts to THIS sub-account's GHL webhook");
          else if (/leadconnectorhq\.com\/hooks|gohighlevel/i.test(route)) push("make_http", "manual", "Route has a GHL webhook but couldn't confirm it targets this sub-account");
          else push("make_http", "fail", "Route found but no GHL webhook URL inside it");
        }
      }
    } catch {
      for (const k of ["make_http", "make_filter"]) push(k, "manual", "Make API error — check MAKE_API_TOKEN / MAKE_ZONE");
    }
  } else if (!makeToken && locationId && !knownNotV3) {
    // V3 client but the Make API isn't connected yet — say so explicitly
    // instead of the generic "check manually".
    for (const k of ["make_http", "make_filter"]) push(k, "manual", "Auto-check available — add MAKE_API_TOKEN in Vercel (Make.com → profile → API → token with scenarios:read) to enable it");
  }

  let pagePid: string | null = null;
  let embedApiKey: string | null = null;
  let embedCreator: string | null = null;
  let funnelUrls: FunnelUrls | null = null;
  if (!depositUrl) {
    for (const k of ["ghl_domain", "funnel_domain", "funnel_path", "funnel_product_id", "funnel_redirect", "funnel_map", "ghl_pixel"])
      push(k, "fail", locationId ? "No deposit funnel URL set in the sub-account" : "Couldn't resolve the sub-account");
  } else {
    // Fetch the deposit page and grade the funnel-side steps.
    let html = "";
    let httpOk = false;
    try {
      const r = await fetch(depositUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      httpOk = r.ok; html = await r.text();
    } catch { /* httpOk stays false */ }

    push("ghl_domain", httpOk ? "pass" : "fail", httpOk ? `Domain live: ${depositUrl}` : `Deposit page didn't load (${depositUrl})`);
    push("funnel_domain", httpOk ? "pass" : "fail", httpOk ? "Funnel is on pmu-care.com" : "Funnel domain not resolving");

    // The 4 funnel paths share a base derived from the deposit URL — but some
    // funnels name the deposit page "<slug>-survey-last-step" while the other
    // pages live at "<slug>-survey" / "<slug>-booking" / "<slug>-thank-you"
    // (e.g. Ink Beauty FX). So probe BOTH base candidates (with and without a
    // trailing "-survey") and use whichever URL actually resolves per page.
    const base = depositUrl.replace(/-last-step.*$/, "");
    const bases = [base];
    if (base.endsWith("-survey")) bases.push(base.slice(0, -"-survey".length));
    const live = async (url: string): Promise<boolean> => {
      try { const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } }); return r.ok; }
      catch { return false; }
    };
    const resolvePage = async (suffix: string): Promise<{ url: string; ok: boolean }> => {
      const cands = [...new Set(bases.map((b) => b + suffix))];
      for (const u of cands) if (await live(u)) return { url: u, ok: true };
      return { url: cands[0], ok: false };
    };
    const [surveyR, bookingR, tyR] = [await resolvePage("-survey"), await resolvePage("-booking"), await resolvePage("-thank-you")];
    funnelUrls = { survey: surveyR.url, booking: bookingR.url, lastStep: depositUrl, thankYou: tyR.url };
    const pathResults = [
      `Last-Step ${httpOk ? "✓" : "✗"}`,
      `Survey ${surveyR.ok ? "✓" : "✗"}`,
      `Booking ${bookingR.ok ? "✓" : "✗"}`,
      `Thank ${tyR.ok ? "✓" : "✗"}`,
    ];
    const allPaths = !pathResults.some((p) => p.includes("✗"));
    push("funnel_path", allPaths ? "pass" : "fail", pathResults.join(" · "));

    const pidMatch = html.match(/PRODUCT_ID\s*=\s*['"]([^'"]+)['"]/);
    if (pidMatch) pagePid = pidMatch[1];
    // Also grab the embed's public key + creator so we can mint a live
    // Fanbasis checkout link for this product (shown under the row).
    embedApiKey = html.match(/API_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    embedCreator = html.match(/CREATOR_ID\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    if (!pidMatch) push("funnel_product_id", "fail", "No PRODUCT_ID found on the deposit page");
    else if (productId && pidMatch[1] !== productId) push("funnel_product_id", "fail", `Page PRODUCT_ID ${pidMatch[1]} ≠ onboarding product ${productId}`);
    else push("funnel_product_id", "pass", `PRODUCT_ID ${pidMatch[1]}${productId ? " matches Fanbasis" : ""}`);

    // REDIRECT_URL must be THIS client's own thank-you page — e.g. deposit
    // "browology-plus-last-step" ⇒ redirect should be "browology-plus-thank-you",
    // not a generic "thank-you-873467". It must contain one of the client's
    // funnel slug variants (with or without the "-survey" part) AND "thank-you".
    const slugCands = bases.map((b) => b.split("/").pop() ?? "").filter(Boolean); // e.g. ["ink-beauty-fx-llc-survey", "ink-beauty-fx-llc"]
    const redir = html.match(/REDIRECT_URL\s*=\s*['"]([^'"]+)['"]/);
    const rv = redir ? redir[1] : "";
    const hasTY = /thank-?you/i.test(rv);
    const isClients = slugCands.some((s) => norm(rv).includes(norm(s)));
    if (!redir) push("funnel_redirect", "fail", "No REDIRECT_URL set on the deposit page");
    else if (!hasTY) push("funnel_redirect", "fail", `REDIRECT_URL = ${rv} — not a thank-you page`);
    else if (slugCands.length && !isClients) push("funnel_redirect", "fail", `REDIRECT_URL = ${rv} — points to a generic thank-you, not this client's (${slugCands[slugCands.length - 1]}-thank-you)`);
    else push("funnel_redirect", "pass", `REDIRECT_URL → ${rv}`);

    // Map address: the deposit page must show THIS client's address, not just
    // any map. Compare the street part of the sub-account's "Full Business
    // Address" custom value (fallback: the onboarding form) against the HTML.
    const mapAddr = (customValues.find((v) => /full business address/i.test(v.name))?.value ?? "") || address;
    const mapStreet = mapAddr.split(",")[0].trim();
    const hasMapEmbed = /google\.com\/maps|maps\.googleapis/i.test(html);
    const streetOnPage = !!mapStreet && norm(html).includes(norm(mapStreet));
    if (streetOnPage) push("funnel_map", "pass", `Address on the page matches: ${mapAddr}${hasMapEmbed ? " · map embedded" : ""}`);
    else if (!mapAddr) push("funnel_map", "manual", hasMapEmbed ? "Map embedded, but no address on file to compare against" : "No address on file to compare");
    else push("funnel_map", "fail", `The client's address ("${mapStreet}") is NOT on the deposit page${hasMapEmbed ? " — the map may show the wrong address" : " and no map embed found"}`);

    const hasPixel = /fbq\(|connect\.facebook\.net\/.*fbevents/i.test(html);
    push("ghl_pixel", hasPixel ? "pass" : "fail", hasPixel ? "Facebook pixel present" : "No Facebook pixel on the funnel");

    // Booking page: check the "Lead" conversion code AND the Instagram widget.
    if (funnelUrls) {
      try {
        const br = await fetch(funnelUrls.booking, { headers: { "User-Agent": "Mozilla/5.0" } });
        const bhtml = br.ok ? await br.text() : "";
        // The Lead conversion code must exist EXACTLY ONCE — a second copy
        // (e.g. a bare snippet in the funnel's tracking-code settings PLUS a
        // custom-code element) fires two Lead events per visitor and doubles
        // the ad reporting. GHL embeds the page config as escaped JSON, so the
        // same snippet appears twice in the raw HTML — unescape and dedupe by
        // the code around each call to count DISTINCT snippets, not copies.
        const unesc = bhtml.replace(/\\u003C/gi, "<").replace(/\\n/g, "\n").replace(/\\\//g, "/").replace(/\\'/g, "'").replace(/\\"/g, '"');
        const sigs = new Set<string>();
        for (const m of unesc.matchAll(/fbq\s*\(\s*['"]track['"]\s*,\s*['"]Lead['"]/gi)) {
          const at = m.index ?? 0;
          sigs.add(norm(unesc.slice(Math.max(0, at - 60), at + 30)));
        }
        const leadCount = sigs.size;
        if (!br.ok) push("funnel_lead_pixel", "fail", "Booking page didn't load");
        else if (leadCount === 1) push("funnel_lead_pixel", "pass", "Booking page fires fbq('track','Lead') once");
        else if (leadCount === 0) push("funnel_lead_pixel", "fail", "Booking page is missing the fbq('track','Lead') code");
        else push("funnel_lead_pixel", "fail", `${leadCount} different Lead conversion codes on the booking page — should be ONE (each lead is being counted ${leadCount} times); remove the extra from the page's tracking-code/custom-code settings`);
        // IG widget is OPTIONAL ("only if IG looks good") — detected = pass, else neutral manual.
        const hasIg = /instagram\.com\/embed|instagram-media|lightwidget|snapwidget|elfsight|behold\.so|powr\.io/i.test(bhtml);
        push("funnel_ig_widget", hasIg ? "pass" : "manual",
          hasIg ? "Instagram widget detected on the booking page" : br.ok ? "No Instagram widget on the booking page (optional — add only if IG looks good)" : "Booking page didn't load");

        // Before & After pictures: the booking/deposit pages must carry the
        // CLIENT'S OWN pictures (≥3 besides the IG widget). Client uploads
        // live at assets.cdn.filesafe.space/{locationId}/media/… — the
        // location prefix separates their pictures from template assets.
        if (locationId) {
          const both = (unesc + " " + html).replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
          const picRe = new RegExp(`assets\\.cdn\\.filesafe\\.space/${locationId}/media/[A-Za-z0-9.]+`, "g");
          const pics = new Set(both.match(picRe) ?? []);
          if (pics.size >= 3) push("form_pictures", "pass", `${pics.size} client pictures on the booking/deposit pages${hasIg ? " + Instagram widget" : ""}`);
          else push("form_pictures", "fail", `Only ${pics.size} client picture${pics.size === 1 ? "" : "s"} on the booking/deposit pages — need at least 3 (before/after & studio pictures)`);
        }
      } catch { push("funnel_lead_pixel", "fail", "Couldn't load the booking page to check the Lead code"); }
    }
  }

  // Fanbasis product exists? Prefer the onboarding-form id; else the one the
  // live deposit page is actually using (so a name-only check still works).
  const checkPid = productId || pagePid;
  let checkoutUrl: string | null = null;
  if (!checkPid) push("fanbasis_product", "manual", "No Fanbasis Product ID found (form or page)");
  else {
    try { await listCheckoutTransactions(checkPid); push("fanbasis_product", "pass", `Fanbasis product ${checkPid} exists`); }
    catch (e) { push("fanbasis_product", "fail", `Fanbasis product ${checkPid} not reachable: ${e instanceof Error ? e.message.slice(0, 80) : ""}`); }
    // A live, shareable Fanbasis checkout link for this product (built from the
    // deposit page's own embed config; falls back to null if the page had none).
    checkoutUrl = await getProductCheckoutUrl({ publicApiKey: embedApiKey, creatorId: embedCreator, productId: pagePid ?? checkPid }).catch(() => null);
  }

  // fin_test — automated end-to-end funnel test: every critical component must
  // pass, the live checkout must mint, AND the calendar must actually have
  // open booking slots (a lead could book right now).
  {
    const CRIT: Record<string, string> = {
      ghl_domain: "domain", funnel_path: "funnel paths", funnel_product_id: "PRODUCT_ID",
      funnel_redirect: "redirect", funnel_lead_pixel: "Lead code", ghl_pixel: "pixel",
      fanbasis_product: "Fanbasis product",
    };
    const critFail = checks.filter((c) => c.key in CRIT && c.status === "fail").map((c) => CRIT[c.key]);
    let slots = -1; // -1 = couldn't check
    if (activeCalId && locTok) {
      const now = Date.now();
      const fs = await ghlGet(`${BASE}/calendars/${activeCalId}/free-slots?startDate=${now}&endDate=${now + 14 * 86400 * 1000}`, locTok, "2021-04-15");
      if (fs.ok) {
        slots = 0;
        for (const [k, v] of Object.entries(fs.json)) {
          if (k === "traceId") continue;
          const arr = Array.isArray(v) ? v : (v as Record<string, unknown> | null)?.slots;
          if (Array.isArray(arr)) slots += arr.length;
        }
      }
    }
    if (critFail.length) push("fin_test", "fail", `Not ready — failing: ${critFail.join(", ")}${slots === 0 ? " · no open booking slots" : ""}`);
    else if (slots === 0) push("fin_test", "fail", "Funnel components ✓ but the calendar has NO open booking slots in the next 14 days");
    else if (checkoutUrl && slots > 0) push("fin_test", "pass", `Funnel pages ✓ · product & live checkout ✓ · ${slots} open booking slots in the next 14 days`);
    else push("fin_test", "manual", `Components ✓ but couldn't verify ${!checkoutUrl ? "the live checkout" : "booking slots"} — spot-check by hand`);
  }

  // Every remaining checklist step (external tools we can't reach) → manual, so
  // the report is the COMPLETE list from the sheet, not just the auto-checks.
  // V1 / V2.3 clients skip the V3-only sections entirely (CloseBot, Make.com).
  for (const s of ONBOARDING_STEPS) {
    if (knownNotV3 && (s.v3Only || s.section === "Make.com")) continue;
    if (!checks.some((c) => c.key === s.key)) push(s.key, "manual", "Check manually — no automated verification");
  }

  // Manual steps verified BY HAND (browser-only things like A2P / SMS
  // compliance) — stored per sub-account in onboarding_check_overrides and
  // applied as ✓ with a "verified by hand" note. Only upgrades manual rows;
  // a real auto-fail is never masked.
  if (locationId) {
    const { data: ov } = await svc.from("onboarding_check_overrides").select("check_key,note,verified_by,verified_at").eq("location_id", locationId);
    for (const o of (ov ?? []) as Array<{ check_key: string; note: string | null; verified_by: string | null; verified_at: string }>) {
      const c = checks.find((x) => x.key === o.check_key);
      if (c && c.status === "manual") {
        c.status = "pass";
        c.detail = `Verified by hand${o.verified_by ? ` by ${o.verified_by.split("@")[0]}` : ""} (${new Date(o.verified_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})${o.note ? ` — ${o.note}` : ""}`;
      }
    }
  }

  return { checks, locationId, depositUrl, funnelUrls, productId: checkPid ?? null, checkoutUrl, usersInfo, version: versionRaw };
}
