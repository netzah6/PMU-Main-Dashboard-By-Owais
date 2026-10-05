-- Square one-time payment links the AI agent created on Approve (owner
-- 2026-10-05): one row per link, so a payment can be matched to the client.
create table if not exists public.agent_payment_links (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.agent_proposals(id) on delete cascade,
  part int not null,
  parts int not null,
  contact_id text,
  contact_name text,
  owner_name text,
  label text,
  amount_cents int not null,
  url text not null,
  square_link_id text,
  square_order_id text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (proposal_id, part)
);
alter table public.agent_payment_links enable row level security;
revoke all on public.agent_payment_links from anon, authenticated;
grant all on public.agent_payment_links to service_role;
