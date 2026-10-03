-- AlmaED WhatsApp engine on Vercel: run once in Supabase → SQL Editor.
-- Replace CHANGE-ME-GOWA-PASSWORD, YOUR-APP and YOUR-CRON-SECRET first.

-- 1. Engine state (one row) and the dashboard's action queue
create table if not exists engine (
  id int primary key default 1 check (id = 1),
  state jsonb not null default '{}',
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into engine (id) values (1) on conflict do nothing;

create table if not exists actions (
  id bigserial primary key,
  type text not null,
  body jsonb not null default '{}',
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- RLS on with no policies: only the service-role key (used server-side by Vercel) can touch these
alter table engine enable row level security;
alter table actions enable row level security;

-- Only one session at a time: returns the state if the lock was free, else null
create or replace function acquire_engine(secs int) returns jsonb language sql as $$
  update engine set locked_until = now() + make_interval(secs => secs)
  where id = 1 and (locked_until is null or locked_until < now())
  returning state;
$$;
revoke execute on function acquire_engine(int) from public, anon, authenticated;

-- 2. gowa keeps the WhatsApp login (encryption keys) in its own schema, which Supabase's API does not expose
create schema if not exists gowa;
create role gowa login password 'CHANGE-ME-GOWA-PASSWORD';
grant usage, create on schema gowa to gowa;
alter role gowa set search_path = gowa;

-- 3. Every 2 minutes, ask Vercel to do whatever is due
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('almaed-tick', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/tick',
    headers := '{"Authorization": "Bearer YOUR-CRON-SECRET"}'::jsonb,
    timeout_milliseconds := 5000)
$$);
