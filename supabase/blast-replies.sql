-- Blast results: who replied, and was it positive (owner 10/30/2026).
alter table blast_recipients add column if not exists reply_text text;
alter table blast_recipients add column if not exists reply_at timestamptz;
alter table blast_recipients add column if not exists reply_kind text; -- positive | negative | neutral
alter table blast_recipients add column if not exists reply_checked_at timestamptz;
alter table blast_jobs add column if not exists replies_total int not null default 0;
alter table blast_jobs add column if not exists replies_positive int not null default 0;
create index if not exists blast_recipients_reply_scan on blast_recipients (status, sent_at) where reply_at is null;
