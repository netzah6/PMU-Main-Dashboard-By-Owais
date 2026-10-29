-- 🎬 How-to videos per New Client Setup step (owner 10/29/2026): when the
-- Mac Mini is down, a teammate does the step by hand and watches the short
-- clip next to it on the Onboarding card. Many small clips per step, so one
-- can be replaced or added without re-recording the rest. Admins add a link
-- (Loom / YouTube / Vimeo / Google Drive) or upload a file; everyone who can
-- open the card watches. Reads and writes go through /api/onboarding/step-videos
-- with the service role — no client policies.
create table if not exists public.setup_step_videos (
  id uuid primary key default gen_random_uuid(),
  step_key text not null,
  title text not null,
  url text not null,
  position integer not null default 0,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists setup_step_videos_step_idx on public.setup_step_videos (step_key, position);
alter table public.setup_step_videos enable row level security;

-- Uploaded clips. Public READ by exact path only (unguessable names); uploads
-- use a signed upload URL minted server-side for admins.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('setup-videos', 'setup-videos', true, 524288000, array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
