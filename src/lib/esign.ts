// E-signature agreements (owner request 11/26/2026): the sales team builds a
// client agreement by changing ONLY the numbers, gets a signing link in one
// click, and the client signs on our own /sign/<token> page — replacing the
// Canva → PDF → Go High Level upload.
//
// Two fixed templates. The wording is the owner's, copied verbatim (typos
// included) from the latest Canva exports:
//   Standard  = "Scope Of Service 2026 (23).pdf"
//   PPA       = "Scope Of Service 2026 (22).pdf" (matches the live GHL template)
// with ONE owner-ordered change in PPA: the "90 days" wording in the first
// paragraph is removed.
//
// The numbers that changed between client exports (7..23) are {{placeholders}};
// everything else is locked. Admins may override the wording (app_settings),
// but an override is only accepted when every placeholder survives.
//
// This file is shared by the dashboard (live preview), the public signing
// page and the server — keep it free of server-only imports.

import { type Agreement, type Block, parseAgreement, agreementToText } from "@/lib/agreement";

export type EsignTemplateId = "standard" | "ppa";
export const TEMPLATE_IDS: EsignTemplateId[] = ["standard", "ppa"];
export const TEMPLATE_LABELS: Record<EsignTemplateId, string> = {
  standard: "Standard program",
  ppa: "Pay Per Appointment",
};

export type FieldType = "money" | "number" | "range" | "days" | "choice";
export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  default: string | number;
  hint?: string;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  /** Full-width input (long option labels). */
  wide?: boolean;
  /** Only shown / used when another field has this value. */
  showIf?: { key: string; value: string };
  /** Label that follows another field's value (e.g. "Price" per payment plan). */
  labelBy?: { key: string; labels: Record<string, string> };
};
export type FieldValues = Record<string, string | number>;

export const TEMPLATE_FIELDS: Record<EsignTemplateId, FieldDef[]> = {
  standard: [
    // (23) "150 + 60 days", (11–19) "90 days", (10) "5 + 2 extra months".
    { key: "program_length", label: "Program length", type: "days", default: "150 + 60", hint: "Like 90, or 150 + 60" },
    {
      key: "program_unit", label: "Program length unit", type: "choice", default: "days",
      options: [{ value: "days", label: "Days" }, { value: "months", label: "Months" }],
    },
    {
      key: "payment_plan", label: "How they pay", type: "choice", default: "upfront", wide: true,
      options: [
        { value: "upfront", label: "All upfront" },
        { value: "two", label: "2 payments (half now, half in 30 days)" },
        { value: "monthly", label: "Every month" },
        { value: "split", label: "Split in monthly payments" },
      ],
    },
    {
      key: "price", label: "Total price", type: "money", default: 3985, min: 1, max: 50000,
      labelBy: { key: "payment_plan", labels: { upfront: "Total price", two: "Total price (both payments)", monthly: "Price per month", split: "Amount of each payment" } },
    },
    { key: "payments", label: "Number of payments", type: "number", default: 3, min: 2, max: 12, showIf: { key: "payment_plan", value: "split" } },
    { key: "ad_spend", label: "Ad spend per month ($)", type: "range", default: "300-600", hint: "Like 300-600", min: 1, max: 20000 },
    { key: "guarantee_bookings", label: "Guaranteed bookings", type: "number", default: 75, min: 1, max: 1000 },
    { key: "guarantee_length", label: "Guarantee time", type: "number", default: 7, min: 1, max: 730 },
    {
      key: "guarantee_unit", label: "Guarantee time unit", type: "choice", default: "months",
      options: [{ value: "months", label: "Months" }, { value: "days", label: "Days" }],
    },
    // (11–23) "5 strikes", (10) "10 strikes".
    { key: "strikes", label: "Strikes before guarantee is void", type: "number", default: 5, min: 1, max: 50 },
  ],
  ppa: [
    { key: "fee", label: "Our fee per booking", type: "money", default: 65, min: 1, max: 1000 },
    { key: "deposit", label: "Client deposit", type: "money", default: 50, min: 1, max: 1000 },
    { key: "ad_spend", label: "Ad spend per month ($)", type: "range", default: "300-600", hint: "Like 300-600", min: 1, max: 20000 },
  ],
};

/** The placeholders each template must contain (an admin override that drops
 *  one is refused — the numbers would silently stop showing). */
export const REQUIRED_PLACEHOLDERS: Record<EsignTemplateId, string[]> = {
  standard: ["program_length", "price_terms", "ad_spend", "guarantee_bookings", "guarantee_period", "strikes"],
  ppa: ["fee", "deposit", "total", "ad_spend"],
};

