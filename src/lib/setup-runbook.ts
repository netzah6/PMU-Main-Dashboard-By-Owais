// The New Client Setup runbook (owner-approved 10/15/2026): the team's
// 59-step Onboarding sheet merged with the dashboard's Claim and Start Setup
// steps, as 38 steps with WHO does each one.
//
//   api   — the dashboard runs it itself (GHL API, Commas, Sheets)
//   mini  — the Mac Mini browser worker does it on the GHL screens (screenshots)
//   ask   — a card the owner must Approve in the AI tab before the Mini does it
//   owner — the owner ticks it on the card (ads on) — no automation yet
//   team  — the team does it by hand (Facebook, until Launch Ads is approved)
//   client— the client does it (connect FB/IG)
//
// Shared by the server (run engine, plan text for the Mini) and the card
// (approval panel, progress). Nothing here talks to GHL.

export type Who = "api" | "mini" | "ask" | "owner" | "team" | "client";

export type RunbookStep = {
  n: number;
  key: string;
  section: string;
  label: string;
  who: Who;
  how?: string;              // one line of context shown under the label
  checklist?: string[];      // onboarding checklist keys this step ticks
  later?: boolean;           // not part of the run (re-run from the AI tab later)
};

export const RUNBOOK: RunbookStep[] = [
  // A · Account
  { n: 1, key: "account_take", section: "A · Account", who: "api", label: "Take the clean account and rename it to the business name", how: "Only an account still named \"Clean New Account N\" can be taken.", checklist: ["ghl_snapshot"] },
  { n: 2, key: "account_info", section: "A · Account", who: "api", label: "Sub-account info: name, email, phone", how: "From the New Client form.", checklist: ["ghl_info"] },
  { n: 3, key: "account_cvs", section: "A · Account", who: "api", label: "Fill every \"CC -\" custom value from the client's record", how: "Uses the client's details from the Clients tab (no form to fill again). Runs once the template is loaded; fills existing values only, and a missing one is flagged red for the team." },
  { n: 4, key: "master_row", section: "A · Account", who: "api", label: "Clients Master row: status, version, assigned coach, media buyer" },
  { n: 5, key: "connector", section: "A · Account", who: "api", label: "Dashboard connector installed on the account (leads, chats and deposits sync)" },
  // B · Deposit product and payment route
  { n: 6, key: "product", section: "B · Deposit product & payment route", who: "api", label: "Create the Commas deposit product \"FULL NAME - BUSINESS NAME\" and save the product ID", checklist: ["fanbasis_product"] },
  { n: 7, key: "webhook_url", section: "B · Deposit product & payment route", who: "mini", label: "Read the payment route link from the \"FanBasis to GHL workflow\" (Inbound Webhook URL)", how: "Only visible in the GHL editor. The dashboard saves it to \"CC - Fanbasis Webhook URL\" and the funnel." },
  { n: 8, key: "route_test", section: "B · Deposit product & payment route", who: "api", label: "Send one test payment through the route", how: "Test contact and deposit row are deleted afterwards." },
  // C · Phone
  { n: 9, key: "phone_buy", section: "C · Phone", who: "ask", label: "Pick a local number in the client's area code, check it in Robokiller, then buy it", checklist: ["phone_buy"] },
  { n: 10, key: "phone_a2p", section: "C · Phone", who: "mini", label: "Confirm A2P is approved (green)", checklist: ["phone_a2p"] },
  { n: 11, key: "phone_cnam", section: "C · Phone", who: "mini", label: "Submit CNAM \"PermanentMakeup\"", checklist: ["phone_cnam"] },
  { n: 12, key: "phone_optout", section: "C · Phone", who: "mini", label: "Uncheck SMS Compliance Opt-Out, and the same switch under Phone → Advanced Settings", checklist: ["phone_optout", "phone_sms_adv"] },
  { n: 13, key: "phone_forward", section: "C · Phone", who: "mini", label: "Forward calls to the client's own number; connect their Caller ID only if the form says so", checklist: ["phone_forward", "phone_callerid"] },
  // D · GHL user
  { n: 14, key: "user_create", section: "D · GHL user for the client", who: "ask", label: "Create the employee user with the client's name and email", how: "GHL emails the client an invite.", checklist: ["user_add"] },
  { n: 15, key: "user_password", section: "D · GHL user for the client", who: "api", label: "Set the password by the team rule (NAME1212!) and save it to the card", how: "Never shown in chat or screenshots.", checklist: ["user_password"] },
  { n: 16, key: "user_settings", section: "D · GHL user for the client", who: "mini", label: "Standard client permission set, call and voicemail settings, \"Forward Calls To\" all options with the new number", checklist: ["user_permissions", "user_voicemail", "user_phone"] },
  { n: 17, key: "user_calendar", section: "D · GHL user for the client", who: "mini", label: "Calendar access: \"Physical Appointment\" only", checklist: ["user_calendar_physical"] },
  // E · Workflows
  { n: 18, key: "wf_survey", section: "E · Workflows", who: "mini", label: "\"CC - Funnel Survey → (V1 / V2 / V3)\": assign the new user, confirm the trigger \"Contact tag added → onebox-survey\"", how: "The missing trigger is what silenced Most Wanted Beauty and Marie.", checklist: ["wf_assign"] },
  { n: 19, key: "wf_notify", section: "E · Workflows", who: "mini", label: "\"CC - One-Box Booking → Notify Artist\": artist's number set so she gets booking texts" },
  { n: 20, key: "wf_callkill", section: "E · Workflows", who: "mini", label: "Outgoing-call workflow: no \"Remove from Funnel Survey\" step that kills the AI" },
  // F · Calendar
  { n: 21, key: "cal_team", section: "F · Calendar", who: "mini", label: "Team member = the new user; meeting location = full studio address", checklist: ["cal_team", "cal_location"] },
  { n: 22, key: "cal_hours", section: "F · Calendar", who: "mini", label: "Hours and days from the form, on the per-staff schedule screen", how: "Browser only. The API path mangles this screen (Mindy To).", checklist: ["cal_availability"] },
  { n: 23, key: "cal_rules", section: "F · Calendar", who: "mini", label: "Booking rules: Look Busy 75%, slot length and buffer per the template", checklist: ["cal_lookbusy"] },
  { n: 24, key: "cal_id", section: "F · Calendar", who: "api", label: "Save the calendar ID to \"CC - Permanent Makeup Transformation Calendar ID\"" },
  // G · Funnel
  { n: 25, key: "funnel_create", section: "G · Funnel", who: "api", label: "Create the one-box funnel at book.pmu-care.com/<slug> and set \"CC - Deposit Funnel URL (V3)\"", checklist: ["funnel_onebox"] },
  { n: 26, key: "funnel_pixel", section: "G · Funnel", who: "api", label: "Pixel: take the Meta pixel ID from the form or the client's old pages and set it on the funnel" },
  { n: 27, key: "funnel_ig", section: "G · Funnel", who: "mini", label: "Instagram widget, only if the IG has 9+ posts and a profile picture; otherwise skipped with a note", checklist: ["funnel_ig_widget"] },
  { n: 28, key: "funnel_redirect", section: "G · Funnel", who: "mini", label: "If the client had an old funnel: rename it \"-old\" and redirect the ad path to the new one-box, then verify the redirect" },
  { n: 29, key: "funnel_test", section: "G · Funnel", who: "mini", label: "Test the funnel as a lead: survey, text arrives, AI replies, deposit page loads; then delete the test contact", checklist: ["fin_test"] },
  { n: 30, key: "funnel_live", section: "G · Funnel", who: "api", label: "Set the version to V3 and go live" },
  // H · Facebook
  { n: 31, key: "fb_bm", section: "H · Facebook", who: "team", label: "Business Manager name, payment method, partner access, invites" },
  { n: 32, key: "fb_campaign", section: "H · Facebook", who: "team", label: "Campaign, ad set and ad built from the template, left paused" },
  { n: 33, key: "fb_publish", section: "H · Facebook", who: "owner", label: "Publish and turn the campaign on", checklist: ["last_publish"] },
  { n: 34, key: "client_connect", section: "H · Facebook", who: "client", label: "Client connects her FB and IG to the account", checklist: ["last_connect"] },
  // I · Last check
  { n: 35, key: "last_profile", section: "I · Last check", who: "mini", label: "Profile image, cover photo and description present; flags what's missing", checklist: ["last_profile"] },
  { n: 36, key: "last_check", section: "I · Last check", who: "api", label: "Check-Setup grade is green: funnel, Commas, sheet, sync" },
  { n: 37, key: "first_cycle", section: "I · Last check", who: "api", label: "Move the client to \"First Cycle\" and text you the summary with the last screenshots", checklist: ["fin_master"] },
  { n: 38, key: "later_hours", section: "I · Last check", who: "mini", label: "Later, when the client sends new hours: re-run step 22 from the AI tab", later: true },
];

