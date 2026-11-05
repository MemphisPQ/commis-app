-- Commis only: anonymous error reports from the app (sites/commis/pages/errors.js). Not for the one-restaurant project.
-- Paste this whole file into Commis's Supabase project: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once. Supabase warns about "destructive operations" because of the drop and delete lines
-- below: they only touch this table and its own triggers.
-- To read the reports: Table Editor -> client_errors, sorted by created_at.

-- 1. The table: one row per error a visitor's browser ran into. Nothing in it identifies anyone or any restaurant:
--    no account, no email, no IP address, nothing the restaurant entered.
create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  message     text not null check (char_length(message) between 1 and 300),
  source      text not null default '' check (char_length(source) <= 120),   -- the file, e.g. app.js
  line        integer not null default 0 check (line between 0 and 1000000),
  col         integer not null default 0 check (col between 0 and 1000000),
  stack       text not null default '' check (char_length(stack) <= 1000),
  page        text not null default '' check (char_length(page) <= 120),     -- the path only, never what follows # or ?
  lang        text not null default '' check (char_length(lang) <= 10),
  browser     text not null default '' check (char_length(browser) <= 60),   -- e.g. "Safari 17 on iOS 17.5"
  width       integer not null default 0 check (width between 0 and 10000)   -- screen width in CSS pixels
);

create index if not exists client_errors_created_idx on public.client_errors (created_at desc);

-- 2. Anyone may ADD a report; nobody can read, change or delete them through the website.
--    You read them in the Supabase dashboard, which isn't limited by these rules.
alter table public.client_errors enable row level security;

drop policy if exists "anyone can report an error" on public.client_errors;
create policy "anyone can report an error" on public.client_errors for insert to anon, authenticated with check (true);

revoke all on public.client_errors from anon, authenticated;
grant insert (message, source, line, col, stack, page, lang, browser, width) on public.client_errors to anon, authenticated;

-- 3. The time is always the server's own, so a report can't pretend to be from another day.
create or replace function public.client_errors_stamp() returns trigger
language plpgsql as $$
begin
  new.created_at = now();
  return new;
end $$;

drop trigger if exists client_errors_stamp on public.client_errors;
create trigger client_errors_stamp before insert on public.client_errors
  for each row execute function public.client_errors_stamp();

-- 4. Tidy up after each new report: delete anything older than 60 days, and keep the newest 5,000 at most,
--    so the table can never fill the database.
create or replace function public.client_errors_tidy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.client_errors where created_at < now() - interval '60 days';
  delete from public.client_errors where id in (
    select id from public.client_errors order by created_at desc, id desc offset 5000
  );
  return null;
end $$;

drop trigger if exists client_errors_tidy on public.client_errors;
create trigger client_errors_tidy after insert on public.client_errors
  for each statement execute function public.client_errors_tidy();
