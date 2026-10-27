// Password convention: FirstnameLastname1212! (e.g. "IvanAndrosov1212!")
export function employeePassword(ownerName: string): string {
  const compact = ownerName.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("").replace(/[^a-zA-Z0-9]/g, "");
  return `${compact}1212!`;
}

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

/* Owner 10/21/2026: the funnel test's lead phone is our own demo number, so
   the AI Agent can prove the first text really arrived (and that the AI
   answers a reply). The number lives in this demo sub-account, which the
   agent must never change. */
export const TEST_LEAD_PHONE = "+1 (760) 733-3106";
export const TEST_LEAD_LOCATION = "asaIf2fxizaCNJ71iywk";

export type RunbookStep = {
  n: number;
  key: string;
  section: string;
  label: string;
  title?: string;            // short step name shown first (filled from STEP_TITLES)
  who: Who;
  badge?: Who;              // what the card shows when it differs from who runs it (First Cycle: the coach clicks, the dashboard moves the deal)
  how?: string;              // one line of context shown under the label
  checklist?: string[];      // onboarding checklist keys this step ticks
  later?: boolean;           // not part of the run (re-run from the AI tab later)
  optional?: boolean;        // not every client needs it — the card offers "Not needed"
  confirm?: boolean;         // the dashboard can do it, but only after a person clicks Approve on the card
  steps?: string[];          // by-hand breakdown for the team (Facebook), shown on the card
  links?: Array<{ label: string; url: string }>;
  batch?: string;            // AI Agent steps on the same screens go out as ONE card (owner 10/21/2026: faster)
};