export const RUNBOOK_SECTIONS = Array.from(new Set(RUNBOOK.map((s) => s.section)));
export const stepByKey = (key: string): RunbookStep | undefined => RUNBOOK.find((s) => s.key === key);

export const WHO_LABEL: Record<Who, string> = {
  api: "API · dashboard", mini: "Mac Mini · browser", ask: "Asks you first", owner: "You", team: "Team", client: "Client",
};

// ── Run state, stored in onboardings.setup ─────────────────────────────────
export type StepStatus =
  | "todo"           // not started
  | "running"        // the dashboard is on it right now / the Mac Mini claimed it
  | "queued"         // waiting for the Mac Mini to pick it up
  | "waiting_owner"  // an "Asks you" card is pending in the AI tab
  | "done"
  | "warn"           // done, but something to look at (missing custom values, …)
  | "failed"
  | "skipped"        // a person marked it skipped / done by hand
  | "manual";        // team / client / owner step — ticked on the checklist, not run

export type StepState = {
  status: StepStatus;
  who?: string;              // "Dashboard", "Mac Mini", an email
  at?: string;               // ISO
  note?: string;             // one-liner result; several lines allowed
  proposal_id?: string;      // the agent_proposals card (mini / ask steps)
  screenshots?: Array<{ name: string; url: string }>;
  error?: string;
};

