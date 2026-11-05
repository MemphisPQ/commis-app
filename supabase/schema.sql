-- Kitchen Costing: the tables.
-- Paste this whole file into Supabase: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once.
--
-- Every row belongs to the account that wrote it (user_id), and row level security means
-- nobody else can read or change it, even with the public key that sits in config.js.

-- 1. Tables ------------------------------------------------------------------

create table if not exists public.ingredients (
  id                 uuid primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 200),
  category           text not null default '',
  base               text not null default 'kg' check (base in ('kg', 'L', 'unit', 'portion', 'recipe', 'bunch')),
  yield              numeric not null default 1 check (yield > 0 and yield <= 1),
  each_kg            numeric check (each_kg is null or each_kg > 0),
  preferred_offer_id uuid,
  notes              text not null default '',
  review             text not null default '',
  created_at         timestamptz not null default now()
);

create table if not exists public.offers (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ingredient_id  uuid not null references public.ingredients (id) on delete cascade,
  supplier       text not null default '',
  supplier_item  text not null default '',   -- how the supplier names it on invoices
  pack_cost      numeric,
  pack_qty       numeric,
  pack_unit      text not null default 'kg',
  updated_at     date,
  created_at     timestamptz not null default now()
);

do $$ begin
  alter table public.ingredients add constraint ingredients_preferred_offer_fk
    foreign key (preferred_offer_id) references public.offers (id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.price_history (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  offer_id       uuid references public.offers (id) on delete cascade,
  ingredient_id  uuid references public.ingredients (id) on delete cascade,
  supplier       text not null default '',
  pack_cost      numeric,
  pack_qty       numeric,
  pack_unit      text,
  date           date not null default current_date,
  source         text not null default '',
  created_at     timestamptz not null default now()
);

create table if not exists public.recipes (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 200),
  kind        text not null default 'dish' check (kind in ('dish', 'prep')),
  menu        text not null default '',
  yield_qty   numeric not null default 1 check (yield_qty > 0),
  yield_unit  text not null default 'portion',
  menu_price  numeric,
  multiplier  numeric,
  notes       text not null default '',
  ack_cost    numeric,          -- cost per portion when you last pressed "Got it"
  review      text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.lines (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_id      uuid not null references public.recipes (id) on delete cascade,
  pos            integer not null default 0,
  ingredient_id  uuid references public.ingredients (id) on delete restrict,
  sub_recipe_id  uuid references public.recipes (id) on delete restrict,
  qty            numeric,
  unit           text,
  offer_id       uuid references public.offers (id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((ingredient_id is null) <> (sub_recipe_id is null))
);

create index if not exists offers_ingredient_idx on public.offers (ingredient_id);
create index if not exists history_offer_idx on public.price_history (offer_id, date);
create index if not exists lines_recipe_idx on public.lines (recipe_id, pos);

-- 2. Privacy: each account sees and changes only its own rows ---------------

do $$
declare t text;
begin
  foreach t in array array['ingredients', 'offers', 'price_history', 'recipes', 'lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- 3. Settings: one row per account (the Google Drive folder and sheet you picked, etc.) ------

create table if not exists public.settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at  timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "own rows" on public.settings;
create policy "own rows" on public.settings for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.settings from anon;
grant select, insert, update, delete on public.settings to authenticated;

-- 4. Monthly inventory counts and recipe cards ------------------------------

alter table public.ingredients add column if not exists in_inventory boolean not null default true;  -- on the monthly count
alter table public.recipes add column if not exists method text not null default '';                -- Preparation, one step per line
alter table public.recipes add column if not exists ready_in text not null default '';              -- "Ready in" on the card
alter table public.recipes add column if not exists card_doc_id text;                               -- the Google Doc made for it

create table if not exists public.counts (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month          text not null check (month ~ '^\d{4}-\d{2}$'),   -- "2026-10"
  ingredient_id  uuid not null references public.ingredients (id) on delete cascade,
  qty            numeric,                                           -- in the ingredient's kg / L / unit
  created_at     timestamptz not null default now(),
  unique (user_id, month, ingredient_id)
);
create index if not exists counts_month_idx on public.counts (month);
alter table public.counts enable row level security;
drop policy if exists "own rows" on public.counts;
create policy "own rows" on public.counts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.counts from anon;
grant select, insert, update, delete on public.counts to authenticated;

-- 5. Preps on the monthly count (valued at their own cost, no separate ingredient needed) ----------

alter table public.recipes add column if not exists in_inventory boolean not null default false;
alter table public.counts alter column ingredient_id drop not null;
alter table public.counts add column if not exists recipe_id uuid references public.recipes (id) on delete cascade;
do $$ begin
  alter table public.counts add constraint counts_one_item check ((ingredient_id is null) <> (recipe_id is null));
exception when duplicate_object then null; end $$;
create unique index if not exists counts_month_recipe_idx on public.counts (user_id, month, recipe_id) where recipe_id is not null;

-- A prepped item can be "made from" a prep: its price is then that prep's live batch cost.
alter table public.ingredients add column if not exists prep_id uuid references public.recipes (id) on delete set null;

-- A batch's second measure: makes 15 portions AND weighs 1.2 kg (its true weight).
alter table public.recipes add column if not exists alt_qty numeric check (alt_qty is null or alt_qty > 0);
alter table public.recipes add column if not exists alt_unit text;

-- 6. Pricing per portion (prepped items made and counted in portions) ----------

alter table public.ingredients drop constraint if exists ingredients_base_check;
alter table public.ingredients add constraint ingredients_base_check check (base in ('kg', 'L', 'unit', 'portion', 'recipe', 'bunch'));

-- 7. Locked prices: a prepped item or a prep keeps the price you locked, whatever ingredient prices do ----------

alter table public.ingredients add column if not exists locked_price numeric check (locked_price is null or locked_price >= 0);
alter table public.ingredients add column if not exists locked_at date;
alter table public.recipes add column if not exists locked_cost numeric check (locked_cost is null or locked_cost >= 0);
alter table public.recipes add column if not exists locked_at date;

-- 8. Pricing per recipe or per bunch (a prepped item counted as whole batches, herbs and greens by the bunch) ----------

alter table public.ingredients drop constraint if exists ingredients_base_check;
alter table public.ingredients add constraint ingredients_base_check check (base in ('kg', 'L', 'unit', 'portion', 'recipe', 'bunch'));

-- 9. Dish categories: Grignoter, Entrée, Plats, Dessert, Extra… (to look at one or several at a time) ----------

alter table public.recipes add column if not exists category text not null default '';

-- 10. A yield on one recipe line: the same item trimmed differently in this recipe (empty = the item's own yield) ----------

alter table public.lines add column if not exists yield numeric check (yield is null or (yield > 0 and yield <= 1));

-- 11. Commis only: invoices sent in to have a reader made ("Send us this invoice") ----------
-- An invoice the app can't read yet goes into the private "invoice-inbox" bucket, in a folder named after the account
-- that sent it. Restaurants can add files to their own folder and nothing else; only the owner of this Supabase
-- project sees them (Storage in the dashboard). Not needed in the one-restaurant project.

create table if not exists public.invoice_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  file_path  text not null,
  file_name  text not null default '',
  note       text not null default '',
  status     text not null default 'sent',
  created_at timestamptz not null default now()
);
alter table public.invoice_requests enable row level security;
drop policy if exists "own rows" on public.invoice_requests;
create policy "own rows" on public.invoice_requests for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.invoice_requests from anon;
grant select, insert on public.invoice_requests to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-inbox', 'invoice-inbox', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;
drop policy if exists "send own invoices" on storage.objects;
create policy "send own invoices" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-inbox' and (storage.foldername(name))[1] = auth.uid()::text);

-- 12. Allergens on items: what an item contains, and what it may have been in contact with ----------
-- Comma-separated keys (gluten, milk, egg, peanut, treenut, sesame, soy, fish, shellfish, mustard, sulphite).
-- allergens is empty when the item contains none of them, and null when nobody has checked it yet.

alter table public.ingredients add column if not exists allergens text;
alter table public.ingredients add column if not exists allergen_contact text not null default '';

-- 13. Keep awake: a read the public key may make, so a free project isn't paused for inactivity ------
-- .github/workflows/keep-awake.yml calls it a few times a day. It returns the time and reads no data.

create or replace function public.keep_awake() returns timestamptz
  language sql stable set search_path = '' as $$ select now() $$;
revoke all on function public.keep_awake() from public;
grant execute on function public.keep_awake() to anon;

-- 14. Commis only: an email to the owner each time an invoice is sent in ----------
-- A new row in invoice_requests (part 11) queues a plain-text email through Resend: the file name, the note and a link
-- to the dashboard, never the PDF. pg_net sends it after the row is saved, so a slow or failing email can't hold up or
-- stop an invoice, and any other problem here (no key yet, say) only writes a warning to the Postgres log.
-- The key isn't in this file: it's a Vault secret named resend_api_key (README, "Commis", setting up, step 4). There's no
-- web address for this, so nobody outside can make it send anything, and restaurants can't run it or read the key.
-- There's no cap: every invoice sends its email (decided 2026-11-04). Not needed in the one-restaurant project.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    create extension pg_net with schema extensions;
  end if;
end
$$;

create or replace function public.notify_invoice_request() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  api_key    text;
  file_label text;
begin
  select btrim(s.decrypted_secret, E' \t\r\n') into api_key
    from vault.decrypted_secrets s where s.name = 'resend_api_key' limit 1;
  if api_key is null or api_key = '' then
    raise warning 'Invoice notice not sent: no resend_api_key in Vault.';
    return new;
  end if;

  file_label := left(btrim(regexp_replace(new.file_name, '[[:cntrl:]]+', ' ', 'g')), 100);
  if file_label = '' then
    file_label := '(no name)';
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'User-Agent', 'Commis'),
    body := jsonb_build_object(
      'from', 'Commis <noreply@example.com>',
      'to', jsonb_build_array('you@example.com'),
      'subject', 'Commis: an invoice arrived (' || file_label || ')',
      'text', format(
        E'A restaurant sent in an invoice through Commis.\n\n'
        'File: %s\n'
        'Note from the restaurant: %s\n\n'
        'Open it in Supabase:\n'
        'https://supabase.com/dashboard/project/YOUR-PROJECT-REF/storage/files/buckets/invoice-inbox\n'
        'Folder and file: %s\n\n'
        'Once its reader is built, or if one can''t be built, delete the file, its row in '
        'Table Editor > invoice_requests and this email. The Terms promise it.',
        file_label,
        coalesce(nullif(btrim(left(new.note, 2000)), ''), '(none)'),
        left(regexp_replace(new.file_path, '[[:cntrl:]]+', ' ', 'g'), 300))),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  raise warning 'Invoice notice not sent: %', sqlerrm;
  return new;
end
$$;
revoke all on function public.notify_invoice_request() from public, anon, authenticated, service_role;

drop trigger if exists invoice_requests_notify on public.invoice_requests;
create trigger invoice_requests_notify after insert on public.invoice_requests
  for each row execute function public.notify_invoice_request();

-- 15. Commis only: knowing the invoice email works ----------
-- The alarm: .github/workflows/invoice-email-check.yml calls invoice_email_check() every 2 hours with the public key and
-- fails unless the answer is true, so GitHub emails the account behind the schedule. It's on GitHub because an alarm sent
-- through Resend would fail along with what it's watching. The answer is true or false and nothing else.
-- False means one of: the key isn't in the Vault; an email was refused or got no answer in the last 5 hours (pg_net keeps
-- results for 6); or fewer emails were accepted than invoices arrived, leaving out the last 10 minutes so sending has time.
-- The weekly test: pg_cron emails the owner every Monday the same way an invoice does, with how many invoices are waiting.
-- A dead key shows up even with no invoices, and a missing Monday email is a sign too. Only pg_cron and the project's
-- owner can run it, so nobody outside can make it send anything. Not needed in the one-restaurant project.

-- Only when pg_cron isn't there yet. Supabase's own setup script for it runs at "create extension", and it fails on a project
-- that has these grants, even with "if not exists": that's the error "dependent privileges exist".
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;
  end if;
end
$$;

create or replace function public.invoice_email_check() returns boolean
  language plpgsql stable security definer set search_path = '' as $$
declare
  accepted bigint;
  refused  bigint;
  invoices bigint;
begin
  if not exists (select 1 from vault.secrets s where s.name = 'resend_api_key') then
    return false;
  end if;

  select count(*) filter (where r.status_code between 200 and 299),
         count(*) filter (where r.status_code is null or r.status_code not between 200 and 299)
    into accepted, refused
    from net._http_response r where r.created > now() - interval '5 hours';
  if refused > 0 then
    return false;
  end if;

  select count(*) into invoices from public.invoice_requests i
    where i.created_at > now() - interval '5 hours' and i.created_at < now() - interval '10 minutes';
  return accepted >= invoices;
end
$$;
revoke all on function public.invoice_email_check() from public, anon, authenticated, service_role;
grant execute on function public.invoice_email_check() to anon;

create or replace function public.invoice_email_weekly_test() returns void
  language plpgsql security definer set search_path = '' as $$
declare
  api_key text;
  waiting bigint;
begin
  select btrim(s.decrypted_secret, E' \t\r\n') into api_key
    from vault.decrypted_secrets s where s.name = 'resend_api_key' limit 1;
  if api_key is null or api_key = '' then
    raise exception 'No resend_api_key in Vault.';
  end if;

  select count(*) into waiting from public.invoice_requests;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'User-Agent', 'Commis'),
    body := jsonb_build_object(
      'from', 'Commis <noreply@example.com>',
      'to', jsonb_build_array('you@example.com'),
      'subject', 'Commis: invoice emails are working (weekly test)',
      'text', format(
        E'This is the weekly test of the invoice email. If it reached you, Resend, the key and Supabase''s sending all work. '
        'There''s nothing to do, and you can delete this.\n\n'
        'Invoices waiting in invoice-inbox: %s\n'
        'https://supabase.com/dashboard/project/YOUR-PROJECT-REF/storage/files/buckets/invoice-inbox\n\n'
        'If a Monday goes by without this email, check Spam, then see "If the alarm goes off" in the README.',
        waiting)),
    timeout_milliseconds := 10000);