export const RUNBOOK: RunbookStep[] = [
  // A · Account
  { n: 0, key: "account_check", section: "A · 🏢 Account", who: "api", label: "Check the clean account and clean it if needed", how: "Live check before anything is renamed: no leftover contacts (any found are deleted), the template (snapshot) is loaded, and A2P is approved. The run stops here if the template or A2P is missing." },
  { n: 1, key: "account_take", section: "A · 🏢 Account", who: "api", label: "Take the clean account and rename it to the business name", how: "Only an account still named \"Clean New Account N\" can be taken.", checklist: ["ghl_snapshot"] },
  { n: 2, key: "account_info", section: "A · 🏢 Account", who: "api", label: "Sub-account info: name, email, phone, studio address and time zone", how: "From the client's record. The time zone follows the studio's state (else the phone's area code), so texts and booking times are local.", checklist: ["ghl_info"] },
  { n: 3, key: "account_cvs", section: "A · 🏢 Account", who: "api", label: "Update the sub-account custom values", how: "Uses the client's details from the Clients tab (no form to fill again). Runs once the template is loaded; fills existing values only, and a missing one is flagged red for the team." },
  { n: 4, key: "master_row", section: "A · 🏢 Account", who: "api", label: "Clients Master row: status, version, assigned coach, media buyer" },
  { n: 5, key: "connector", section: "A · 🏢 Account", who: "api", label: "Dashboard connector installed on the account (leads, chats and deposits sync)" },
  // B · Deposit product and payment route
  { n: 6, key: "product", section: "B · 💳 Deposit product & payment route", who: "api", label: "Create the Commas deposit product \"FULL NAME - BUSINESS NAME\" and save the product ID", checklist: ["fanbasis_product"] },
  { n: 7, key: "webhook_url", section: "B · 💳 Deposit product & payment route", who: "mini", label: "Copy the Inbound Webhook URL from the \"FanBasis to GHL workflow\" and paste it on the one-box funnel", how: "The AI Agent reads it in the GHL editor; the dashboard saves it on the one-box funnel (its \"FanBasis to GHL workflow URL\" field, payment routing on) and in \"CC - Fanbasis Webhook URL\"." },
  { n: 8, key: "route_test", section: "B · 💳 Deposit product & payment route", who: "api", label: "Send one test payment through the route", how: "Test contact and deposit row are deleted afterwards." },
  // C · Phone
  { n: 9, key: "phone_buy", batch: "phone", section: "C · 📞 Phone", who: "mini", label: "Pick a local number in the client's area code, check it in Robokiller, buy it, make it the default and delete the previous client's numbers", checklist: ["phone_buy"] },
  { n: 10, key: "phone_a2p", batch: "phone", section: "C · 📞 Phone", who: "mini", label: "Confirm A2P is approved (green)", checklist: ["phone_a2p"] },
  { n: 11, key: "phone_cnam", batch: "phone", section: "C · 📞 Phone", who: "mini", label: "Submit CNAM \"PermanentMakeup\"" },
  { n: 12, key: "phone_optout", batch: "phone", section: "C · 📞 Phone", who: "mini", label: "Phone System → Messaging → Messaging Compliance: opt-out footer, sender info and periodic opt-out all OFF (already off = done)", checklist: ["phone_optout", "phone_sms_adv"] },
  { n: 13, key: "phone_forward", batch: "phone", section: "C · 📞 Phone", who: "mini", label: "Forward calls to the client's own number; connect their Caller ID only if the form says so", checklist: ["phone_forward", "phone_callerid"] },
  // D · GHL user
  { n: 14, key: "user_create", batch: "user", section: "D · 👤 GHL user for the client", who: "mini", label: "Create the employee user with the client's name and email", how: "GHL emails the client an invite.", checklist: ["user_add"] },
  { n: 15, key: "user_password", batch: "user", section: "D · 👤 GHL user for the client", who: "mini", label: "Set the password by the team rule (NAME1212!) and save it to the card", how: "The AI Agent sets it in the user's settings (the API refuses). Never shown in chat or screenshots.", checklist: ["user_password"] },
  { n: 16, key: "user_settings", batch: "user", section: "D · 👤 GHL user for the client", who: "mini", label: "Role \"User\" (not Admin) with only the owner's permission set; call and voicemail settings, \"Forward Calls To\" all options with the new number", checklist: ["user_permissions", "user_voicemail", "user_phone"] },
  { n: 17, key: "user_calendar", batch: "user", section: "D · 👤 GHL user for the client", who: "mini", label: "Calendar access: \"Physical Appointment\" only", checklist: ["user_calendar_physical"] },
  // E · Workflows
  { n: 18, key: "wf_survey", batch: "workflows", section: "E · ⚙️ Workflows", who: "mini", label: "\"CC - Funnel Survey → (V1 / V2 / V3)\": assign the new user, confirm the trigger \"Contact tag added → onebox-survey\"", how: "The missing trigger is what silenced Most Wanted Beauty and Marie.", checklist: ["wf_assign"] },
  { n: 19, key: "wf_notify", batch: "workflows", section: "E · ⚙️ Workflows", who: "mini", label: "\"CC - One-Box Booking → Notify Artist\": artist's number set so she gets booking texts" },
  { n: 20, key: "wf_callkill", batch: "workflows", section: "E · ⚙️ Workflows", who: "mini", label: "Outgoing-call workflow: no \"Remove from Funnel Survey\" step that kills the AI" },
  // Numbered 43 so the steps after it keep their numbers (same as cnam_check's 42); it runs here, last in the workflows batch.
  { n: 43, key: "wf_errors", batch: "workflows", section: "E · ⚙️ Workflows", who: "mini", label: "Every published workflow ends with 0 errors: calendar, custom field, pipeline and stage point to THIS account", how: "The template keeps the old account's calendar, field and pipeline IDs. Brows by Susan (10/25/2026) went live with the confirmation, booking and Invalid→Confirm workflows pointing at nothing — no lead got a single text or confirmation." },
  // F · Calendar
  { n: 21, key: "cal_team", batch: "calendar", section: "F · 📅 Calendar", who: "mini", label: "Team member = the client's login only; meeting location = \"Full address\" ({{location.full_address}})", how: "The merge field follows the sub-account's address, so a later address change updates the calendar by itself.", checklist: ["cal_team", "cal_location"] },
  { n: 22, key: "cal_hours", batch: "calendar", section: "F · 📅 Calendar", who: "mini", label: "Hours and days from the form, on the per-staff schedule screen, in the studio's time zone", how: "Browser only. The API path mangles this screen (Mindy To). The schedule's time zone must match the sub-account's (set from the studio address in step 2); the dashboard sets it to the sub-account's zone as soon as this step finishes, and the last check (step 32) checks again.", checklist: ["cal_availability"] },
  { n: 23, key: "cal_rules", batch: "calendar", section: "F · 📅 Calendar", who: "mini", label: "Booking rules: Look Busy 75%, slot length and buffer per the template", checklist: ["cal_lookbusy"] },
  { n: 24, key: "cal_active", section: "F · 📅 Calendar", who: "api", label: "Switch the calendar on and confirm open time slots load", how: "The snapshot ships the calendar switched off (Sudbury Med Spa, 10/21/2026: the funnel's time picker could not load). The dashboard turns it on via the API and asks GHL for the next 14 days of slots; stops red if none load." },
  { n: 25, key: "cal_id", section: "F · 📅 Calendar", who: "api", label: "Save the calendar ID to \"CC - Permanent Makeup Transformation Calendar ID\"" },
  // G · Funnel
  { n: 26, key: "funnel_create", section: "G · 🧲 Funnel", who: "api", label: "Create the one-box funnel at book.pmu-care.com/<slug> and set \"CC - Deposit Funnel URL (V3)\"", checklist: ["funnel_onebox"] },
  { n: 27, key: "funnel_pixel", section: "G · 🧲 Funnel", who: "api", label: "Pixel: take the Meta pixel ID from the form or the client's old pages and set it on the funnel" },
  { n: 28, key: "funnel_ig", section: "G · 🧲 Funnel", who: "api", label: "Instagram grid: fetch the client's posts from her Instagram link, sort them (results first) and put them on the funnel — no Elfsight", how: "Needs the Instagram link on the form. A private or restricted account can't be fetched; the funnel then shows no Instagram section until it is fixed (Cost per Deposit → client → 📸 panel → Refresh).", checklist: ["funnel_ig_widget"] },
  { n: 29, key: "funnel_redirect", section: "G · 🧲 Funnel", who: "mini", optional: true, label: "If the client had an old funnel: rename it \"-old\" and redirect the ad path to the new one-box, then verify the redirect", how: "Only for clients who already ran ads to an old funnel — otherwise mark it \"Not needed\"." },
  { n: 30, key: "funnel_live", section: "G · 🧲 Funnel", who: "api", label: "Check no client value is empty, then go live", how: "Stops red with the list of empty values (deposit, address, product ID, webhook, calendar ID… prices for V3 only) instead of going live with holes." },
  // H · Last check — the funnel test is the AI Agent's LAST step (owner
  // 10/20/2026); once it passes the team sends the client the logins.
  { n: 31, key: "last_profile", section: "H · ✅ Last check", who: "mini", label: "Profile image, cover photo and description present; flags what's missing", checklist: ["last_profile"] },
  { n: 32, key: "last_check", section: "H · ✅ Last check", who: "api", label: "Final check: the dashboard re-reads the live account and funnel (custom values, Commas product, calendar, sync) and lists anything still off", how: "The same report as the \"Verify setup\" button, run by itself at the end. Anything still off stops the run here (red) until it is fixed and retried — the funnel test only runs on a clean account." },
  // Owner 10/22/2026: the coach tests the funnel by hand (with our demo number) and marks it completed; First Cycle is the coach's click too.
  { n: 33, key: "funnel_test", section: "H · ✅ Last check", who: "team", label: "Test the funnel yourself as a lead, then mark it completed", how: "The last check before the client gets the logins.", checklist: ["fin_test"],
    steps: [`Open the funnel and fill the survey as a lead with our demo number ${TEST_LEAD_PHONE} — pick a time slot, reach the deposit page (do NOT pay)`, `In the client's GHL contacts find the test contact: tag "onebox-survey", first AI text sent within ~2 minutes`, `In the demo sub-account's conversations confirm the text arrived; reply "Yes" and check the client's AI answers`, `Delete the test contact in the client's account, then click "Mark completed"`] },
  // Owner 10/24/2026: CNAM approval takes the carrier days (or gets
  // rejected), so submitting it (step 11) is not "verified" — the team ticks it.
  { n: 42, key: "cnam_check", section: "H · ✅ Last check", who: "team", label: "Verify CNAM \"PermanentMakeup\" is approved, then mark it completed", how: "Step 11 only submits it; the carrier approves (or rejects) it days later.", checklist: ["phone_cnam"],
    steps: ["In the client's GHL: Settings → Phone Numbers → Trust Center → CNAM", "Status Approved with display name \"PermanentMakeup\" → Mark completed", "Rejected → re-submit it (or open a GHL support ticket), mark completed once approved"] },
  { n: 34, key: "first_cycle", section: "H · ✅ Last check", who: "api", badge: "team", confirm: true, label: "Move the client's deal to \"First Cycle\" — the Went-live workflow then texts the client the logins and funnel (3 texts)", how: "Click Approve: the dashboard saves the login email, password and funnel URL on the client's agency contact, moves the deal, and the \"Started stage -> Went live Notification\" workflow sends the welcome texts a few minutes apart. Nobody sends the logins by hand anymore (owner 10/22/2026).", checklist: ["fin_master"] },
  { n: 35, key: "later_hours", section: "H · ✅ Last check", who: "mini", label: "Later, when the client sends new hours: re-run step 22 from the AI tab", later: true },
  // I · Facebook — by hand (owner 10/20/2026): the breakdown the team follows,
  // then marks each step completed on the card. Loom + docs from the sheet.
  { n: 36, key: "fb_bm", section: "I · 📣 Facebook", who: "team", label: "Business Manager and ad account ready", checklist: ["fb_bm_name", "fb_bm_adaccount", "fb_bm_payment", "fb_bm_partner", "fb_bm_invite"],
    steps: ["Business Manager name = the client's name in the Master Google Sheet", "Ad account name = the same name", "Payment method connected on the ad account", "Partner access granted to our 3 BMs (see the guide)", "Team invited to the BM (see the invite guide)"],
    links: [{ label: "Loom", url: "https://www.loom.com/share/672705f2837b4322826f320933ddd376" }, { label: "Partner access guide", url: "https://docs.google.com/document/d/1VpYxHBjgeWT6wmL2FRn1Lb8OHw1RjD6ksLVa7yO6sK0/edit?usp=sharing" }, { label: "Team invite guide", url: "https://docs.google.com/document/d/12Y7G5mlbNwc-XbN9ctgzSthU-hCpSBjWsU7OuwJLwNI/edit?usp=sharing" }] },
  { n: 37, key: "fb_campaign", section: "I · 📣 Facebook", who: "team", label: "Campaign built from the template (left paused)", checklist: ["fb_campaign", "fb_c_new", "fb_c_manual", "fb_c_name", "fb_c_budget"],
    steps: ["New \"Leads\" campaign → Manual Leads Campaign", "Name it like the sheet, e.g. \"Microshading 1 (FU V2)\"", "Daily budget per the client's plan"],
    links: [{ label: "Loom", url: "https://www.loom.com/share/3920ab07ad0f4a8f9e68ef1411e739e3" }] },
  { n: 38, key: "fb_adset", section: "I · 📣 Facebook", who: "team", label: "Ad set: website conversion, PMU For All dataset, Lead event, local audience", checklist: ["fb_as_conversion", "fb_as_dataset", "fb_as_event", "fb_as_audience", "fb_as_location", "fb_as_radius", "fb_as_age", "fb_as_gender", "fb_as_interests", "fb_as_languages"],
    steps: ["Conversion: Website · Dataset: PMU For All · Event: Lead", "Advantage+ audience → switch to original audience options", "Location = the studio address, adjust the radius", "Age 25–60 · Women · no interests · languages per the ad copy"],
    links: [{ label: "Loom", url: "https://www.loom.com/share/879bc4c7a1d541ec9baf8235f590fd5f" }] },
  { n: 39, key: "fb_ad", section: "I · 📣 Facebook", who: "team", label: "Ad: FB + IG account, video, copy, headline, funnel link", checklist: ["fb_ad_name", "fb_ad_accounts", "fb_ad_format", "fb_ad_multi", "fb_ad_video", "fb_ad_copy", "fb_ad_headline", "fb_ad_link"],
    steps: ["Select the client's FB page and IG account", "Single image or video · uncheck Multi-advertiser ads", "Video from the folder (by service) · copy from the doc · headline per the offer", "Paste the one-box funnel link"],
    links: [{ label: "Loom", url: "https://www.loom.com/share/354328b7939a496ab06ff8b6eec22ecc" }, { label: "Videos folder", url: "https://drive.google.com/drive/folders/1SijOuN58F4upfSIGfVbYUXn6mOQ17wGB?usp=drive_link" }, { label: "Ad copy doc", url: "https://docs.google.com/document/d/11h3ob6JleKekycZuIDvkAyY--lz7F869V5Um6rlBsak/edit?usp=sharing" }, { label: "Headlines doc", url: "https://docs.google.com/document/d/154yZyumlQVKoHwwTk4XtZFzCn_JyUDa0pdycJRRerUo/edit?usp=sharing" }] },
  { n: 40, key: "fb_publish", section: "I · 📣 Facebook", who: "owner", label: "Publish and turn the campaign on", checklist: ["fb_ad_publish", "last_publish"] },
  { n: 41, key: "client_connect", section: "I · 📣 Facebook", who: "client", label: "Client connects her Facebook page and Instagram to the sub-account", checklist: ["last_connect"] },
];

