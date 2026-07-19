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
  { key: "ghl_domain", section: "GHL Setup", label: "Connect a verified domain (no subdomain)" },
  { key: "ghl_pixel", section: "GHL Setup", label: "Setup funnel pixel", auto: true },
  // Same underlying check that used to sit in Funnel — the FB pixel "Lead"
  // conversion code on the BOOKING page (funnel step 2); keeps its key.
  { key: "funnel_lead_pixel", section: "GHL Setup", label: "Lead conversion check — fbq('Lead') on the booking page", auto: true },

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
  { key: "form_pictures", section: "Forms & Pictures", label: "Fill \"📸 Before & After Pictures Form\" — folder of our pictures", auto: true },

  // ── Phone setup ──
  { key: "phone_a2p", section: "Phone Setup", label: "Verify A2P" },
  { key: "phone_forward", section: "Phone Setup", label: "Forward calls to the client number" },
  { key: "phone_callerid", section: "Phone Setup", label: "Connect client Caller ID (if they asked)" },
  { key: "phone_sms_adv", section: "Phone Setup", label: "Phone → Advanced Settings → SMS Compliance UNCHECK" },

  // ── Sub-account user ──
  { key: "user_add", section: "Sub-Account User", label: "Add employee", auto: true },
  { key: "user_permissions", section: "Sub-Account User", label: "Permissions", auto: true },
  { key: "user_phone", section: "Sub-Account User", label: "Purchase local phone + \"Forward Calls To\" all options", auto: true },

  // ── Workflow ──
  { key: "wf_assign", section: "Workflow", label: "Update workflow assign-user in \"CC- Funnel Survey → (V1 / V2 / V3)\"", loom: "https://www.loom.com/share/a3aace3e053a43229e30bf79b46421a4" },
  { key: "wf_area", section: "Workflow", label: "Update Custom Values AREA", auto: true },

  // ── Calendar ──
  { key: "cal_team", section: "Calendar", label: "Select team members", loom: "https://www.loom.com/share/7b4f2a1eee3e4bd08cf3b342b3cc0a15", auto: true },
  { key: "cal_location", section: "Calendar", label: "Meeting location: full address", auto: true },
  { key: "cal_availability", section: "Calendar", label: "My Staff → User Availability → choose calendar" },
  { key: "cal_lookbusy", section: "Calendar", label: "Booking rules → Look Busy 75%", auto: true },

  // ── Make.com ──
  { key: "make_http", section: "Make.com", label: "Fanbasis_Make.com_GHL scenario → duplicate HTTP + paste the GHL webhook", loom: "https://www.loom.com/share/898c1fece6b64942af27f3de2f7b8187", auto: true },
  { key: "make_filter", section: "Make.com", label: "Setup a filter: full name + business name + product ID", auto: true },

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
  { key: "fin_test", section: "Finish", label: "Test the funnel and make sure everything works!", loom: "https://www.loom.com/share/b0008321edf34210ba8e05d803710162", auto: true },
  { key: "fin_master", section: "Finish", label: "Update the V status on the PMU dashboard", auto: true },

  // ── Later ──
  { key: "later_calendar", section: "Later", label: "Integrate the client calendar to her GHL account" },
  { key: "later_availability", section: "Later", label: "Set up client availability — hours and days" },
];

export const SECTION_ORDER = Array.from(new Set(ONBOARDING_STEPS.map((s) => s.section)));

// Offer options — stored EXACTLY as selected (the funnel adds its own copy).
export const OFFER_OPTIONS: { label: string; value: string }[] = [
  { label: "$200 OFF", value: "$200 OFF" },
  { label: "$150 OFF", value: "$150 OFF" },
  { label: "$100 OFF", value: "$100 OFF" },
  { label: "Free Consultation", value: "Free Consultation" },
  { label: "Free Consultation + Aftercare Kit", value: "Free Consultation + Aftercare Kit" },
];

// PMU services (multi-select) — the real services from the client roster.
export const SERVICE_OPTIONS: string[] = [
  "Powder Brows",
  "Microblading",
  "Microshading",
  "Nano Brows",
  "Lip Blush",
  "Eyeliner",
  "Scar Camouflage",
  "Scalp Micropigmentation",
  "Tattoo Removal",
  "Areola Micropigmentation",
];

// Form fields captured when creating a new onboarding. `heading` starts a new
// titled section; fields flow inside their section's grid.
export const FORM_FIELDS: { key: string; label: string; required?: boolean; long?: boolean; image?: boolean; heading?: string }[] = [
  { key: "business_name", label: "Business Name", required: true, heading: "👤 Client Details" },
  { key: "owner_name", label: "Owner Full Name", required: true },
  { key: "version", label: "Version", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Location (Full Address)" },
  { key: "original_price", label: "Original Price", heading: "💰 Pricing & Offer" },
  { key: "discounted_price", label: "Discounted Price" },
  { key: "deposit_amount", label: "Deposit Amount" },
  { key: "offer", label: "Offer" },
  { key: "services", label: "Choose all that apply", long: true, heading: "💅 PMU Services" },
  { key: "gmb_link", label: "Google My Business", heading: "🔗 Links" },
  { key: "ig_link", label: "Instagram Page" },
  { key: "fb_link", label: "Facebook Page" },
  { key: "years_in_business", label: "Years in Business", heading: "📘 V3 Details" },
  { key: "business_hours", label: "Business Hours" },
  { key: "first_touchup", label: "When is the first touch-up?" },
  { key: "other_locations", label: "Other Locations" },
  { key: "logo_url", label: "Logo image", image: true, heading: "🖼️ Funnel Logo" },
  { key: "studio_pic_1", label: "Picture 1", image: true, heading: "🏠 Picture of Studio" },
  { key: "studio_pic_2", label: "Picture 2", image: true },
  { key: "studio_pic_3", label: "Picture 3", image: true },
  { key: "eyebrows_ba_1", label: "Photo 1", image: true, heading: "🤨 Eyebrows Before & After" },
  { key: "eyebrows_ba_2", label: "Photo 2", image: true },
  { key: "eyebrows_ba_3", label: "Photo 3", image: true },
  { key: "lipblush_ba_1", label: "Photo 1", image: true, heading: "💋 Lips Before & After" },
  { key: "lipblush_ba_2", label: "Photo 2", image: true },
  { key: "lipblush_ba_3", label: "Photo 3", image: true },
  { key: "eyeliner_ba_1", label: "Photo 1", image: true, heading: "👁️ Eyeliner Before & After" },
  { key: "eyeliner_ba_2", label: "Photo 2", image: true },
  { key: "eyeliner_ba_3", label: "Photo 3", image: true },
];

// Group FORM_FIELDS into titled sections (a field with `heading` starts one).
export function formSections(): { heading: string; fields: typeof FORM_FIELDS }[] {
  const sections: { heading: string; fields: typeof FORM_FIELDS }[] = [];
  for (const f of FORM_FIELDS) {
    if (f.heading || sections.length === 0) sections.push({ heading: f.heading ?? "", fields: [] });
    sections[sections.length - 1].fields.push(f);
  }
  return sections;
}
