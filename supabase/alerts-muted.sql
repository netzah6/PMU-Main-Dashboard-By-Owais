-- "Don't show again" on the Alerts tab (2026-09-16): a muted alert is resolved
-- and the scanner never files the same (type, source_key) again until it's
-- reopened. Already applied to production.
alter table public.alerts add column if not exists muted boolean not null default false;
