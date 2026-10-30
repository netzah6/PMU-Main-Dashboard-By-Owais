-- Instagram engagement (owner, 2026-10-30): the Mac Mini follows every client's
-- Instagram from our account (@pmubookings.ondemand) and keeps engaging with
-- them — story views, likes, comments, story replies — slowly, like a person.
-- The Instagram tab manages who we engage with and why not.
create table if not exists public.ig_engage_clients (
  username text primary key,               -- Instagram handle, lowercase, no @
  slug text,                               -- one-box funnel the handle came from (null = added by hand)
  client_name text,
  status text not null default 'engage' check (status in ('engage', 'vip', 'paused', 'blocked')),
  note text,                               -- why paused / do not engage
  followed_at timestamptz,                 -- we follow them (as seen by the Mac Mini)
  follows_us boolean,                      -- they follow us back (as seen by the Mac Mini)
  last_engaged_at timestamptz,
  last_action text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists ig_engage_clients_slug_idx on public.ig_engage_clients (slug);

-- One row per thing done (or proposed) on Instagram.
create table if not exists public.ig_engage_actions (
  id uuid primary key default gen_random_uuid(),
  username text not null references public.ig_engage_clients (username) on delete cascade,
  kind text not null check (kind in ('follow', 'story_view', 'like', 'comment', 'story_reply')),
  text text,                               -- comment / story reply text
  post_url text,                           -- the post or reel the comment goes on
  context text,                            -- what the post / story was about (for the reviewer)
  status text not null check (status in ('draft', 'approved', 'rejected', 'done', 'failed', 'skipped')),
  task_id uuid,                            -- agent_proposals card that did it
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  done_at timestamptz
);
create index if not exists ig_engage_actions_user_idx on public.ig_engage_actions (username, created_at desc);
create index if not exists ig_engage_actions_status_idx on public.ig_engage_actions (status, created_at desc);

alter table public.ig_engage_clients enable row level security;
alter table public.ig_engage_actions enable row level security;
-- No policies: only the service role (admin-gated API routes, crons) reads or writes.
