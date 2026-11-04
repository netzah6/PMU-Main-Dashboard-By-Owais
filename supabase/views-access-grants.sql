-- Views stay server and signed-in only. New views need the same revoke.
revoke all on
  public.booking_stats, public.client_program_rows, public.cpd_issues,
  public.cpd_open_conversations, public.data_freshness, public.deposit_duplicates,
  public.deposit_overview, public.dropped_hot_leads, public.ghl_daily_metrics,
  public.ghl_lead_status, public.ghl_owner_last_sync, public.onebox_active_clients,
  public.perf_lead_counts, public.ppa_billing_summary, public.ppa_deposit_appointment,
  public.ppa_deposit_billing, public.ppa_deposit_contacts, public.ppa_deposit_contacts_mv,
  public.ppa_deposit_counts, public.ppa_deposit_facts, public.ppa_deposit_rows,
  public.ppa_deposit_stage, public.ppa_deposit_stage_counts, public.ppa_stage_counts
from anon;
