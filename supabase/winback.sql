-- Win-back: former clients we are trying to bring back (owner, 2026-10-10).
-- Source of truth = the "Follow up To PPS" Google Sheet: rows marked
-- "Follow Up" are synced here (AI tab → 🔁 Win-back → Sync from sheet), their
-- PMU Bookings On Demand contact gets the WINBACK_TAG, and the Program column
-- decides which offer the AI drafts may pitch. Nothing here sends a message.
create table if not exists public.winback_contacts (
  sheet_row int primary key,              -- the sheet's "#" column
  owner_name text not null,
  business text,
  phone text,
  email text,
  last_paid text,
  offer text check (offer in ('pps', 'monthly')), -- null = not approved yet → AI never pitches
  contact_id text,                        -- PMU Bookings On Demand contact (null = not found)
  match_note text,                        -- why it didn't match / what was matched on
  tagged_at timestamptz,
  active boolean not null default true,   -- false once the sheet flips the row to "Not"
  outcome text check (outcome in ('won', 'lost')),
  synced_at timestamptz not null default now()
);
create index if not exists winback_contacts_contact_idx on public.winback_contacts (contact_id);

alter table public.winback_contacts enable row level security;
-- No policies: only the service role (admin-gated API routes) reads or writes.
