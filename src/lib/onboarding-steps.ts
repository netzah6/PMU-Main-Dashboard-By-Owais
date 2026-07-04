// The client-onboarding checklist (mirrors the team's "Onboarding Fanbasis
// (V2.3 / V3)" sheet). `auto: true` marks steps the agency-token automation
// will perform itself in phase 2; `v3Only` steps are hidden for V2.3 clients.

export type OnboardingStep = {
  key: string;
  section: string;
  label: string;
  loom?: string;
  auto?: boolean;
  v3Only?: boolean;
};

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // ── GHL setup ──
  { key: "ghl_snapshot", section: "GHL Setup", label: "Load the snapshot (mark all)", loom: "https://www.loom.com/share/ecff02b00865488481a80ab5f026f2e0", auto: true },
  { key: "ghl_domain", section: "GHL Setup", label: "Connect a verified domain (no subdomain)" },
  { key: "ghl_pixel", section: "GHL Setup", label: "Setup funnel pixel", auto: true },

  // ── Fanbasis ──
  { key: "fanbasis_product", section: "Fanbasis", label: "Create unique product — FULLNAME + BUSINESS NAME", loom: "https://www.loom.com/share/2e8c0dffd58246b89f1032b68a6d7c5a" },

  // ── Funnel ──
  { key: "funnel_domain", section: "Funnel", label: "Connect the domain to the funnel", loom: "https://www.loom.com/share/2ff84fcffac546d5817d88f019c4f038" },
  { key: "funnel_path", section: "Funnel", label: "Funnel path (Survey, Booking, Last Step, Thank You)" },
  { key: "funnel_product_id", section: "Funnel", label: "Deposit page → update PRODUCT ID", auto: true },
  { key: "funnel_redirect", section: "Funnel", label: "Deposit page → update REDIRECT_URL (thank-you page path)", auto: true },
  { key: "funnel_map", section: "Funnel", label: "Update the map address", auto: true },
  { key: "funnel_ig_widget", section: "Funnel", label: "Instagram widget (ONLY if IG looks good)" },

  // ── Forms & pictures ──
  { key: "form_reactivation", section: "Forms & Pictures", label: "Fill \"🎀 Funnel + Reactivation Form (V2 / V3)\"", loom: "https://www.loom.com/share/151c03b04f7645ff898f615106b1a96c", auto: true },
  { key: "form_pictures", section: "Forms & Pictures", label: "Fill \"📸 Before & After Pictures Form\" — folder of our pictures" },

  // ── Phone setup ──
  { key: "phone_buy", section: "Phone Setup", label: "Buy phone & verify with Robokiller" },
  { key: "phone_a2p", section: "Phone Setup", label: "Verify A2P" },
  { key: "phone_cnam", section: "Phone Setup", label: "Verify CNAM — \"PermanentMakeup\"" },
  { key: "phone_optout", section: "Phone Setup", label: "Uncheck SMS Compliance Opt-Out" },
  { key: "phone_forward", section: "Phone Setup", label: "Forward calls to the client number" },
  { key: "phone_callerid", section: "Phone Setup", label: "Connect client Caller ID (if they asked)" },
  { key: "phone_sms_adv", section: "Phone Setup", label: "Phone → Advanced Settings → SMS Compliance UNCHECK" },

  // ── Sub-account user ──
  { key: "user_add", section: "Sub-Account User", label: "Add employee", auto: true },
  { key: "user_password", section: "Sub-Account User", label: "Set up password: NAME1212!", auto: true },
  { key: "user_permissions", section: "Sub-Account User", label: "Permissions", auto: true },
  { key: "user_voicemail", section: "Sub-Account User", label: "Call & voicemail settings" },
  { key: "user_phone", section: "Sub-Account User", label: "Purchase local phone + \"Forward Calls To\" all options" },

  // ── Workflow ──
  { key: "wf_assign", section: "Workflow", label: "Update workflow assign-user in \"CC- Funnel Survey → (V1 / V2 / V3)\"", loom: "https://www.loom.com/share/a3aace3e053a43229e30bf79b46421a4" },
  { key: "wf_area", section: "Workflow", label: "Update Custom Values AREA", auto: true },
  { key: "wf_pictures", section: "Workflow", label: "Update pictures in the CC- Funnel Survey flow" },

  // ── Calendar ──
  { key: "cal_team", section: "Calendar", label: "Select team members", loom: "https://www.loom.com/share/7b4f2a1eee3e4bd08cf3b342b3cc0a15", auto: true },
  { key: "cal_location", section: "Calendar", label: "Meeting location: full address", auto: true },
  { key: "cal_availability", section: "Calendar", label: "My Staff → User Availability → choose calendar" },
  { key: "cal_lookbusy", section: "Calendar", label: "Booking rules → Look Busy 75%", auto: true },

  // ── Make.com ──
  { key: "make_http", section: "Make.com", label: "Fanbasis_Make.com_GHL scenario → duplicate HTTP + paste the GHL webhook", loom: "https://www.loom.com/share/898c1fece6b64942af27f3de2f7b8187" },
  { key: "make_filter", section: "Make.com", label: "Setup a filter: full name + business name + product ID" },

  // ── Facebook ──
  { key: "fb_campaign", section: "Facebook", label: "Create FB campaign with the new funnel link, named properly (e.g. \"Microshading 1 (FU V2)\")", loom: "https://www.loom.com/share/7589cd8a6c02441481737ba0e1edc737" },

  // ── CloseBot (V3 only) ──
  { key: "cb_source", section: "CloseBot (V3)", label: "App.closebot.com → add sub-account to \"Source\"", loom: "https://www.loom.com/share/58918d812f934a5992fff1a1e9fad7ef", v3Only: true },
  { key: "cb_shutoff", section: "CloseBot (V3)", label: "Turn on \"Bot Auto Shutoff on manual message\"", v3Only: true },
  { key: "cb_override", section: "CloseBot (V3)", label: "Sources → Variables → Override Name → paste FIRSTNAME", v3Only: true },
  { key: "cb_agent", section: "CloseBot (V3)", label: "Agents → connect to \"New AI PMU Flow\"", v3Only: true },
  { key: "cb_tag", section: "CloseBot (V3)", label: "Update tag & communication channel", v3Only: true },
  { key: "cb_restrictions", section: "CloseBot (V3)", label: "Update follow-up restrictions time", v3Only: true },

  // ── Finish ──
  { key: "fin_keys", section: "Finish", label: "Add private integration key + Location ID to the keys sheet" },
  { key: "fin_test", section: "Finish", label: "Test the funnel and make sure everything works!", loom: "https://www.loom.com/share/b0008321edf34210ba8e05d803710162" },
  { key: "fin_master", section: "Finish", label: "Mark the Master Sheet", auto: true },
  { key: "fin_fanbasis_amount", section: "Finish", label: "Update the Fanbasis amount back to the right amount" },

  // ── Later ──
  { key: "later_calendar", section: "Later", label: "Integrate the client calendar to her GHL account" },
  { key: "later_availability", section: "Later", label: "Set up client availability — hours and days" },
];

export const SECTION_ORDER = Array.from(new Set(ONBOARDING_STEPS.map((s) => s.section)));

// Form fields captured when creating a new onboarding.
export const FORM_FIELDS: { key: string; label: string; required?: boolean; long?: boolean }[] = [
  { key: "business_name", label: "Business Name", required: true },
  { key: "owner_name", label: "Owner Full Name", required: true },
  { key: "version", label: "Version (V3 / V2.3)", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Location (Full Address)" },
  { key: "original_price", label: "Original Price" },
  { key: "discounted_price", label: "Discounted Price" },
  { key: "deposit_amount", label: "Deposit Amount" },
  { key: "offer", label: "Offer", long: true },
  { key: "services", label: "PMU Services", long: true },
  { key: "product_id", label: "Fanbasis Product ID" },
  { key: "domain", label: "Domain" },
  { key: "ig_link", label: "IG Page Link" },
  { key: "fb_link", label: "FB Page Link" },
  { key: "area", label: "AREA (custom value)" },
  { key: "assigned", label: "Assigned To" },
  { key: "notes", label: "Notes", long: true },
];
