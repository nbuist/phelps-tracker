-- Supabase schema for Phelps Tracker accounts and sync.
-- Paste this whole file into the Supabase SQL Editor and run it. It is safe to re-run.
--
-- Security model:
--   * Only signed-in users with a verified @hope.edu email can touch any row, and only their own.
--   * Row Level Security is on for every table; there are no policies for the anon role.
--   * Menus are NOT stored here (they're a static file), so no service-role key is ever needed.
--   * Rows are soft-deleted (deleted = true) so other devices learn about deletions when they sync.
--   * updated_at is always set by the server, so clients can't fake sync ordering.

-- ---------- helpers ----------

-- True when the caller's verified email is a Hope College address.
create or replace function public.is_hope_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'email') ilike '%@hope.edu', false)
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- tables ----------

create table if not exists public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  goal        integer not null default 2000 check (goal between 1200 and 6000),
  updated_at  timestamptz not null default now()
);

create table if not exists public.food_logs (
  id          uuid primary key,                       -- generated on the device
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date        date not null check (date between '2024-01-01' and '2100-01-01'),
  meal        text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snacks')),
  servings    numeric not null check (servings > 0 and servings <= 50),
  food        jsonb not null check (jsonb_typeof(food) = 'object' and pg_column_size(food) <= 8192),
  logged_at   timestamptz,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.custom_foods (
  id          uuid primary key,                       -- the food's custom_id from the device
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  food        jsonb not null check (jsonb_typeof(food) = 'object' and pg_column_size(food) <= 4096),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index if not exists food_logs_user_updated on public.food_logs (user_id, updated_at);
create index if not exists custom_foods_user_updated on public.custom_foods (user_id, updated_at);

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before insert or update on public.profiles
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.food_logs;
create trigger set_updated_at before insert or update on public.food_logs
  for each row execute function public.set_updated_at();
drop trigger if exists set_updated_at on public.custom_foods;
create trigger set_updated_at before insert or update on public.custom_foods
  for each row execute function public.set_updated_at();

-- ---------- row level security ----------

alter table public.profiles     enable row level security;
alter table public.food_logs    enable row level security;
alter table public.custom_foods enable row level security;

-- No deletes from the app (soft delete instead); account deletion goes through delete_my_account().
revoke all on public.profiles, public.food_logs, public.custom_foods from anon, authenticated;
grant select, insert, update on public.profiles, public.food_logs, public.custom_foods to authenticated;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_hope_user()))
  with check (user_id = (select auth.uid()) and (select public.is_hope_user()));

drop policy if exists "own logs" on public.food_logs;
create policy "own logs" on public.food_logs
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_hope_user()))
  with check (user_id = (select auth.uid()) and (select public.is_hope_user()));

drop policy if exists "own custom foods" on public.custom_foods;
create policy "own custom foods" on public.custom_foods
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_hope_user()))
  with check (user_id = (select auth.uid()) and (select public.is_hope_user()));

-- ---------- account deletion ----------

-- Deletes the caller's auth user; their profile, logs and custom foods cascade away with it.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- sign-up restriction (auth hook) ----------

-- Rejects sign-ups from anything but @hope.edu before Supabase sends an email.
-- Enable it in the dashboard: Authentication -> Auth Hooks -> Before User Created ->
-- Postgres function -> public.hook_restrict_signup_to_hope.
create or replace function public.hook_restrict_signup_to_hope(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if lower(event -> 'user' ->> 'email') like '%@hope.edu' then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Phelps Tracker is only open to @hope.edu email addresses.',
    'http_code', 403));
end;
$$;

grant execute on function public.hook_restrict_signup_to_hope(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_to_hope(jsonb) from public, anon, authenticated;
