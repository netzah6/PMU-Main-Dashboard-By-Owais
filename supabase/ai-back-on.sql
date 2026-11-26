-- 11/26/2026 (owner, approved 11/22 + the check-in text 11/26): AI back on
-- after the artist's hand text. When an artist texts a lead herself, CloseBot
-- switches itself off for that lead ("ai off") and never comes back. 48 hours
-- after the artist's last text or call, if the lead sent nothing since and
-- nothing else applies (paid, booked, said no, stop stage, DND…), she gets ONE
-- check-in text and the AI is switched back on, so her reply reaches the AI.
-- One row per decision that matters: "sent" (the check-in went), "failed"
-- (GHL refused the text), "model_no" (the thread says don't text — cached
-- until the thread changes). See src/lib/ai-back-on.ts. Switch: app_settings
-- "ai_back_on", default off.
create table if not exists public.ai_back_on_people (
  id              bigserial primary key,
  contact_id      text not null,
  location_id     text not null,
  status          text not null check (status in ('sent', 'failed', 'model_no')),
  reason          text,                    -- failed / model_no: why
  text            text,                    -- the check-in as sent
  message_id      text,                    -- GHL message id of the check-in
  artist_touch_at timestamptz,             -- the artist's last text or call the 48 hours count from
  touch_by        text,                    -- text | call
  last_message_id text,                    -- newest message in her thread when decided (model_no cache key)
  ai_result       text,                    -- after the text: ok | ok_no_shutoff_seen | artist_took_over | replied_during_restore | failed
  ai_tags_after   jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists ai_back_on_people_contact on public.ai_back_on_people (contact_id, created_at desc);
create index if not exists ai_back_on_people_created on public.ai_back_on_people (created_at);
alter table public.ai_back_on_people enable row level security;
-- No policies: only the service role (the cron, admin-gated routes) reads or writes.

-- The switch, OFF (the code also treats a missing row as off).
insert into public.app_settings (key, value, updated_at)
values ('ai_back_on', '{"enabled": false, "startAt": null}'::jsonb, now())
on conflict (key) do nothing;