const TITLE = "PMU Bookings On Demand Partner Program Scope Service";
const FOOTER = "PMU Bookings On Demand Partner Scope of Service";

// Shared sections, word for word the same in both exports.
const INTRO: Block[] = [
  { type: "paragraph", text: "This scope service is made by PMU Bookings On Demand and the partner." },
  { type: "heading", text: "What is the PMU Bookings On Demand program?" },
];
const AFTER_INTRO: Block[] = [
  { type: "paragraph", text: "This program is the first step in bringing your business a consistent flow of high-quality leads which you can convert into paying customers." },
  { type: "heading", text: "This Program Includes:" },
  { type: "bullets", items: [
    "Creation, design & optimization of ads.",
    "Automated smart AI robot.",
    "Access to PMU Bookings On Demand’s CRM.",
    "Access to the Instagram Booster to increase authority and social proof.",
    "Bi-Weekly Strategy Call.",
    "Proven Resources and calling scripts.",
    "Social Media Viral kit.",
  ] },
  { type: "heading", text: "This Program Does Not Include:" },
  { type: "bullets", items: [
    "Lead follow-up (you will need to follow-up with the leads)",
    "Ad comment monitoring: We do not monitor comments on the ads connected with the Facebook page",
  ] },
  { type: "paragraph", text: "After you've signed the scope service and finish the onboarding process properly, you will be able to book your launch call. After the launch call - ads will go live." },
  { type: "heading", text: "How Does Pricing Work For This Program?" },
];
const CHARGEBACK: Block = { type: "paragraph", text: "Client agrees not to initiate a chargeback during the Term. All payments made by Clients are non-refundable. Client further agrees that it will be responsible for any feesand costs incurred by PMU Bookings On Demand responding to any chargeback." };
const AD_COST = "PMU Bookings On Demand will NOT cover the cost of ad spend for advertising or any other ancillary costs to external platforms such as Facebook (Meta), Google, Youtube, Tik Tok, or any advertising platform. Client understands that this will have a separate cost that is paid directly to those platforms.";
const CLOSING: Block[] = [
  { type: "heading", text: "Liability Waiver" },
  { type: "paragraph", text: "The partner understands that establishing a digital presence and creating a two-way flow of communication between themselves & the public can have positive & negative outcomes on their reputation." },
  { type: "paragraph", text: "Should either outcome occur, the partner understands and accept that they waive their right to hold PMU Bookings On Demand responsible for any damage/liability that may arise from the work/services PMU Bookings On Demand provides." },
  { type: "paragraph", text: "The partner understands that if at any time they disagree with an action taken by PMU Bookings On Demand, they must notify PMU Bookings On Demand via a written notice." },
  { type: "heading", text: "Setting Expectations" },
  { type: "paragraph", text: "Being a PMU artist is HARD and very COMPETITIVE. It is your responsibility to convert the leads into closings. It’s best if you use the training and script provided by PMU Bookings On Demand." },
  { type: "paragraph", text: "This scope service will be governed by the laws of the State of Wyoming.\nBy signing this document below, you hereby ratify your understanding of these terms." },
  { type: "signature" },
];

