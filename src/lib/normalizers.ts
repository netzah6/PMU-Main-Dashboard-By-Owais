type Raw = Record<string, unknown>;

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a person's name into a stable join key.
 * Lowercases, drops parentheticals ("Ashleigh Jones (Anthony Claggett)" → "ashleigh jones"),
 * strips punctuation, and collapses whitespace. Used to match the financing
 * sheet's CLIENT NAME against a client's Owner Full Name.
 */
export function normalizeOwnerKey(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Pick the GHL contact ID. Real GHL IDs are ~20-char alphanumeric strings
 * (e.g. "qkgMgY1qoi70oBpvqwQy"). Some sheet columns hold stray integers
 * (e.g. "1679") or are empty — those must be rejected.
 */
function pickGhlId(raw: Raw): string {
  const candidates = [
    raw["Contact ID"], raw["contact_id"], raw["GHL Contact ID"], raw["_id2"],
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    // Must be alphanumeric, contain at least one letter, and be reasonably long
    if (s.length >= 15 && /[a-zA-Z]/.test(s) && /^[a-zA-Z0-9_-]+$/.test(s)) {
      return s;
    }
  }
  return "";
}

/** Find the "title" key in CPL / Budget tables (the long key with the sheet name) */
function findTitleKey(raw: Raw): string {
  const key = Object.keys(raw).find(
    (k) => !k.match(/^col_\d+$/) && k !== "row_number"
  );
  return key ?? "";
}

/** Return true if this row is a header/label row that should be skipped */
export function isHeaderRow(raw: Raw, table: "cpl" | "performance" | "budget"): boolean {
  if (table === "cpl") {
    // col_2 is "Website leads" in the header row
    return typeof raw.col_2 === "string" && isNaN(Number(raw.col_2));
  }
  if (table === "budget") {
    // col_2 is "Account name" in the header row
    return typeof raw.col_2 === "string" && isNaN(Number(raw.col_4));
  }
  if (table === "performance") {
    // col_2 is "Name" in header rows
    return (
      raw.col_2 === "Name" ||
      raw.col_2 === "" ||
      raw.col_2 == null ||
      raw.col_2 === "Call or Chat?"
    );
  }
  return false;
}

// ─── clients ───────────────────────────────────────────────────────────────
// Real fields confirmed from API: "Business Name", "Owner Full Name", "col_1" (status),
// "Assigned", "Media Buyer", "Version", "p", "Ad Account Name", "_id2" / "Contact ID"

export function normalizeClient(raw: Raw): Raw {
  return {
    ...raw,
    _id: raw._id ?? raw.id ?? raw.row_number ?? "",
    business_name: raw["Business Name"] ?? raw.business_name ?? "",
    owner_name: raw["Owner Full Name"] ?? raw.owner_name ?? "",
    status: raw["col_1"] ?? raw.status ?? "",
    campaign_status: raw["Campaign Status"] ?? raw.campaign_status ?? "",
    assigned: raw["Assigned"] ?? raw.assigned ?? "",
    media_buyer: raw["Media Buyer"] ?? raw.media_buyer ?? "",
    version: raw["Version"] ?? raw.version ?? "",
    p: raw["p"] ?? raw["Monthly Price"] ?? raw.monthly_price ?? "",
    ad_account_name: raw["Ad account Name"] ?? raw["Ad Account Name"] ?? raw.ad_account_name ?? "",
    _id2: pickGhlId(raw),
    lat: raw["lat"] ?? raw.lat ?? "",
    lng: raw["lng"] ?? raw.lng ?? "",
    notes: raw["Notes"] ?? raw.notes ?? "",
  };
}

// ─── performance tracking ───────────────────────────────────────────────────
// Real fields: col_2=name, col_3=date, col_4=happy, col_5=last_strategy,
// col_6=deposits, col_7=sessions/bookings, col_9=total_leads, col_10=booking_pct,
// col_13=dashboard_organized, SORT:=call_chat

export function normalizePerformance(raw: Raw): Raw {
  // Support both old col_N keys (from previous sync tool)
  // and real column name keys (from our sync after smart header detection)
  return {
    ...raw,
    client_name:
      raw.col_2 ?? raw["Name"] ?? raw["Client Name"] ?? raw["Business Name"] ?? "",
    date:
      raw.col_3 ?? raw["Date"] ?? "",
    happy:
      raw.col_4 ?? raw["Happy"] ?? raw["Happy?"] ?? "",
    last_strategy_call:
      raw.col_5 ?? raw["Last Strategy?"] ?? raw["Last Strategy Call"] ?? "",
    deposits:
      raw.col_6 ?? raw["Deposits?"] ?? raw["Deposits"] ?? "",
    sessions_done:
      raw.col_7 ?? raw["Sessions Done?"] ?? raw["Sessions Done"] ?? "",
    call_chat:
      raw["SORT:"] ?? raw["Call/Chat"] ?? raw["Call or Chat?"] ?? "",
    leads:
      raw.col_9 ?? raw["Total Leads"] ?? raw["Leads"] ?? "",
    bookings:
      raw.col_7 ?? raw["Bookings"] ?? "",
    booking_pct:
      raw.col_10 ?? raw["Booking %"] ?? raw["Booking%"] ?? "",
    dashboard_organized:
      raw.col_13 ?? raw["Dashboard Organized?"] ?? raw["Dashboard"] ?? "",
    daily_budget:
      raw.col_18 ?? raw["Daily Budget"] ?? raw.daily_budget ?? "",
    step1: raw.step1 ?? raw["Step 1"] ?? "",
    step2: raw.step2 ?? raw["Step 2"] ?? "",
    step3: raw.step3 ?? raw["Step 3"] ?? "",
    step4: raw.step4 ?? raw["Step 4"] ?? "",
    step5: raw.step5 ?? raw["Step 5"] ?? "",
    step6: raw.step6 ?? raw["Step 6"] ?? "",
    step7: raw.step7 ?? raw["Step 7"] ?? "",
  };
}

// ─── deposits ──────────────────────────────────────────────────────────────
// Real fields: "Business Name", "Date", "Amount", "Full Name", "Email", "Source"

export function normalizeDeposit(raw: Raw): Raw {
  return {
    ...raw,
    client_name: raw["Business Name"] ?? raw.client_name ?? "",
    // The deposits sheet's date column header came through as "f"
    date: raw["Date"] ?? raw["f"] ?? raw.date ?? "",
    amount: raw["Amount"] ?? raw.amount ?? "",
    status: raw["Status"] ?? raw.status ?? "",
    notes: raw["Notes"] ?? raw.notes ?? "",
    name: raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    source: raw["Source"] ?? raw.source ?? "",
  };
}

// ─── bookings ──────────────────────────────────────────────────────────────
// Real fields: "Business Name", "Full Name", "Date", "Email", "Phone Number"

export function normalizeBooking(raw: Raw): Raw {
  return {
    ...raw,
    client_name: raw["Business Name"] ?? raw.client_name ?? "",
    date: raw["Date"] ?? raw.date ?? "",
    name: raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    phone: raw["Phone Number"] ?? raw.phone ?? "",
    type: raw["Type"] ?? raw.type ?? "",
    status: raw["Status"] ?? raw.status ?? "",
    notes: raw["Notes"] ?? raw.notes ?? "",
  };
}

// ─── leads ─────────────────────────────────────────────────────────────────
// Real fields: "Full Name", "Email", "Business Name", "Phone Number", "Date"

export function normalizeLead(raw: Raw): Raw {
  return {
    ...raw,
    name: raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    phone: raw["Phone Number"] ?? raw.phone ?? "",
    business: raw["Business Name"] ?? raw.business ?? "",
    date: raw["Date"] ?? raw.date ?? "",
    source: raw["Source"] ?? raw.source ?? "",
    status: raw["Status"] ?? raw.status ?? "",
  };
}

// ─── outgoing calls ────────────────────────────────────────────────────────
// Real fields: "Business Name", "Full Name", "Date", "Email", "Phone Number"

export function normalizeCall(raw: Raw): Raw {
  return {
    ...raw,
    client_name: raw["Business Name"] ?? raw.client_name ?? "",
    date: raw["Date"] ?? raw.date ?? "",
    name: raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    month: raw["Month"] ?? raw.month ?? "",
    outcome: raw["Outcome"] ?? raw.outcome ?? "",
    notes: raw["Notes"] ?? raw.notes ?? "",
  };
}

// ─── signed agreements ─────────────────────────────────────────────────────
// Real fields: "Full Name", "Signed Date"

export function normalizeAgreement(raw: Raw): Raw {
  return {
    ...raw,
    name: raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    date: raw["Signed Date"] ?? raw["Date"] ?? raw.date ?? "",
    type: raw["Type"] ?? raw.type ?? "",
    status: raw["Status"] ?? raw.status ?? "",
    notes: raw["Notes"] ?? raw.notes ?? "",
  };
}

// ─── CPL 7 / 14 days ───────────────────────────────────────────────────────
// Real fields: titleKey=campaign name, col_2=leads, col_3=CPL, col_4=account name,
// col_5=account status, col_6=daily budget, col_7=amount spent
// Row 2 is a header row — filter with isHeaderRow()

export function normalizeCpl(raw: Raw): Raw {
  const titleKey = findTitleKey(raw);
  return {
    ...raw,
    campaign_name: titleKey ? (raw[titleKey] ?? "") : "",
    website_leads: raw.col_2 ?? "",
    cost_per_result: raw.col_3 ?? "",
    account_name: raw.col_4 ?? "",
    account_status: raw.col_5 ?? "",
    daily_budget: raw.col_6 ?? "",
    amount_spent: raw.col_7 ?? "",
  };
}

// ─── campaign budget (all time) ────────────────────────────────────────────
// Real fields: titleKey=campaign name, col_2=account name, col_3=account status,
// col_4=amount spent, col_5=campaign configured status
// Row 2 is a header row — filter with isHeaderRow()

export function normalizeCampaignBudget(raw: Raw): Raw {
  const titleKey = findTitleKey(raw);
  return {
    ...raw,
    campaign_name: titleKey ? (raw[titleKey] ?? "") : "",
    account_name: raw.col_2 ?? "",
    account_status: raw.col_3 ?? "",
    spent: raw.col_4 ?? "",
    budget: raw["Budget"] ?? raw.budget ?? "",
    remaining: raw["Remaining"] ?? raw.remaining ?? "",
    date: raw["Date"] ?? raw.date ?? "",
  };
}

// ─── LTV sheet 1 (payments) ────────────────────────────────────────────────
// Real fields: "Full Name (On Payment)", "Email", "Date", "Amount", "Source"

export function normalizeLtvPayment(raw: Raw): Raw {
  return {
    ...raw,
    name: raw["Full Name (On Payment)"] ?? raw["Full Name"] ?? raw.name ?? "",
    email: raw["Email"] ?? raw.email ?? "",
    date: raw["Date"] ?? raw.date ?? "",
    amount: raw["Amount"] ?? raw.amount ?? "",
    source: raw["Source"] ?? raw.source ?? "",
  };
}

// ─── LTV sheet 2 (summary) ────────────────────────────────────────────────
// Real fields: "(Name On Payment)", "Lifetime Value", "Average LTV",
// "Collected", "Goal", "Goal %", "Ad Spent", "ROI"

export function normalizeLtvSummary(raw: Raw): Raw {
  const goalPctRaw = raw["Goal %"];
  let goalPct = "";
  if (typeof goalPctRaw === "number") {
    goalPct = (goalPctRaw * 100).toFixed(1);
  } else if (goalPctRaw != null) {
    goalPct = String(goalPctRaw);
  }

  return {
    ...raw,
    name: raw["(Name On Payment)"] ?? raw["(Name on Signed Up)"] ?? raw.name ?? "",
    ltv: raw["Lifetime Value"] ?? raw.ltv ?? "",
    average_ltv: raw["Average LTV"] ?? raw.average_ltv ?? "",
    collected: raw["Collected"] ?? raw.collected ?? "",
    goal: raw["Goal"] ?? raw.goal ?? "",
    goal_pct: goalPct,
    ad_spent: raw["Ad Spent"] ?? raw.ad_spent ?? "",
    roi: raw["ROI"] ?? raw.roi ?? "",
  };
}