export type SetupState = {
  v: 1;
  approved_by: string;
  approved_at: string;
  location_id: string;       // the clean account the run took
  pool_name: string;         // its name before the rename
  status: "running" | "waiting" | "done" | "failed";
  steps: Record<string, StepState>;
  busy_at?: string | null;   // the dashboard is running API steps (lock)
  busy_token?: string | null;
  // Facts the later steps need, gathered as the run goes.
  slug?: string;
  funnel_url?: string;
  product_id?: string;
  checkout_url?: string;
  hook_url?: string;
  user_id?: string;
  password?: string;         // the employee password — only ever shown on the card
  final_text?: string;
  finished_at?: string;
  log: Array<{ at: string; key: string; msg: string }>;
};

// Steps the run itself must finish for the run to count as done. Team,
// client and owner-ticked steps (Facebook) are shown but don't gate it.
export const RUN_WHO = new Set<Who>(["api", "mini", "ask"]);
export const runSteps = () => RUNBOOK.filter((s) => RUN_WHO.has(s.who) && !s.later);

export function stepState(setup: SetupState | null | undefined, key: string): StepState {
  return setup?.steps?.[key] ?? { status: "todo" };
}
export const isSettled = (st: StepState) => st.status === "done" || st.status === "warn" || st.status === "skipped";

// ── Plan text for the Mac Mini ──────────────────────────────────────────────
// What the browser worker is told for each step: exact GHL screens and what
// "done" looks like. The worker runs free-text steps (worker/agent-worker.mjs)
// and always takes before/after screenshots. The form is the New Client form.
export type SetupFacts = {
  locationId: string;
  form: Record<string, string>;
  slug?: string;
  funnelUrl?: string;
  userEmail?: string;
};