/* Short names, shown bold on the setup card; the label stays as the
   description (owner, 10/17/2026: "include the name of every step"). */
const STEP_TITLES: Record<string, string> = {
  account_check: "Check & clean the account", account_take: "Take & rename the account", account_info: "Account info, address & time zone", account_cvs: "Custom values",
  master_row: "Assign team members", connector: "Dashboard connector",
  product: "Commas deposit product", webhook_url: "Payment webhook URL", route_test: "Test payment",
  phone_buy: "Buy the phone number", phone_a2p: "A2P check", phone_cnam: "CNAM", phone_optout: "SMS opt-out off", phone_forward: "Call forwarding",
  user_create: "Create the client's login", user_password: "Set the password", user_settings: "Login permissions & calls", user_calendar: "Login calendar access",
  wf_survey: "Funnel Survey workflow", wf_notify: "Notify Artist workflow", wf_callkill: "Outgoing-call workflow", wf_errors: "All workflows: 0 errors",
  cal_team: "Calendar team & location", cal_hours: "Calendar hours", cal_rules: "Look Busy & booking rules", cal_active: "Calendar on", cal_id: "Calendar ID",
  funnel_create: "Create the one-box funnel", funnel_pixel: "Meta pixel", funnel_ig: "Instagram widget", funnel_redirect: "Old funnel redirect",
  funnel_test: "Test the funnel", funnel_live: "Check values & go live",
  last_profile: "Profile check", last_check: "Final check", first_cycle: "Move to First Cycle", later_hours: "Update hours later",
  fb_bm: "Business Manager", cnam_check: "CNAM approved", fb_campaign: "Campaign", fb_adset: "Ad set", fb_ad: "Ad", fb_publish: "Publish the campaign", client_connect: "Client connects FB & IG",
};
for (const s of RUNBOOK) s.title = STEP_TITLES[s.key];

