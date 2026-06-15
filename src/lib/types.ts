export type UserRole = "admin" | "editor" | "viewer";

export interface UserRoleRecord {
  id: string;
  user_id: string;
  role: UserRole;
  email: string;
  created_at: string;
}

// Raw DB row: { id, data: jsonb }
export interface DbRow {
  id: number | string;
  data: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ClientRecord {
  _id?: string;
  business_name?: string;
  owner_name?: string;
  status?: string;
  campaign_status?: string;
  assigned?: string;
  media_buyer?: string;
  version?: string;
  monthly_price?: string;
  p?: string; // monthly price alias
  ad_account_name?: string;
  _id2?: string; // GHL contact ID
  lat?: string;
  lng?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface PerformanceRecord {
  client_name?: string;
  date?: string;
  happy?: string;
  last_strategy_call?: string;
  deposits?: string;
  sessions_done?: string;
  call_chat?: string;
  leads?: string;
  bookings?: string;
  booking_pct?: string;
  dashboard_organized?: string;
  leads_3day?: string;
  leads_7day?: string;
  leads_14day?: string;
  leads_30day?: string;
  daily_budget?: string;
  step1?: string;
  step2?: string;
  step3?: string;
  step4?: string;
  step5?: string;
  step6?: string;
  step7?: string;
  [key: string]: unknown;
}

export interface DepositRecord {
  client_name?: string;
  date?: string;
  amount?: string;
  status?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface BookingRecord {
  client_name?: string;
  date?: string;
  type?: string;
  status?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface LeadRecord {
  name?: string;
  email?: string;
  business?: string;
  phone?: string;
  date?: string;
  source?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OutgoingCallRecord {
  client_name?: string;
  date?: string;
  month?: string;
  notes?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface AgreementRecord {
  name?: string;
  date?: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
}

export interface CplRecord {
  campaign_name?: string;
  website_leads?: string;
  cost_per_result?: string;
  account_name?: string;
  account_status?: string;
  daily_budget?: string;
  amount_spent?: string;
  [key: string]: unknown;
}

export interface CampaignBudgetRecord {
  campaign_name?: string;
  budget?: string;
  spent?: string;
  remaining?: string;
  [key: string]: unknown;
}

export interface LtvSheet1Record {
  date?: string;
  name?: string;
  email?: string;
  amount?: string;
  source?: string;
  [key: string]: unknown;
}

export interface LtvSheet2Record {
  name?: string;
  ltv?: string;
  average_ltv?: string;
  collected?: string;
  goal?: string;
  goal_pct?: string;
  ad_spent?: string;
  roi?: string;
  [key: string]: unknown;
}

export interface PaymentRecord {
  owner_key: string;
  client_name?: string;
  usd?: number | null;
  payment_status?: string;
  billing_status?: string;
  pay_day?: string;
  notes?: string;
  month?: string;
}

export interface GhlNote {
  id: string;
  body: string;
  dateAdded: string;
  contactId: string;
  userId?: string;
}
