// The client-onboarding checklist — mirrors the team's "Onboarding" Google
// Sheet (tab "Onboarding", 2026-10-07) step for step, in the sheet's order,
// with its Loom videos (`loom`) and guide links (`doc`). The team ticks each
// step per client here instead of in the sheet. Keys are kept stable where a
// step already existed so the auto-verify (onboarding-verify.ts) still lines
// up. `auto: true` = Verify setup can check it; `v3Only` hides for V1/V2.3.

export type OnboardingStep = {
  key: string;
  section: string;
  label: string;
  loom?: string;
  doc?: string;
  docLabel?: string;
  auto?: boolean;
  v3Only?: boolean;
};

const PHONE_DOC = "https://docs.google.com/document/d/15LulW5omYb8hmz8_Litr_Anv_oomLUZhicc_eaegQDk/edit?usp=sharing";
const USER_DOC = "https://docs.google.com/document/d/16wl7SA-GF15X4SFi3al0ItYXFzk6hwkHNgdEyLMybN8/edit?usp=sharing";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // ── GHL ──
  { key: "ghl_snapshot", section: "GHL Setup", label: "Load the snapshot (mark all)", loom: "https://www.loom.com/share/edb25a040ff2417e9a1226539e9beee8" },
  { key: "ghl_info", section: "GHL Setup", label: "Update sub-account info", loom: "https://www.loom.com/share/250d7617bbcf44f8b0d407be9ba56fab" },

  // ── Commas ──
  { key: "fanbasis_product", section: "Commas", label: "Create unique product — FULLNAME + BUSINESS NAME", loom: "https://www.loom.com/share/fd889e8ef3ae4cd79bcda22c687cffb0", auto: true },

  // ── Instagram ──
  { key: "funnel_ig_widget", section: "Instagram", label: "Instagram widget (ONLY if IG looks good)", loom: "https://www.loom.com/share/74fc3c9434904c41814ab6b6cb422e55", doc: "https://www.loom.com/share/e6acba5abd8d466ca3ce15752fcbd67c", docLabel: "Widget video", auto: true },

  // ── Phone ──
  { key: "phone_buy", section: "Sub-Account Phone Setup", label: "Buy phone & verify with Robokiller", loom: "https://www.loom.com/share/f344465bd65941b9ada429c6ed51c59a", doc: "https://lookup.robokiller.com/", docLabel: "Robokiller" },
  { key: "phone_a2p", section: "Sub-Account Phone Setup", label: "Verify A2P", doc: "https://docs.google.com/document/d/1NcgYSX4kw9GaQG53X33enOOQ3TX6GWZnOWApQgyXRmM/edit?tab=t.0", docLabel: "A2P guide" },
  { key: "phone_cnam", section: "Sub-Account Phone Setup", label: "Verify CNAM — \"PermanentMakeup\"", doc: PHONE_DOC, docLabel: "Phone guide" },
  { key: "phone_optout", section: "Sub-Account Phone Setup", label: "Uncheck SMS Compliance Opt-Out" },
  { key: "phone_forward", section: "Sub-Account Phone Setup", label: "Forward calls to the client number" },
  { key: "phone_callerid", section: "Sub-Account Phone Setup", label: "Connect client Caller ID (if they asked)" },
  { key: "phone_sms_adv", section: "Sub-Account Phone Setup", label: "Phone → Advanced Settings → SMS Compliance UNCHECK" },

  // ── Sub-account user ──
  { key: "user_add", section: "Sub-Account User", label: "Add employee", loom: "https://www.loom.com/share/0913fe2ea8ed4595a633f0e7186b8d02", doc: USER_DOC, docLabel: "User guide", auto: true },
  { key: "user_password", section: "Sub-Account User", label: "Set up password: NAME1212!" },
  { key: "user_permissions", section: "Sub-Account User", label: "Permissions", loom: "https://www.loom.com/share/5b3a0ae392b54b04ade081f25762c0a9", auto: true },
  { key: "user_voicemail", section: "Sub-Account User", label: "Call & voicemail settings" },
  { key: "user_phone", section: "Sub-Account User", label: "Purchase local phone + \"Forward Calls To\" all options", auto: true },
  { key: "user_calendar_physical", section: "Sub-Account User", label: "Calendars setup — \"Physical Appointment\" only" },

  // ── Workflow ──
  { key: "wf_assign", section: "Workflow", label: "Update workflow assign-user in \"CC- Funnel Survey → (V1 / V2 / V3)\"", loom: "https://www.loom.com/share/a3aace3e053a43229e30bf79b46421a4", auto: true },

  // ── Calendar ──
  { key: "cal_team", section: "Calendar", label: "Select team members", loom: "https://www.loom.com/share/7b4f2a1eee3e4bd08cf3b342b3cc0a15", auto: true },
  { key: "cal_location", section: "Calendar", label: "Meeting location: full address", auto: true },
  { key: "cal_availability", section: "Calendar", label: "My Staff → User Availability → choose calendar", auto: true },
  { key: "cal_lookbusy", section: "Calendar", label: "Booking rules → Look Busy 75%", auto: true },

  // ── Funnel ──
  { key: "funnel_onebox", section: "Funnel", label: "Create the one-box funnel", loom: "https://www.loom.com/share/73111c2e020a47c3a99e3c5bd763a517" },
  { key: "fin_test", section: "Funnel", label: "Test the funnel and make sure everything works!", auto: true },

  // ── Facebook campaign ──
  { key: "fb_campaign", section: "Facebook Campaign", label: "Create the FB campaign with the new funnel link, named properly — e.g. \"Microshading 1 (FU V2)\"", loom: "https://www.loom.com/share/7589cd8a6c02441481737ba0e1edc737" },
  { key: "fb_c_new", section: "Facebook Campaign · 1️⃣ Campaign level", label: "Create a new \"Leads\" campaign", loom: "https://www.loom.com/share/3920ab07ad0f4a8f9e68ef1411e739e3" },
  { key: "fb_c_manual", section: "Facebook Campaign · 1️⃣ Campaign level", label: "Choose: Manual Leads Campaign" },
  { key: "fb_c_name", section: "Facebook Campaign · 1️⃣ Campaign level", label: "Name: Ad Shark (FU)" },
  { key: "fb_c_budget", section: "Facebook Campaign · 1️⃣ Campaign level", label: "Daily budget (depends on the client's need)" },
  { key: "fb_as_conversion", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Conversion: Website", loom: "https://www.loom.com/share/879bc4c7a1d541ec9baf8235f590fd5f" },
  { key: "fb_as_dataset", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Dataset: PMU For All" },
  { key: "fb_as_event", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Conversion event: Lead (PMU For All must be connected)" },
  { key: "fb_as_audience", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Advantage+ audience → switch to original audience options" },
  { key: "fb_as_location", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Location → choose the right business address" },
  { key: "fb_as_radius", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Adjust the radius" },
  { key: "fb_as_age", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Targeting age → 25–60" },
  { key: "fb_as_gender", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Gender: Women" },
  { key: "fb_as_interests", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Targeting: empty interests" },
  { key: "fb_as_languages", section: "Facebook Campaign · 2️⃣ Ad set level", label: "Languages: fill according to the message" },
  { key: "fb_ad_name", section: "Facebook Campaign · 3️⃣ Ad level", label: "Ad name", loom: "https://www.loom.com/share/354328b7939a496ab06ff8b6eec22ecc" },
  { key: "fb_ad_accounts", section: "Facebook Campaign · 3️⃣ Ad level", label: "Select FB & IG account" },
  { key: "fb_ad_format", section: "Facebook Campaign · 3️⃣ Ad level", label: "Format: single image or video" },
  { key: "fb_ad_multi", section: "Facebook Campaign · 3️⃣ Ad level", label: "Uncheck: Multi-advertiser ads" },
  { key: "fb_ad_video", section: "Facebook Campaign · 3️⃣ Ad level", label: "Choose video — depends on their services", doc: "https://drive.google.com/drive/folders/1SijOuN58F4upfSIGfVbYUXn6mOQ17wGB?usp=drive_link", docLabel: "Videos folder" },
  { key: "fb_ad_copy", section: "Facebook Campaign · 3️⃣ Ad level", label: "Ad copy", doc: "https://docs.google.com/document/d/11h3ob6JleKekycZuIDvkAyY--lz7F869V5Um6rlBsak/edit?usp=sharing", docLabel: "Ad copy doc" },
  { key: "fb_ad_headline", section: "Facebook Campaign · 3️⃣ Ad level", label: "Headline (according to the offer)", doc: "https://docs.google.com/document/d/154yZyumlQVKoHwwTk4XtZFzCn_JyUDa0pdycJRRerUo/edit?usp=sharing", docLabel: "Headlines doc" },
  { key: "fb_ad_link", section: "Facebook Campaign · 3️⃣ Ad level", label: "Paste the funnel link" },
  { key: "fb_ad_publish", section: "Facebook Campaign · 3️⃣ Ad level", label: "PUBLISH" },

  // ── Facebook Business Manager ──
  { key: "fb_bm_name", section: "Facebook BM", label: "Make the BM name the same as the Master Google Sheet", loom: "https://www.loom.com/share/672705f2837b4322826f320933ddd376" },
  { key: "fb_bm_adaccount", section: "Facebook BM", label: "Make the ad account name the same as the Master Google Sheet" },
  { key: "fb_bm_payment", section: "Facebook BM", label: "Payment method connected on the ad account" },
  { key: "fb_bm_partner", section: "Facebook BM", label: "Partner access to our 3 BMs", doc: "https://docs.google.com/document/d/1VpYxHBjgeWT6wmL2FRn1Lb8OHw1RjD6ksLVa7yO6sK0/edit?usp=sharing", docLabel: "Guide" },
  { key: "fb_bm_invite", section: "Facebook BM", label: "Invite the team to the BM", doc: "https://docs.google.com/document/d/12Y7G5mlbNwc-XbN9ctgzSthU-hCpSBjWsU7OuwJLwNI/edit?usp=sharing", docLabel: "Guide" },

  // ── Last checking ──
  { key: "last_profile", section: "Last Checking", label: "Profile image, cover photo & description done?" },
  { key: "last_connect", section: "Last Checking", label: "Help the client connect their FB & IG" },
  { key: "last_publish", section: "Last Checking", label: "PUBLISH & TURN ON THE CAMPAIGN" },
  { key: "fin_master", section: "Last Checking", label: "Move to: ✅ First Cycle stage", auto: true },

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
