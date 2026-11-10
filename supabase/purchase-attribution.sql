-- Owner 11/10/2026: keep the ad click data with each B2C lead so a deposit
-- paid later (text link, other browser) can still be credited to the ad.
-- Additive and nullable: the code works without these (it skips the click
-- save / the fbc_src log field), it just can't use them until applied.
alter table public.onebox_leads add column if not exists click jsonb;
comment on column public.onebox_leads.click is
  'Ad click data at lead time: fbc, fbp, fbclid, utm/ad params, page, ip, ua, at. Server-only (Meta CAPI); never pushed to GHL.';
-- Where the server Lead/Purchase got its click id: cookie | lead | url | none.
alter table public.capi_events add column if not exists fbc_src text;