export const DEFAULT_TEMPLATES: Record<EsignTemplateId, Agreement> = {
  standard: {
    title: TITLE,
    footer: FOOTER,
    blocks: [
      ...INTRO,
      { type: "paragraph", text: "The program is a {{program_length}} program where PMU Bookings On Demand will create, optimize, manage, and scale your paid traffic (Facebook & Instagram) permanent makeup campaign." },
      ...AFTER_INTRO,
      { type: "paragraph", text: "The partner will pay {{price_terms}} to PMU Bookings On Demand and {{ad_spend}}/mo which will be allocated to the ad spend." },
      { type: "paragraph", text: "Once completed the partner will decide if they wish to renew and credit card will automatically be charged for the next month, if they wish to cancel please inform us 72 hours in advance. Please note that a mandatory 30-minute exit interview is required to process the cancellation.\nThe partner may also decide to increase their ad-spend in the future." },
      CHARGEBACK,
      { type: "heading", text: "How Does The Leads Guarantee Work?" },
      { type: "paragraph", text: "PMU Bookings On Demand guarantees to provide the partner with at least {{guarantee_bookings}} bookings {{guarantee_period}}." },
      { type: "paragraph", text: "“Booking” definition - a person who went through the entire Facebook ad process filled the full name, email, phone number and click submit and booked an appointment, until the session is completed - if the client books a session and didn't show up it won't be counted as a booking." },
      { type: "paragraph", text: "In the unlikely event that PMU Bookings On Demand is unable to fulfill the guaranteed bookings, PMU Bookings On Demand will continue working at no additional service fee until the goal is met." },
      { type: "heading", text: "Contingencies" },
      { type: "numbered", items: [
        "Since PMU Bookings On Demand can only guarantee results by using a proven system, the partner has to use PMU Bookings On Demand’s proven system ads.\nThe partner is not allowed to modify or change the ads.\nAny modifications asked or made by the partner will void both the bookings guarantee.",
        "The partner must allocate at least {{ad_spend}}/month for the ad spent. If the partner disagrees to invest for the ad spend, PMU Bookings On Demand cannot guarantee results.",
        "When the partner receives a new lead in PMU Bookings On Demand’s CRM, the partner must calling the lead within 24 business hours otherwise the partner will get a strike, {{strikes}} strikes and the guarantee is voided.\nNot all leads answer on the first call. If a lead didn’t answer the partner’s calls, the partner must keep calling the lead at least 2 times in a row, otherwise the partner will get a strike. {{strikes}} strikes and the guarantee is voided. If PMU Bookings On Demand won’t",
        "PMU Bookings On Demand will be able to document the partner’s growth process from A-Z through videos and photos.",
        AD_COST,
      ] },
      { type: "heading", text: "Exclusivity" },
      { type: "paragraph", text: "All the leads generated for the partner are generated exclusively for them, and will not be shared with other partners. 100k population will be exclusive within 10-50 miles away." },
      ...CLOSING,
    ],
  },
  ppa: {
    title: TITLE,
    footer: FOOTER,
    blocks: [
      ...INTRO,
      // Owner rule (11/26/2026): the "90 days" wording is removed in PPA.
      // Was: "The program is a 90 days program where PMU Bookings On Demand will create, …"
      { type: "paragraph", text: "In this program, PMU Bookings On Demand will create, optimize, manage, and scale your paid traffic (Facebook & Instagram) permanent makeup campaign." },
      ...AFTER_INTRO,
      { type: "paragraph", text: "The partner will pay {{fee}} service fee to PMU Bookings On Demand for each client that PMU Bookings On Demand book for the partner on the calendar with a deposit + {{deposit}} deposit directly from the clients on the partner behalf (total of {{total}}) and {{ad_spend}}/mo which will be allocated to the ad spend." },
      { type: "paragraph", text: "“Booking” Definition: A booking is a person who completes the entire social media booking process, including submitting their full name, email address, and phone number, and successfully booking an appointment.\nA booking is considered valid only if the client completes the scheduled session. If a client books an appointment but does not show up, it will not be counted as a booking, and PMU Bookings On Demand will not charge the {{fee}} service fee." },
      { type: "paragraph", text: "If the partner wish to cancel please inform us 72 hours in advance. Please note that a mandatory 30-minute exit interview is required to process the cancellation.\nThe partner may also decide to increase their ad-spend in the future." },
      CHARGEBACK,
      { type: "heading", text: "Contingencies" },
      { type: "numbered", items: [
        "The partner is not allowed to modify or change the ads.\nAny modifications asked or made by the partner will void both the bookings guarantee.",
        "The partner must allocate at least {{ad_spend}}/month for the ad spent. If the partner disagrees to invest for the ad spend, PMU Bookings On Demand cannot guarantee results.",
        "PMU Bookings On Demand will be able to document the partner’s growth process from A-Z through videos and photos",
        AD_COST,
      ] },
      ...CLOSING,
    ],
  },
};

export function defaultFields(t: EsignTemplateId): FieldValues {
  const out: FieldValues = {};
  for (const f of TEMPLATE_FIELDS[t]) out[f.key] = f.default;
  return out;
}

