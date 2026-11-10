-- Sales notes: a full copy of every old raw note we remove from a GHL contact
-- (owner 11/10/2026: "get rid of the other notes" once the clean pinned notes
-- hold them). The organizer still reads these copies as sources, so the clean
-- notes never lose what the old notes said, and any note can be put back.
create table if not exists public.sales_note_archive (
  id bigserial primary key,
  contact_id text not null,
  note_id text not null unique,
  kind text not null,               -- survey | fathom | typed | ai
  body text not null,               -- the note exactly as GHL had it (HTML)
  user_id text,                     -- GHL user who typed it (null = automation)
  date_added timestamptz not null,
  date_updated timestamptz,
  archived_at timestamptz not null default now(),
  deleted_at timestamptz            -- set once removed from GHL
);
create index if not exists sales_note_archive_contact on public.sales_note_archive (contact_id);
alter table public.sales_note_archive enable row level security;
revoke all on public.sales_note_archive from anon, authenticated;