/* Pre-flight (owner 10/20/2026): everything the run needs must be on the
   card BEFORE Approve, so no step stops for a missing value. What is
   required depends on the version. Shared by the Approve panel (inline
   fill-in) and approveSetup (hard stop). */
export type RequiredField = { key: string; label: string };
const REQUIRED_ALL: RequiredField[] = [
  { key: "business_name", label: "Business name" }, { key: "owner_name", label: "Owner full name" }, { key: "version", label: "Version" },
  { key: "email", label: "Email (the client's login)" }, { key: "phone", label: "Phone" }, { key: "address", label: "Studio address" },
  { key: "business_hours", label: "Business hours (calendar)" }, { key: "deposit_amount", label: "Deposit amount" }, { key: "offer", label: "Offer" },
  { key: "services", label: "PMU services" }, { key: "assigned", label: "Assigned coach" }, { key: "media_buyer", label: "Media buyer" },
  // Owner 10/21/2026: asked up front (Sudbury Med Spa's run stopped at the
  // pixel step). "none" is an answer — the media buyer adds it later.
  { key: "meta_pixel_id", label: "Meta pixel ID (15–16 digits from Events Manager, or type none)" },
];
export const NO_PIXEL_RE = /^(none|no|n\/a|skip|later|not yet|no pixel)/i;
// V3 only (owner 10/20/2026): the prices are the one-box's V3 fields.
const REQUIRED_V3: RequiredField[] = [
  { key: "original_price", label: "Original price" }, { key: "discounted_price", label: "Discounted price" },
  { key: "years_in_business", label: "Years in business" }, { key: "first_touchup", label: "First touch-up timing" },
];
export function requiredFields(version: string | undefined): RequiredField[] {
  return /v3/i.test(String(version ?? "")) ? [...REQUIRED_ALL, ...REQUIRED_V3] : REQUIRED_ALL;
}
export function missingFields(form: Record<string, unknown>): RequiredField[] {
  return requiredFields(String(form.version ?? "")).filter((f) => !String(form[f.key] ?? "").trim());
}
// Worth having, never blocking: shown as a hint on the Approve panel.
export const OPTIONAL_FIELDS: RequiredField[] = [
  { key: "ig_link", label: "Instagram page (for the widget)" }, { key: "fb_link", label: "Facebook page" }, { key: "gmb_link", label: "Google My Business" },
  { key: "old_funnel_url", label: "Old funnel URL (pixel + redirect)" }, { key: "logo_url", label: "Logo" },
  { key: "connect_caller_id", label: "Connect the client's Caller ID? (yes / no)" },
];

