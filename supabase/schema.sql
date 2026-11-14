-- Arun Cloth Store: Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- Design notes
-- * Every row has a client-generated UUID, so records can be created offline.
-- * updated_at is set by the device that made the change. The trigger refuses
--   to overwrite a newer row with an older one (last write wins, safely).
-- * synced_at is set by the server and is what devices use to pull changes.
-- * Nothing is ever hard-deleted: rows get deleted_at instead, and the
--   authenticated role has no DELETE permission at all.
-- * Money owed is never stored as a balance. It is the sum of entries
--   (bill = +, payment = −), so two phones editing at once can't corrupt it.

create extension if not exists pgcrypto;

-- ---------- shared trigger ----------
create or replace function public.sb_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;              -- ownership never changes
    if new.updated_at < old.updated_at then
      return old;                              -- stale write from an old device: keep newer row
    end if;
  end if;
  new.synced_at := now();
  return new;
end $$;

-- ---------- tables ----------
create table if not exists public.shops (
  id          uuid primary key,                -- equals the owner's user id
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text,
  address     text,
  phone       text,
  gstin       text,
  paper       text default 'a5',               -- 'a5' or '58mm'
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  synced_at   timestamptz not null default now()
);

create table if not exists public.customers (
  id          uuid primary key,
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  phone       text,
  place       text,
  note        text,
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  synced_at   timestamptz not null default now()
);

create table if not exists public.products (
  id          uuid primary key,
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  cost        numeric(12,2),                   -- what we paid
  wholesale   numeric(12,2),
  retail      numeric(12,2),
  unit        text,
  qty         numeric(12,3),
  category    text,
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  synced_at   timestamptz not null default now()
);

-- added later: safe to run on an existing database
alter table public.products add column if not exists category text;

create table if not exists public.bills (
  id            uuid primary key,
  owner_id      uuid not null default auth.uid() references auth.users on delete cascade,
  no            text not null,
  customer_id   uuid,
  customer_name text,
  phone         text,
  place         text,
  items         jsonb not null default '[]',   -- [{name, qty, rate, amount}]
  total         numeric(12,2) not null default 0,
  paid          numeric(12,2) not null default 0,
  bill_date     date not null default current_date,
  updated_at    timestamptz not null,
  deleted_at    timestamptz,
  synced_at     timestamptz not null default now()
);

-- The money ledger. Balance for a customer = sum(amount) of non-deleted rows.
create table if not exists public.entries (
  id           uuid primary key,
  owner_id     uuid not null default auth.uid() references auth.users on delete cascade,
  customer_id  uuid not null,
  kind         text not null check (kind in ('bill','payment','due','adjust')),
  amount       numeric(12,2) not null,         -- + they owe more, − they paid
  bill_id      uuid,
  note         text,
  photo_path   text,                           -- path in the bill-photos bucket
  entry_date   date not null default current_date,
  updated_at   timestamptz not null,
  deleted_at   timestamptz,
  synced_at    timestamptz not null default now()
);

-- Staff, daily attendance and payment reminders (added later: safe to run on an existing database)
create table if not exists public.employees (
  id          uuid primary key,
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  phone       text,
  wage        numeric(12,2),                   -- optional
  wage_type   text default 'day',              -- 'day' or 'month'
  note        text,
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  synced_at   timestamptz not null default now()
);

create table if not exists public.attendance (
  id           uuid primary key,
  owner_id     uuid not null default auth.uid() references auth.users on delete cascade,
  employee_id  uuid not null,
  att_date     date not null,
  status       text not null check (status in ('present','half','absent')),
  check_in     text,                           -- 'HH:MM'
  check_out    text,
  note         text,
  updated_at   timestamptz not null,
  deleted_at   timestamptz,
  synced_at    timestamptz not null default now()
);

alter table public.attendance add column if not exists check_in text;
alter table public.attendance add column if not exists check_out text;

create table if not exists public.reminders (
  id          uuid primary key,
  owner_id    uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  amount      numeric(12,2),
  due_date    date not null,
  repeat      text not null default 'none',    -- none, weekly, monthly, yearly
  note        text,
  paid_on     date,
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  synced_at   timestamptz not null default now()
);

-- ---------- triggers, indexes, security ----------
do $$
declare t text;
begin
  foreach t in array array['shops','customers','products','bills','entries','employees','attendance','reminders'] loop
    execute format('drop trigger if exists %I_bw on public.%I', t, t);
    execute format('create trigger %I_bw before insert or update on public.%I
                    for each row execute function public.sb_before_write()', t, t);
    execute format('create index if not exists %I_sync_idx on public.%I (owner_id, synced_at)', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format('drop policy if exists %I_ins on public.%I', t, t);
    execute format('drop policy if exists %I_upd on public.%I', t, t);
    execute format('create policy %I_sel on public.%I for select to authenticated using (owner_id = auth.uid())', t, t);
    execute format('create policy %I_ins on public.%I for insert to authenticated with check (owner_id = auth.uid())', t, t);
    execute format('create policy %I_upd on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t, t);
    -- no delete policy on purpose, and revoke it outright as a second lock
    execute format('revoke delete on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Handy view for checking balances from the Supabase dashboard
create or replace view public.customer_balances
with (security_invoker = on) as
select c.id, c.name, c.phone, c.place,
       coalesce(sum(e.amount) filter (where e.deleted_at is null), 0) as balance
from public.customers c
left join public.entries e on e.customer_id = c.id
where c.deleted_at is null
group by c.id;

-- ---------- bill photo storage ----------
insert into storage.buckets (id, name, public)
values ('bill-photos', 'bill-photos', false)
on conflict (id) do nothing;

drop policy if exists "bill photos read own"   on storage.objects;
drop policy if exists "bill photos add own"    on storage.objects;
drop policy if exists "bill photos update own" on storage.objects;

create policy "bill photos read own" on storage.objects for select to authenticated
  using (bucket_id = 'bill-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bill photos add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'bill-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bill photos update own" on storage.objects for update to authenticated
  using (bucket_id = 'bill-photos' and (storage.foldername(name))[1] = auth.uid()::text);