const ghl = (loc: string, path: string) => `https://app.gohighlevel.com/v2/location/${loc}/${path}`;

export function miniPlan(step: RunbookStep, f: SetupFacts): string[] {
  const L = f.locationId;
  const biz = f.form.business_name?.trim() || "the client";
  const owner = f.form.owner_name?.trim() || "the client";
  const clientPhone = f.form.phone?.trim() || "(not on the form — ask the team)";
  const address = f.form.address?.trim() || "(not on the form)";
  const hours = f.form.business_hours?.trim() || "(not on the form — leave the schedule as is and report that)";
  const email = f.userEmail || f.form.email?.trim() || "(no email on the form)";
  const funnel = f.funnelUrl || (f.slug ? `https://book.pmu-care.com/${f.slug}` : "(funnel not created yet)");
  const ig = f.form.ig_link?.trim() || "";
  const oldFunnel = f.form.old_funnel_url?.trim() || "";
  const callerId = /yes|true|1/i.test(f.form.connect_caller_id ?? "");
  switch (step.key) {
    case "webhook_url": return [
      `Open the workflows list: ${ghl(L, "automation/workflows")} and open the workflow named "FanBasis to GHL workflow" (it comes from the snapshot).`,
      `Click its trigger "Inbound Webhook" and copy the full Webhook URL shown there (it starts with https://services.leadconnectorhq.com/hooks/${L}/webhook-trigger/).`,
      `Do not change anything in the workflow. Make sure the workflow is Published (toggle top right); if it is in Draft, publish it.`,
      `Report the exact URL in your summary — the dashboard saves it to "CC - Fanbasis Webhook URL" and to the funnel's payment route. Screenshot the trigger panel with the URL visible.`,
    ];
    case "phone_buy": return [
      `Open ${ghl(L, "settings/phone_number")} → "Add Number". Search for a LOCAL number in the client's area code (client phone: ${clientPhone}; studio address: ${address}). If none, the nearest area code in the same state.`,
      `Before buying, open https://lookup.robokiller.com/ in a new tab and look the candidate number up. It must show as clean / not reported. If it is flagged, pick another number and check again.`,
      `Buy the clean number. Screenshot the Robokiller result and the Phone Numbers page showing the new number.`,
      `Report the number you bought in your summary (digits only is fine).`,
    ];
    case "phone_a2p": return [
      `Open ${ghl(L, "settings/phone_number")} → Trust Center (A2P / 10DLC). Confirm the brand and campaign are APPROVED (green).`,
      `If anything is pending or rejected, change nothing — status "needs_teammate" and say what it shows. Screenshot the Trust Center status.`,
    ];
    case "phone_cnam": return [
      `Open ${ghl(L, "settings/phone_number")} → Trust Center → CNAM (Caller Name) registration. Register the caller name "PermanentMakeup" for the account's new number.`,
      `If the carrier form asks for anything you don't have, stop with status "needs_teammate" and say exactly what it asks. Screenshot the submitted CNAM request.`,
    ];
    case "phone_optout": return [
      `Open ${ghl(L, "settings/phone_number")}. Next to the account's number open its settings and UNCHECK "SMS Compliance" / "Opt-Out" (the automatic "Reply STOP to unsubscribe" footer). Save.`,
      `Then open the Advanced Settings tab on the same Phone Numbers page and UNCHECK the SMS Compliance switch there too. Save.`,
      `Reload and confirm both are off. Screenshot both.`,
    ];
    case "phone_forward": return [
      `Open ${ghl(L, "settings/phone_number")}, open the account's new number → Edit configuration. Set "Forward calls to" = the client's own phone ${clientPhone}. Save.`,
      callerId ? `The form says to connect the client's Caller ID: use "Add Number" → "Add Caller ID / Verified number" with ${clientPhone} — GHL calls or texts a code to the client; if the code is needed, stop with "needs_teammate" and say so.` : `Do NOT connect a Caller ID (the form does not ask for it).`,
      `Reload and confirm the forwarding number stuck. Screenshot.`,
    ];
    case "user_create": return [
      `Open ${ghl(L, "settings/staff")} (Settings → My Staff) → "+ Add Employee".`,
      `First name / last name: "${owner}". Email: ${email}. Choose a temporary strong password (the dashboard sets the real one right after you finish). Role: User. Type: Account. Make sure the user is added to THIS sub-account only.`,
      `Save. GHL emails the client an invite — that is expected. Reload and confirm the user appears in the staff list. Screenshot the list.`,
      `Report the exact email you used in your summary.`,
    ];
    case "user_settings": return [
      `Open ${ghl(L, "settings/staff")} and edit the user ${email}.`,
      `Permissions: the standard client set — turn OFF Settings, Workflows/Automations, Funnels/Websites, Marketing, Export payments, Payments, Blogs, Social Planner, Reporting/Agent reporting, Affiliate manager; leave ON Contacts, Conversations, Calendars, Opportunities, Dashboard stats, Online listings off.`,
      `Call & Voicemail settings: "Forward Calls To" — set EVERY option (desktop, mobile app, both) to the account's new GHL number; leave voicemail as the default.`,
      `Save, reload, confirm. Screenshot the permissions tab and the call settings.`,
    ];
    case "user_calendar": return [
      `Open ${ghl(L, "settings/staff")} → edit ${email} → User Availability / Calendar access. The user should be able to see the "Physical Appointment" (Permanent Makeup Transformation) calendar only. Save and screenshot.`,
    ];
    case "wf_survey": return [
      `Open ${ghl(L, "automation/workflows")} and open the workflow whose name starts "CC - Funnel Survey" (V1 / V2 / V3 variants — the one that is Published).`,
      `Find the "Assign to user" action and set it to ${owner} (${email}). Save and publish.`,
      `Check the triggers: there must be a "Contact Tag" trigger with tag "onebox-survey" (tag added). If it is missing, ADD it (Contact tag added → onebox-survey) and publish. Screenshot the trigger list and the assign step.`,
    ];
    case "wf_notify": return [
      `Open ${ghl(L, "automation/workflows")} → the workflow named like "CC - One-Box Booking → Notify Artist" (or "Notify Artist"). Its SMS/notification step must go to the artist's own phone ${clientPhone}. Fix the number if it is a placeholder, save, publish. Screenshot the step.`,
    ];
    case "wf_callkill": return [
      `Open ${ghl(L, "automation/workflows")} → the outgoing-call workflow (name contains "Outgoing" or "Call"). Make sure there is NO step "Remove from workflow: CC - Funnel Survey" (it kills the AI follow-up). If there is one, DELETE that single step only, save, publish. Screenshot the workflow steps.`,
    ];
    case "cal_team": return [
      `Open ${ghl(L, "settings/calendars")} → the "Permanent Makeup Transformation" (Physical Appointment) calendar → edit.`,
      `Team members: add ${owner} (${email}) as the only team member. Meeting location: "${address}". Save and screenshot.`,
    ];
    case "cal_hours": return [
      `Open ${ghl(L, "settings/staff")} → edit ${email} → "User Availability" (the per-staff weekly schedule) — NOT the calendar's own availability.`,
      `Set the weekly hours and days from the form: ${hours}. Days not listed are closed. Save.`,
      `Reload the page and confirm the exact values are still there (GHL sometimes drops them). Screenshot before and after.`,
    ];
    case "cal_rules": return [
      `Open ${ghl(L, "settings/calendars")} → "Permanent Makeup Transformation" → edit → Availability / Advanced: set "Look Busy" to 75%. Keep the slot duration and buffer the template has (do not change them unless they are blank). Save, reload, screenshot.`,
    ];
    case "funnel_ig": return [
      ig ? `Open the client's Instagram ${ig} in a new tab. Count: does it have at least 9 posts AND a profile picture?` : `No Instagram link is on the form — status "done", summary "skipped: no Instagram on the form", no changes.`,
      ig ? `If YES: in the dashboard Funnels tab (https://pmu-main-dashboard-by-owais1.vercel.app/funnels), open ${biz} → Start Setup → Instagram widget, and follow the Elfsight widget steps the team uses (create the widget for ${ig}, paste its ID, Save). If NO: change nothing and report "skipped: IG too thin (N posts / no picture)".` : `Screenshot nothing — just report.`,
      ig ? `Screenshot the booking page ${funnel} showing the widget (or the IG profile showing why it was skipped).` : ``,
    ].filter(Boolean);
    case "funnel_redirect": return [
      oldFunnel ? `The client's old GHL funnel is ${oldFunnel}. Open ${ghl(L, "funnels-websites/funnels")}, find that funnel's survey page and rename its path by adding "-old" (so the old address stops serving the page).` : `No old funnel is on the form — status "done", summary "skipped: no old funnel", no changes.`,
      oldFunnel ? `Then add a URL Redirect (Sites → URL Redirects) from the OLD path to ${funnel} (301, path only). Save.` : ``,
      oldFunnel ? `Open the old URL in a new tab and confirm it lands on ${funnel}. Screenshot the redirect list and the landing.` : ``,
    ].filter(Boolean);
    case "funnel_test": return [
      `Open ${funnel} in a new tab. Fill the survey as a test lead: name "Setup Test ${new Date().toLocaleDateString("en-US")}", email setup.test.${Date.now()}@pmu-bookings.com, phone +1 (929) 555-01${String(Math.floor(Math.random() * 90) + 10)}. Pick any answers and a time slot; stop at the deposit page (do NOT pay).`,
      `Confirm the deposit page loads with the Commas checkout box. Screenshot it.`,
      `In GHL open ${ghl(L, "contacts")} and find the test contact. Confirm it has the tag "onebox-survey" and that the "CC - Funnel Survey" workflow fired (Conversations shows the first AI text within ~2 minutes). Screenshot the contact.`,
      `Then DELETE that test contact (and only it). If a contact "Router Test" (router.test.pmu@example.com) exists from the payment-route test, delete that one too. Report what worked and what did not.`,
    ];
    case "last_profile": return [
      `Open ${ghl(L, "settings/business_info")} (Business Profile). Check: logo/profile image uploaded, business name "${biz}", address "${address}", phone, website/Instagram filled.`,
      `Then open ${funnel} and check the page shows the client's logo and real studio / before-after photos (not the template's stock images).`,
      `Change nothing. Report exactly what is missing (status "done" with the list, or "done" with "all present"). Screenshot both.`,
    ];
    case "later_hours": return [
      `Open ${ghl(L, "settings/staff")} → edit ${email} → User Availability and set the new hours the client sent: ${hours}. Save, reload, confirm, screenshot before and after.`,
    ];
    default: return [step.label];
  }
}

// What the AI tab card shows as the "request" for a setup step.
export function miniContext(step: RunbookStep, f: SetupFacts): string {
  const form = f.form;
  const lines = [
    `New client setup for ${form.business_name ?? ""} — step ${step.n} of 38: ${step.label}`,
    `Owner: ${form.owner_name ?? ""} · email ${form.email ?? "—"} · phone ${form.phone ?? "—"}`,
    `Studio: ${form.address ?? "—"} · hours: ${form.business_hours ?? "—"}`,
    `Services: ${form.services ?? "—"} · version ${form.version ?? "—"}`,
    f.funnelUrl ? `One-box funnel: ${f.funnelUrl}` : "",
    form.ig_link ? `Instagram: ${form.ig_link}` : "",
    "Approved by the owner on the Onboarding card. The dashboard ticks the checklist when this card finishes.",
  ].filter(Boolean);
  return lines.join("\n");
}