/* "Asks you" steps are decided up front at Approve time (owner 10/21/2026:
   "no stops during the onboarding"): ticked → the AI Agent does it like any
   other step; unticked → the step is skipped. Nothing waits in the AI tab. */
export const PREAPPROVABLE = RUNBOOK.filter((s) => s.who === "ask").map((s) => ({ key: s.key, title: s.title ?? s.label, label: s.label }));

export const RUNBOOK_SECTIONS = Array.from(new Set(RUNBOOK.map((s) => s.section)));
export const stepByKey = (key: string): RunbookStep | undefined => RUNBOOK.find((s) => s.key === key);

export const WHO_LABEL: Record<Who, string> = {
  // Owner 2026-10-20: a coach only needs to know "done for you" vs "by hand".
  api: "🤖 AI Agent", mini: "🤖 AI Agent", ask: "🤖 AI Agent · asks you first", owner: "👤 You (owner)", team: "👤 Coach", client: "👤 Client",
};

// ── Run state, stored in onboardings.setup ─────────────────────────────────
export type StepStatus =
  | "todo"           // not started
  | "running"        // the dashboard is on it right now / the AI Agent claimed it
  | "queued"         // waiting for the AI Agent to pick it up
  | "waiting_owner"  // an "Asks you" card is pending in the AI tab
  | "done"
  | "warn"           // done, but something to look at (missing custom values, …)
  | "failed"
  | "skipped"        // a person marked it skipped / done by hand
  | "manual";        // team / client / owner step — ticked on the checklist, not run