export function money(n: number): string {
  const whole = Number.isInteger(n);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

// Only "+" between numbers: one program length is always chosen (the old
// "90 / 150 + 60" pick-one draft wording can't reach a signed contract).
const DAYS_RE = /^\d{1,3}(\s*\+\s*\d{1,3}){0,3}$/;

/** The label to show for a field, given the current values. */
export function fieldLabel(f: FieldDef, values: Record<string, unknown>): string {
  if (!f.labelBy) return f.label;
  const other = TEMPLATE_FIELDS_LOOKUP(f.labelBy.key);
  const v = String(values?.[f.labelBy.key] ?? other?.default ?? "");
  return f.labelBy.labels[v] ?? f.label;
}
function TEMPLATE_FIELDS_LOOKUP(key: string): FieldDef | undefined {
  for (const t of TEMPLATE_IDS) { const f = TEMPLATE_FIELDS[t].find((x) => x.key === key); if (f) return f; }
  return undefined;
}

/** True when a field's showIf condition does not hold (hidden in the form). */
function isHidden(t: EsignTemplateId, f: FieldDef, raw: Record<string, unknown>): boolean {
  if (!f.showIf) return false;
  const dep = TEMPLATE_FIELDS[t].find((x) => x.key === f.showIf!.key);
  return String(raw?.[f.showIf.key] ?? dep?.default ?? "").trim() !== f.showIf.value;
}
const RANGE_RE = /^\d{1,5}(\s*-\s*\d{1,5})?$/;

/** Check + normalise what the salesperson typed. Returns clean values or a
 *  plain-English error per field. Unknown keys are dropped. */
export function validateFields(t: EsignTemplateId, raw: Record<string, unknown>): { values: FieldValues; errors: Record<string, string> } {
  const values: FieldValues = {};
  const errors: Record<string, string> = {};
  for (const f of TEMPLATE_FIELDS[t]) {
    // A hidden field (e.g. "Number of payments" when not split) is not used:
    // keep its default so a stale value can't block the form.
    if (isHidden(t, f, raw)) { values[f.key] = f.default; continue; }
    const v = raw?.[f.key] ?? f.default;
    const s = String(v).trim().slice(0, 40);
    if (f.type === "money" || f.type === "number") {
      const n = Number(s.replace(/[$,\s]/g, ""));
      const max = f.max ?? 100000;
      const min = f.min ?? 1;
      if (!Number.isFinite(n) || s === "") { errors[f.key] = "Type a number"; continue; }
      if (f.type === "number" && !Number.isInteger(n)) { errors[f.key] = "Whole number only"; continue; }
      if (n < min || n > max) { errors[f.key] = `Must be ${min}–${max.toLocaleString("en-US")}`; continue; }
      values[f.key] = Math.round(n * 100) / 100;
    } else if (f.type === "range") {
      const clean = s.replace(/[$,]/g, "");
      if (!RANGE_RE.test(clean)) { errors[f.key] = "Like 300-600"; continue; }
      const parts = clean.split("-").map((p) => Number(p.trim()));
      if (parts.some((p) => p < (f.min ?? 1) || p > (f.max ?? 20000))) { errors[f.key] = `Each number ${f.min ?? 1}–${(f.max ?? 20000).toLocaleString("en-US")}`; continue; }
      if (parts.length === 2 && parts[0] >= parts[1]) { errors[f.key] = "First number must be smaller"; continue; }
      values[f.key] = parts.join("-");
    } else if (f.type === "days") {
      if (!DAYS_RE.test(s)) { errors[f.key] = "Like 90, or 150 + 60"; continue; }
      const nums = s.split("+").map((p) => Number(p.trim()));
      const months = String(raw?.program_unit ?? "days") === "months";
      const max = months ? 24 : 730;
      if (nums.some((n) => n < 1 || n > max)) { errors[f.key] = `Each number 1–${max}`; continue; }
      values[f.key] = s.replace(/\s*\+\s*/g, " + ");
    } else {
      const ok = f.options?.some((o) => o.value === s);
      if (!ok) { errors[f.key] = "Pick one"; continue; }
      values[f.key] = s;
    }
  }
  return { values, errors };
}

/** The text each placeholder becomes, from validated values. */
export function placeholderValues(t: EsignTemplateId, v: FieldValues): Record<string, string> {
  const range = (x: unknown) => {
    const [a, b] = String(x).split("-").map(Number);
    return b ? `$${a.toLocaleString("en-US")}-${b.toLocaleString("en-US")}` : `$${a.toLocaleString("en-US")}`;
  };
  if (t === "ppa") {
    const fee = Number(v.fee), dep = Number(v.deposit);
    return { fee: money(fee), deposit: money(dep), total: money(Math.round((fee + dep) * 100) / 100), ad_spend: range(v.ad_spend) };
  }
  const total = Number(v.price);
  const price = money(total);
  const plan = String(v.payment_plan);
  // Wording of each payment plan as it appeared in past exports:
  // (23) "$3,985 upfront", (16) "$697/mo", (20) "$897 * 3 months",
  // (10) "$3,485 ($1,742.5 at the beginning and $1,742.5 in 30 days)".
  let price_terms: string;
  if (plan === "monthly") price_terms = `${price}/mo`;
  else if (plan === "split") price_terms = `${price} * ${Number(v.payments)} months`;
  else if (plan === "two") {
    const first = Math.round((total / 2) * 100) / 100;
    const second = Math.round((total - first) * 100) / 100;
    price_terms = `${price} (${money(first)} at the beginning and ${money(second)} in 30 days)`;
  } else price_terms = `${price} upfront`;
  const len = Number(v.guarantee_length);
  // (23) "75 bookings in 7 months", (11–19) "30 bookings within 90 days".
  const guarantee_period = v.guarantee_unit === "days" ? `within ${len} days` : `in ${len} month${len === 1 ? "" : "s"}`;
  return {
    program_length: `${String(v.program_length)} ${v.program_unit === "months" ? "months" : "days"}`,
    strikes: String(Number(v.strikes)),
    price_terms,
    ad_spend: range(v.ad_spend),
    guarantee_bookings: String(Number(v.guarantee_bookings)),
    guarantee_period,
  };
}

function fill(text: string, map: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in map ? map[k] : m));
}