end
$$;
revoke all on function public.invoice_email_weekly_test() from public, anon, authenticated, service_role;

select cron.schedule('commis-invoice-email-test', '17 13 * * 1', 'select public.invoice_email_weekly_test()');

-- 16. More ways to measure, counting in any of them, and containers (BOTH sites) ----------
-- Nothing already saved changes: every new column starts empty, and an empty one means what it always meant.
--   measures      what one recipe comes to, beyond what a prep already holds: [{"qty": 12, "unit": "kg"}, {"qty": 66, "unit": "portion"}]
--   count_unit    the unit picked for this item on the inventory (empty = the unit it's priced in)
--   container_kg  what its empty container weighs; counting by weight, the scale's number has this taken off
--   counts.unit   the unit this count was typed in (empty = the unit the item is priced in, as every older count)
--   counts.containers  how many containers were on the scale (empty = one)

alter table public.ingredients add column if not exists measures jsonb check (measures is null or jsonb_typeof(measures) = 'array');
alter table public.ingredients add column if not exists count_unit text;
alter table public.ingredients add column if not exists container_kg numeric check (container_kg is null or container_kg > 0);
alter table public.recipes add column if not exists measures jsonb check (measures is null or jsonb_typeof(measures) = 'array');
alter table public.recipes add column if not exists count_unit text;
alter table public.recipes add column if not exists container_kg numeric check (container_kg is null or container_kg > 0);
alter table public.counts add column if not exists unit text;
alter table public.counts add column if not exists containers numeric check (containers is null or containers >= 0);

-- 17. Closed months: the permanent record of a month's inventory (BOTH sites) ----------
-- Closing a month saves what it was: every counted item's name, section, amount, price and value, and which group each
-- section was in. From then on that's what the month shows, whatever happens to prices, items or sections later.
-- The rules below are the guarantee: a saved record can't be changed or deleted, even by the app. Reopening a month only
-- marks its record as set aside (reopened_at), so every version ever closed stays here.

create table if not exists public.closed_months (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month        text not null check (month ~ '^\d{4}-\d{2}$'),
  closed_at    timestamptz not null default now(),
  reopened_at  timestamptz,
  source       text not null default '',                                                -- empty = closed in the app
  total        numeric not null default 0,
  items        integer not null default 0,                                              -- how many were on the count that month
  groups       jsonb not null default '{}'::jsonb check (jsonb_typeof(groups) = 'object'),
  rows         jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  created_at   timestamptz not null default now()
);
create unique index if not exists closed_months_one_standing on public.closed_months (user_id, month) where reopened_at is null;
alter table public.closed_months enable row level security;
drop policy if exists "own rows" on public.closed_months;
create policy "own rows" on public.closed_months for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.closed_months from anon;
revoke all on public.closed_months from authenticated;
grant select, insert on public.closed_months to authenticated;
grant update (reopened_at) on public.closed_months to authenticated;

-- 18. What was spent: each saved invoice or purchase, its lines and which group each line counts toward (BOTH sites) ----------
-- It counts in the month of the invoice's own date. Amounts are before taxes. Each line keeps the group it was saved with.

create table if not exists public.saved_invoices (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  supplier   text not null default '',
  date       date not null,
  file       text not null default '',                                                  -- empty = typed by hand
  total      numeric not null default 0,
  lines      jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  saved_at   timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists saved_invoices_date_idx on public.saved_invoices (user_id, date);
alter table public.saved_invoices enable row level security;
drop policy if exists "own rows" on public.saved_invoices;
create policy "own rows" on public.saved_invoices for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.saved_invoices from anon;
grant select, insert, update, delete on public.saved_invoices to authenticated;