export type StepState = {
  status: StepStatus;
  who?: string;              // "Dashboard", "AI Agent", an email
  at?: string;               // ISO
  note?: string;             // one-liner result; several lines allowed
  proposal_id?: string;      // the agent_proposals card (mini / ask steps)
  confirmed_by?: string;     // confirm steps: who clicked Approve on the card
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
  preapproved?: string[];    // "ask" steps approved up front — they run like AI Agent steps
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
      `Set the new number as the DEFAULT (⋮ → Set as default). Then DELETE every other number on this sub-account — they belong to the previous client (the owner's rule: one user, one number). Reload: only the new number is listed, marked Default. Screenshot.`,
      `Report the number you bought in your summary (digits only is fine), and every number you deleted.`,
    ];
    case "phone_a2p": return [
      `Open ${ghl(L, "settings/phone_number")} → Trust Center (A2P / 10DLC). Confirm the brand and campaign are APPROVED (green).`,
      `If anything is pending or rejected, change nothing — status "needs_teammate" and say what it shows. Screenshot the Trust Center status.`,
    ];
    case "phone_cnam": return [
      `Open ${ghl(L, "settings/phone_number")} → Trust Center → CNAM (Caller Name) registration. Register the caller name "PermanentMakeup" for the account's new number.`,
      `If the carrier form asks for anything you don't have, stop with status "needs_teammate" and say exactly what it asks. Screenshot the submitted CNAM request.`,
      `RECYCLED ACCOUNT (owner 10/21/2026): if "Start Registration" is disabled because the business profile already has approved CNAMs under other names, open "View Details" and screenshot the names. First look for an Edit / Update / Delete / Assign-to-number option on those entries; if one lets you set "PermanentMakeup" for the new number, do it and screenshot. If not: open the GoHighLevel support chat (the "?" / Help icon → "Contact Support" / "Chat with us"; use the agency view if the sub-account view has none), start a new conversation and send exactly: "Hi! Sub-account ${biz} (location ID ${L}) has CNAM (caller name) registrations approved under names that belong to previous businesses: <the names>. Please remove / deregister those CNAM registrations from this sub-account's business profile so we can register the caller name 'PermanentMakeup' for its number. Start Registration is currently disabled because of them. Thank you!" You MAY send this one message to GoHighLevel support; it is the task. Screenshot the sent message, then report status "done" with the summary "SUPPORT TICKET: asked GoHighLevel support (chat) to remove the CNAMs <names>; register PermanentMakeup once they confirm". This does not stop the setup.`,
    ];
    case "phone_optout": return [
      `Open ${ghl(L, "settings/phone_number")} → the "Messaging" tab → "Messaging Compliance" (the switches moved here in 2026; there is NO per-number switch and nothing under Additional Settings). Screenshot ("before-1.png").`,
      `Make sure these three are UNCHECKED: "Make SMS compliant by adding an opt out message" (Reply STOP to Unsubscribe), "Make SMS compliant by adding a sender information", and "Enable Periodic Opt-Out". If any is checked, uncheck it and Save; reload and confirm. Screenshot ("after-1.png").`,
      `If all three are ALREADY unchecked (Save stays disabled), that IS the wanted state: change nothing and report status "done" with the summary "opt-out footer already off" — do not stop or ask.`,
    ];
    case "phone_forward": return [
      `Open ${ghl(L, "settings/phone_number")}, open the account's new number → Edit configuration. Set "Forward calls to" = the client's own phone ${clientPhone}. Save.`,
      callerId ? `The form says to connect the client's Caller ID: use "Add Number" → "Add Caller ID / Verified number" with ${clientPhone} — GHL calls or texts a code to the client; if the code is needed, stop with "needs_teammate" and say so.` : `Do NOT connect a Caller ID (the form does not ask for it).`,
      `Reload and confirm the forwarding number stuck. Screenshot.`,
    ];
    case "user_create": return [
      `Open ${ghl(L, "settings/staff")} (Settings → My Staff) → "+ Add Employee".`,
      `First name / last name: "${owner}". Email: ${email}. Password: use a temporary strong one (the next step sets the real one). Role: User. Type: Account. Make sure the user is added to THIS sub-account only.`,
      `Save. GHL emails the client an invite — that is expected. Reload and confirm the user appears in the staff list. Screenshot the list.`,
      `Report the exact email you used in your summary.`,
    ];
    case "user_password": return [
      `Open ${ghl(L, "settings/staff")} and edit the user ${email}. Open the password section (often under "Advanced settings" → Password / Change password).`,
      `Set the password to exactly: ${employeePassword(owner)}  (type it in both fields if there is a confirm box). Save.`,
      `NEVER take a screenshot while the password is visible or typed in a field. Take the screenshot only after saving, with the dialog closed (e.g. the staff list showing ${email}).`,
      `Do not write the password in your summary — just say it was set.`,
    ];
    case "user_settings": return [
      `Open ${ghl(L, "settings/staff")} and edit the user ${email}. Role / user type: "User" (NOT Admin).`,
      `Permissions — turn EVERY module and checkbox OFF except exactly these (owner's list):`,
      `• Contacts: "View & manage contacts" ON (bulk action OFF). • Opportunities: "View & manage opportunities" + "View opportunities lead value" ON (bulk actions, create pipeline OFF). • Conversations: "View & manage conversation" ON. • Calendars: "View Calendars" + "Manage appointments" ON (setup, groups, resources, preferences OFF). • Dashboard: "View dashboard" ON only. • Reputations: "View & manage review" + "View & manage Listings" ON (Reviews AI Agents, GBP OFF). • Marketing: "View & manage marketing" + "View & manage social planner" ON (affiliate, payout, ad manager, prospecting OFF). • Medias: "View & manage media storage" ON. • Integrations: its one checkbox ("View & manage integrations") ON — the client connects her own Facebook/Instagram and Google with it (owner, 10/27/2026).`,
      `Every other module (Settings, Automation/Workflows, Funnels/Websites, Payments, Blogs, Reporting, AI, Forms, Surveys, Communities, Courses, etc.) fully OFF. Integrations is the one exception above — ON.`,
      `Call & Voicemail settings: "Forward Calls To" — set EVERY option (desktop, mobile app, both) to the account's new GHL number; leave voicemail as the default.`,
      `Save, reload, confirm the permissions stuck. Screenshot the permission modules and the call settings.`,
    ];
    case "user_calendar": return [
      `Open ${ghl(L, "settings/staff")} → edit ${email} → User Availability / Calendar access. The user should be able to see the "Physical Appointment" (Permanent Makeup Transformation) calendar only. Save and screenshot.`,
    ];
    case "wf_survey": return [
      `The template keeps its workflows INSIDE FOLDERS (e.g. "CC - Funnel Setup - Take Action Here", "Account Automations - Don't Touch"). Open each folder, or type the name in the workflows search box, before deciding a workflow is missing. Only report it missing after checking every folder.`,
      `Open ${ghl(L, "automation/workflows")} and open the workflow whose name starts "CC - Funnel Survey" (V1 / V2 / V3 variants — the one that is Published).`,
      `Find the "Assign to user" action and set it to ${owner} (${email}). Save and publish.`,
      `Check the triggers: there must be a "Contact Tag" trigger with tag "onebox-survey" (tag added). If it is missing, ADD it (Contact tag added → onebox-survey) and publish. Screenshot the trigger list and the assign step.`,
      // Brows by Susan, 10/25/2026: the tag trigger was there, but its leads fell into "None" and got nothing.
      `Open the If/Else step "(V1 / V2 / V2)" right after "Assign to user" and the branch "Survey (V3)". Its conditions must be: "Workflow trigger is Survey Submitted - (V3)" OR "Tags includes onebox-survey". If the Tags condition is missing, set the AND/OR switch to OR, add the condition Tags → Includes → onebox-survey, Save action, then rename the branch "Survey (V3) / Onebox-Survey". Without it every one-box lead goes to "None" and gets no text at all. Screenshot the branch conditions.`,
      // Owner, 10/24 (Brows by Susan): the Agent saw 2 opportunity errors,
      // called them out of scope and left the workflow in Draft — leads got nothing.
      `The workflow MUST end Published with NO errors — fixing any error GHL shows (the red "Resolve errors" panel / orange dots) is part of this step. The usual one is "Create Or Update Opportunity: Opportunity pipeline not found / Stage not found" (the snapshot kept an old pipeline id): open each such step, choose the pipeline "Booking opportunities" and the stage the Demo (V3) template uses in the same step — open Demo (V3)'s copy of this workflow READ-ONLY to see it, never save anything in Demo; if you cannot see it, use "Very Hot-Lead (Filled Survey)🔥". Save each step, then publish.`,
      `Before you finish, re-open the workflow list and confirm this workflow shows Published and the builder shows 0 errors. If it is still Draft or still has errors, the status is "failed" (never "done") and the summary says which error is left.`,
    ];
    case "wf_errors": return [
      `Open ${ghl(L, "automation/workflows")}. Workflows live INSIDE FOLDERS — open every folder. Go through EVERY workflow whose status is Published (leave Draft ones alone).`,
      `In each one, open the builder and click the error icon in the left toolbar (orange "!" — the "Resolve N errors" panel; a green check means 0 errors). Fix each error with "Open step":`,
      `• "Referenced Calendar does not exist" (a trigger's or step's "In calendar"): choose "Permanent Makeup Transformation" — this account's calendar. Check BOTH triggers when a workflow has two (e.g. "Appointment Status Invalid -> Confirm…": Unconfirmed/New and Invalid).`,
      `• "Referenced Contact Custom Field does not exist": choose the field with the SAME name in this account (e.g. "CC - Reserved Appointment Time (V3)🔵"); keep the value that is there.`,
      `• "Referenced Pipeline / Pipeline Stage does not exist": pipeline "Booking opportunities", and the stage named in the step's title (e.g. "Create Opportunity - Deposit Collected😍" → "Deposit Collected😍"). If the title doesn't say, open Demo (V3)'s copy of the workflow READ-ONLY to see it — never save anything in Demo.`,
      `• "Workflow selection is required" on an "Add to Workflow" step whose target workflow does not exist anywhere in this account (e.g. "Extension - Follow Up Booked (V3)"): delete that ONE step — GHL will not save the workflow otherwise, and every other account skips it.`,
      // Seen 10/25/2026 on Candy / Sudbury and on working accounts (browology): GHL flags them, nothing breaks.
      `• KNOWN HARMLESS — leave them, they do NOT make the step fail: "FanBasis to GHL workflow" → Inbound Webhook "Mapping Reference is required…" (every account shows it; payments still come through), and "Referenced Form does not exist" on "CC- Funnels Setup Form (V2 + V3)" or "CC- Form Submitted - 📸 Update Custom Fields Before & After Pictures" (the client's own setup forms, not lead-facing). List them under "known, left as is".`,
      `• Any other error: do not guess — leave it and report it.`,
      `Save each step (Save trigger / Save action), then Save the workflow; it must stay Published and the panel must say 0 errors. Never change message texts, waits, conditions or other steps.`,
      `Must be checked at least: "CC - Bookings Appointment Confirmation + Reminders", "Customer Booked Appointment - PMU Transformation Calendar (V2 / V3)", "Appointment Status Invalid -> Confirm if \"Fanbasis\" tag in 3 days", "Fanbasis Tag Added - Paid Deposit (V2 / V3)", "FanBasis to GHL workflow", "CC - One-Box Booking -> Notify Artist", "Deposit Follow up Messages 🔔", "CC- Funnel Survey -> (V1 / V2 / V3)".`,
      `Report one line per workflow you fixed ("<workflow>: <what you fixed>") and list the ones already at 0 errors. Status is "failed" (never "done") if any Published workflow still shows an error other than the known harmless ones — name the workflow and the error.`,
    ];
    case "wf_notify": return [
      `Workflows live INSIDE FOLDERS — open each folder or use the workflows search box before deciding one is missing.`,
      `Open ${ghl(L, "automation/workflows")} → the workflow named like "CC - One-Box Booking → Notify Artist" (or "Notify Artist"). Its SMS/notification step must go to the artist's own phone ${clientPhone}. Fix the number if it is a placeholder, save, publish. Screenshot the step.`,
    ];
    case "wf_callkill": return [
      `Workflows live INSIDE FOLDERS — open each folder or use the workflows search box before deciding one is missing.`,
      `Open ${ghl(L, "automation/workflows")} → the outgoing-call workflow (name contains "Outgoing" or "Call"). Make sure there is NO step "Remove from workflow: CC - Funnel Survey" (it kills the AI follow-up). If there is one, DELETE that single step only, save, publish. Screenshot the workflow steps.`,
    ];
    case "cal_team": return [
      `Open ${ghl(L, "settings/calendars")} → the "Permanent Makeup Transformation" (Physical Appointment) calendar → edit.`,
      `Staff & location: ${owner} (${email}) must be the ONLY staff member (remove anyone else). Her meeting location: choose "Full address" so the field shows {{location.full_address}} — do NOT type the address itself. Save changes and screenshot.`,
    ];
    case "cal_hours": return [
      `Open ${ghl(L, "settings/staff")} → edit ${email} → "User Availability" (the per-staff weekly schedule) — NOT the calendar's own availability.`,
      `Set the schedule's Timezone to the SAME zone as Settings → Business Profile → Time Zone (the studio's local time) — never your own or Israel time. Do this even when the form has no hours.`,
      `Set the weekly hours and days from the form: ${hours}. Days not listed are closed. Save.`,
      `Reload the page and confirm the exact values are still there (GHL sometimes drops them). Screenshot before and after.`,
    ];
    case "cal_rules": return [
      `Open ${ghl(L, "settings/calendars")} → "Permanent Makeup Transformation" → edit → Availability / Advanced: set "Look Busy" to 75%. Keep the slot duration and buffer the template has (do not change them unless they are blank). Save, reload, screenshot.`,
    ];
    case "funnel_redirect": return [
      oldFunnel ? `The client's old GHL funnel is ${oldFunnel}. Open ${ghl(L, "funnels-websites/funnels")}, find that funnel's survey page and rename its path by adding "-old" (so the old address stops serving the page).` : `No old funnel is on the form — status "done", summary "skipped: no old funnel", no changes.`,
      oldFunnel ? `Then add a URL Redirect (Sites → URL Redirects) from the OLD path to ${funnel} (301, path only). Save.` : ``,
      oldFunnel ? `Open the old URL in a new tab and confirm it lands on ${funnel}. Screenshot the redirect list and the landing.` : ``,
    ].filter(Boolean);
    case "funnel_test": return [
      `Open ${funnel} in a new tab. Fill the survey as a test lead: name "Setup Test ${new Date().toLocaleDateString("en-US")}", email setup.test.${Date.now()}@pmu-bookings.com, phone ${TEST_LEAD_PHONE} (our own demo number — a real phone, so delivery can be proven). Pick any answers and a time slot; stop at the deposit page (do NOT pay).`,
      `If the time picker says "Couldn't load available times": open ${ghl(L, "calendars")}, find the "Permanent Makeup Transformation" calendar and switch its Active toggle ON (the snapshot ships it inactive), then reload the funnel and pick a slot.`,
      `Confirm the deposit page loads with the Commas checkout box. Screenshot it.`,
      `In GHL open ${ghl(L, "contacts")} and find the test contact. Confirm it has the tag "onebox-survey" and that the "CC - Funnel Survey" workflow fired: Conversations shows the first AI text within ~2 minutes with status sent/delivered (not failed). Screenshot the contact.`,
      `PROVE DELIVERY: open our demo sub-account's conversations ${ghl(TEST_LEAD_LOCATION, "conversations")} (${TEST_LEAD_PHONE} lives there). Find the new incoming text from the client's number and confirm its wording is the funnel's first AI message. Reply there with one word "Yes", wait up to 3 minutes and confirm the client's AI answers back in the client's conversation. Screenshot both sides. ⚠ Change NOTHING in that demo sub-account — no settings, no deletions, no tags; it is only used to receive and reply to the text.`,
      `Back in the client's account, DELETE that test contact (and only it). If a contact "Router Test" (router.test.pmu@example.com) exists from the payment-route test, delete that one too. Report what worked and what did not; status "failed" if the text never reached ${TEST_LEAD_PHONE}.`,
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
/* One plan for several steps on the same screens (owner 10/21/2026: one
   Chrome start and sign-in instead of five). The report must carry one
   "STEP n: done|failed — …" line per step so the card ticks each one. */
export function batchPlan(group: RunbookStep[], f: SetupFacts): string[] {
  const out: string[] = [
    `This card covers ${group.length} steps of the same setup, in order. Do them all in this one session; if one step cannot be done, say so in its STEP line and still do the remaining steps.`,
  ];
  for (const g of group) {
    out.push(`═══ STEP ${g.n} · ${g.title ?? g.label} ═══`);
    for (const line of miniPlan(g, f)) out.push(`[step ${g.n}] ${line}`);
  }
  out.push(`REPORT (required): the FIRST lines of your "steps" array must be one per step, exactly "STEP ${group[0].n}: done — <what you did>" or "STEP ${group[0].n}: failed — <why>" (one line for each of ${group.map((g) => g.n).join(", ")}). Status "done" only if every step is done; otherwise "needs_teammate". Screenshots: at least one per step, named "step${group[0].n}-after.png" etc.`);
  return out;
}

export function miniContext(step: RunbookStep, f: SetupFacts, group: RunbookStep[] = [step]): string {
  const form = f.form;
  const lines = [
    group.length > 1
      ? `New client setup for ${form.business_name ?? ""} — steps ${group[0].n}–${group[group.length - 1].n} of 38 in one go: ${group.map((g) => g.title ?? g.label).join(" · ")}`
      : `New client setup for ${form.business_name ?? ""} — step ${step.n} of 38: ${step.label}`,
    `Owner: ${form.owner_name ?? ""} · email ${form.email ?? "—"} · phone ${form.phone ?? "—"}`,
    `Studio: ${form.address ?? "—"} · hours: ${form.business_hours ?? "—"}`,
    `Services: ${form.services ?? "—"} · version ${form.version ?? "—"}`,
    f.funnelUrl ? `One-box funnel: ${f.funnelUrl}` : "",
    form.ig_link ? `Instagram: ${form.ig_link}` : "",
    "Approved by the owner on the Onboarding card. The dashboard ticks the checklist when this card finishes.",
  ].filter(Boolean);
  return lines.join("\n");
}