/** Template + numbers → the exact agreement the client will sign. */
export function renderAgreement(template: Agreement, t: EsignTemplateId, values: FieldValues): Agreement {
  const map = placeholderValues(t, values);
  return {
    title: fill(template.title, map),
    footer: fill(template.footer, map),
    blocks: template.blocks.map((b): Block => {
      if (b.type === "heading" || b.type === "paragraph") return { type: b.type, text: fill(b.text, map) };
      if (b.type === "bullets" || b.type === "numbered") return { type: b.type, items: b.items.map((i) => fill(i, map)) };
      return b;
    }),
  };
}

/** Every placeholder named in a template. */
export function placeholdersIn(a: Agreement): Set<string> {
  const out = new Set<string>();
  const scan = (s: string) => { for (const m of s.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) out.add(m[1]); };
  scan(a.title); scan(a.footer);
  for (const b of a.blocks) {
    if (b.type === "heading" || b.type === "paragraph") scan(b.text);
    else if (b.type === "bullets" || b.type === "numbered") b.items.forEach(scan);
  }
  return out;
}

/** An admin's wording override is accepted only if it is a well-formed
 *  agreement that still has every required placeholder, no unknown ones,
 *  and a signature block. */
export function checkTemplate(t: EsignTemplateId, v: unknown): { template: Agreement | null; error?: string } {
  const a = upgradeTemplate(t, parseAgreement(v));
  if (!a) return { template: null, error: "That is not a valid agreement" };
  const have = placeholdersIn(a);
  const missing = REQUIRED_PLACEHOLDERS[t].filter((p) => !have.has(p));
  if (missing.length) return { template: null, error: `Missing number spot(s): ${missing.map((m) => `{{${m}}}`).join(", ")}` };
  const known = new Set(REQUIRED_PLACEHOLDERS[t]);
  const unknown = [...have].filter((p) => !known.has(p));
  if (unknown.length) return { template: null, error: `Unknown spot(s): ${unknown.map((m) => `{{${m}}}`).join(", ")}` };
  if (!a.blocks.some((b) => b.type === "signature")) return { template: null, error: "The signature block is missing" };
  return { template: a };
}

/** Older admin overrides (before program_length / strikes were fields) are
 *  upgraded so they keep working instead of falling back to the default. */
function upgradeTemplate(t: EsignTemplateId, a: Agreement | null): Agreement | null {
  if (!a || t !== "standard") return a;
  const up = (s: string) => s
    .replace(/\{\{\s*program_days\s*\}\}\s*days/g, "{{program_length}}")
    .replace(/strike([,.]) 5 strikes and the guarantee is voided/g, "strike$1 {{strikes}} strikes and the guarantee is voided");
  return {
    title: up(a.title),
    footer: up(a.footer),
    blocks: a.blocks.map((b): Block => {
      if (b.type === "heading" || b.type === "paragraph") return { type: b.type, text: up(b.text) };
      if (b.type === "bullets" || b.type === "numbered") return { type: b.type, items: b.items.map(up) };
      return b;
    }),
  };
}

/** The exact text the document fingerprint (SHA-256) is taken over. Built
 *  from the frozen snapshot, independent of JSON key order. */
export function fingerprintText(a: Agreement): string {
  return `${agreementToText(a)}\n${a.footer}`;
}

export const CONSENT_TEXT = "I agree to use electronic records and signatures, and I have read and agree to this agreement.";

export const settingsKey = (t: EsignTemplateId) => `esign_template_${t}`;

/** MM/DD/YYYY h:mm AM in a timezone (default UTC), en-US. */
export function usDateTime(iso: string | null | undefined, timeZone = "UTC"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let tz = timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  return d.toLocaleString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}
export function usDate(iso: string | null | undefined, timeZone = "UTC"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let tz = timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  return d.toLocaleDateString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric" });
}
