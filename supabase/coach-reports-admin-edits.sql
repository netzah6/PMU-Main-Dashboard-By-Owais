-- Admin corrections to a coach's monthly report (owner, 10/21/2026): who changed what, when.
alter table public.coach_reports add column if not exists admin_edits jsonb not null default '[]'::jsonb;
