-- =====================================================================
-- Koinos Security — Supabase database setup
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run: tables are created only if missing, and functions,
-- policies and triggers are replaced.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Clear out tables left over from an older version of the app that use
-- the same names but a different layout. Empty ones are replaced; if an
-- old table still has data, stop and change nothing.
-- ---------------------------------------------------------------------
do $$
declare
  t record;
  n bigint;
begin
  for t in
    select * from (values
      ('events', 'starts_at'), ('shifts', 'cover_requested'), ('calendar_feeds', 'token'),
      ('sops', 'body'), ('contacts', 'alt_phone'), ('bulletins', 'kind'),
      ('roster', 'medical_notes'), ('profiles', 'email'),
      ('event_series', 'interval_n'), ('series_posts', 'requires_ccw')
    ) as v(tbl, col)
  loop
    if to_regclass('public.' || t.tbl) is not null and not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t.tbl and column_name = t.col
    ) then
      execute format('select count(*) from public.%I', t.tbl) into n;
      -- Old profiles are safe to drop: they are rebuilt from sign-ins below.
      if n > 0 and t.tbl <> 'profiles' then
        raise exception 'Table public.% is from an older version of the app and still has % row(s). Nothing was changed.', t.tbl, n;
      end if;
      execute format('drop table public.%I cascade', t.tbl);
      raise notice 'Replaced old-layout table public.%', t.tbl;
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- Profiles (one per signed-in person) and roles
--   pending   = signed up, waiting for approval (sees nothing)
--   member    = whole team, view/call only
--   admin     = manages bulletins, SOPs, contacts, roster; approves members
--   superuser = everything an admin can do + grants/revokes admin
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'pending'
              check (role in ('pending','member','admin','superuser')),
  created_at  timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_member() returns boolean
language sql stable set search_path = public as $$
  select coalesce(public.my_role() in ('member','admin','superuser'), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

create or replace function public.is_superuser() returns boolean
language sql stable set search_path = public as $$
  select coalesce(public.my_role() = 'superuser', false)
$$;

-- Create a profile automatically when someone signs in for the first time.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Give anyone who signed up before this script ran a profile too.
insert into public.profiles (id, email, full_name)
select id, coalesce(email, ''), coalesce(raw_user_meta_data->>'full_name', '')
from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_member());
-- No insert/update/delete policies: changes go through the functions below.

-- Anyone signed in can set their own display name.
create or replace function public.update_my_name(new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(new_name), '') = '' then raise exception 'Name is required'; end if;
  update public.profiles set full_name = left(trim(new_name), 100) where id = auth.uid();
end $$;

-- Role changes.
--   Admins:     pending <-> member (approve / remove access)
--   Superusers: any of pending / member / admin
--   Superuser status itself is only granted/removed here in the SQL editor.
create or replace function public.set_user_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare
  caller  text := public.my_role();
  cur_role text;
begin
  if new_role not in ('pending','member','admin') then
    raise exception 'Invalid role';
  end if;
  if target = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  select role into cur_role from public.profiles where id = target;
  if cur_role is null then raise exception 'User not found'; end if;
  if cur_role = 'superuser' then
    raise exception 'Superuser status can only be changed in the database';
  end if;

  if caller = 'superuser' then
    null; -- allowed
  elsif caller = 'admin' then
    if cur_role = 'admin' or new_role = 'admin' then
      raise exception 'Only a superuser can grant or revoke admin';
    end if;
  else
    raise exception 'Not authorized';
  end if;

  update public.profiles set role = new_role where id = target;

  -- On approval, link the matching roster entry (same email, not linked yet).
  -- The roster trigger then merges the account's details into it.
  if cur_role = 'pending' and new_role <> 'pending'
     and to_regclass('public.roster') is not null
     and not exists (select 1 from public.roster where profile_id = target) then
    update public.roster r
       set profile_id = target
     where r.id = (select r2.id from public.roster r2 join public.profiles p on p.id = target
                    where r2.profile_id is null and r2.email <> ''
                      and lower(r2.email) = lower(p.email)
                    order by r2.active desc, r2.created_at limit 1);
  end if;
end $$;

revoke all on function public.set_user_role(uuid, text) from public, anon;
revoke all on function public.update_my_name(text) from public, anon;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.update_my_name(text) to authenticated;

-- ---------------------------------------------------------------------
-- Shared trigger: stamp who/when on every insert and update
-- ---------------------------------------------------------------------
create or replace function public.stamp_row() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- SOPs — keeps exactly one previous version for rollback
-- ---------------------------------------------------------------------
create table if not exists public.sops (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  category         text not null default 'General',
  body             text not null default '',
  sort_order       int  not null default 0,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null,
  prev_title       text,
  prev_category    text,
  prev_body        text,
  prev_updated_at  timestamptz,
  prev_updated_by  uuid references public.profiles(id) on delete set null
);

-- When the title, category or text changes, the old copy becomes the
-- "previous version". Reverting is just saving the previous copy back,
-- which in turn keeps the version you reverted away from (so an accidental
-- revert can itself be undone). Clients can never write prev_* directly.
create or replace function public.sops_keep_previous() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and current_setting('koinos.sop_retag', true) = 'on' then
    -- A tab rename/removal moved this SOP; that isn't an edit.
    new.prev_title := old.prev_title; new.prev_category := old.prev_category; new.prev_body := old.prev_body;
    new.prev_updated_at := old.prev_updated_at; new.prev_updated_by := old.prev_updated_by;
  elsif tg_op = 'INSERT' then
    new.prev_title := null; new.prev_category := null; new.prev_body := null;
    new.prev_updated_at := null; new.prev_updated_by := null;
  elsif (new.title, new.category, new.body) is distinct from (old.title, old.category, old.body) then
    new.prev_title      := old.title;
    new.prev_category   := old.category;
    new.prev_body       := old.body;
    new.prev_updated_at := old.updated_at;
    new.prev_updated_by := old.updated_by;
  else
    new.prev_title      := old.prev_title;
    new.prev_category   := old.prev_category;
    new.prev_body       := old.prev_body;
    new.prev_updated_at := old.prev_updated_at;
    new.prev_updated_by := old.prev_updated_by;
  end if;
  return new;
end $$;

drop trigger if exists sops_stamp on public.sops;
create trigger sops_stamp before insert or update on public.sops
  for each row execute function public.stamp_row();
drop trigger if exists sops_previous on public.sops;
create trigger sops_previous before insert or update on public.sops
  for each row execute function public.sops_keep_previous();

-- Runs after sops_stamp (triggers fire in name order): a tab move keeps the
-- SOP's own "updated" date and person.
create or replace function public.sops_retag() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_setting('koinos.sop_retag', true) = 'on' then
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;
drop trigger if exists sops_zz_retag on public.sops;
create trigger sops_zz_retag before update on public.sops
  for each row execute function public.sops_retag();

-- SOP tabs: the categories shown as colored tabs on the SOPs screen, in
-- the admins' chosen order. SOPs refer to their tab by name, so renaming a
-- tab renames it on its SOPs too (done by save_sop_categories).
create table if not exists public.sop_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  color       text not null default 'gray'
              check (color in ('red','orange','yellow','green','teal','blue','purple','pink','gray')),
  sort_order  int  not null default 0
);

-- First run: start from the paper plan, plus any categories SOPs already use.
do $$
begin
  if not exists (select 1 from public.sop_categories) then
    insert into public.sop_categories (name, color, sort_order) values
      ('Emergency', 'red', 0), ('Medical', 'orange', 1), ('General', 'green', 2), ('Facilities', 'blue', 3);
  end if;
  insert into public.sop_categories (name, color, sort_order)
  select c, 'gray', 100 + row_number() over (order by c)
    from (select distinct category c from public.sops where category <> '') x
  on conflict (name) do nothing;
end $$;

-- Admins: save every tab at once, in order. p = [{id?, name, color}, …]
-- A renamed tab renames its SOPs; SOPs on a removed tab move to the first
-- tab. Moving SOPs this way doesn't count as editing them: their "previous
-- version" and "updated by" stay as they were (see sops_retag below).
create or replace function public.save_sop_categories(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  t jsonb; i int := 0; t_id uuid; new_name text; first_name text;
  keep uuid[] := '{}'; names text[] := '{}';
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then raise exception 'Keep at least one tab.'; end if;
  for t in select * from jsonb_array_elements(p) loop
    new_name := trim(coalesce(t->>'name', ''));
    if new_name = '' then raise exception 'Every tab needs a name.'; end if;
    if new_name like '~%' then raise exception 'Tab names can''t start with ~.'; end if;
    if length(new_name) > 40 then raise exception 'Tab names can be at most 40 characters.'; end if;
    if lower(new_name) = any(names) then raise exception 'Two tabs are both named "%".', new_name; end if;
    if coalesce(t->>'color', 'gray') not in ('red','orange','yellow','green','teal','blue','purple','pink','gray') then
      raise exception 'Unknown color "%".', t->>'color';
    end if;
    names := names || lower(new_name);
  end loop;

  perform set_config('koinos.sop_retag', 'on', true);
  -- 1. Point SOPs at their tab's id (not its name) while names change, so
  --    two tabs can even swap names.
  update public.sops s set category = '~' || c.id::text from public.sop_categories c where s.category = c.name;
  update public.sop_categories set name = '~' || id::text where true;
  -- 2. Save the tabs in order.
  for t in select * from jsonb_array_elements(p) loop
    t_id := nullif(t->>'id', '')::uuid;
    new_name := trim(t->>'name');
    if t_id is not null and exists (select 1 from public.sop_categories where id = t_id) then
      update public.sop_categories set name = new_name, color = coalesce(t->>'color', 'gray'), sort_order = i where id = t_id;
    else
      insert into public.sop_categories (name, color, sort_order) values (new_name, coalesce(t->>'color', 'gray'), i) returning id into t_id;
    end if;
    if i = 0 then first_name := new_name; end if;
    keep := keep || t_id;
    i := i + 1;
  end loop;
  -- 3. SOPs follow their tab's (new) name; removed tabs' SOPs go to the first tab.
  update public.sops s set category = c.name from public.sop_categories c
   where s.category = '~' || c.id::text and c.id = any(keep);
  delete from public.sop_categories where not (id = any(keep));
  update public.sops set category = first_name where category like '~%';
  perform set_config('koinos.sop_retag', 'off', true);
end $$;
revoke all on function public.save_sop_categories(jsonb) from public, anon;
grant execute on function public.save_sop_categories(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Emergency contacts
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  organization  text not null default '',
  category      text not null default 'General',
  phone         text not null default '',
  alt_phone     text not null default '',
  notes         text not null default '',
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null
);

drop trigger if exists contacts_stamp on public.contacts;
create trigger contacts_stamp before insert or update on public.contacts
  for each row execute function public.stamp_row();

-- ---------------------------------------------------------------------
-- Safety bulletins / BOLO
-- ---------------------------------------------------------------------
create table if not exists public.bulletins (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'bulletin' check (kind in ('bulletin','bolo')),
  priority    text not null default 'info' check (priority in ('info','caution','urgent')),
  title       text not null,
  body        text not null default '',
  photo_path  text,
  active      boolean not null default true,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

drop trigger if exists bulletins_stamp on public.bulletins;
create trigger bulletins_stamp before insert or update on public.bulletins
  for each row execute function public.stamp_row();

-- ---------------------------------------------------------------------
-- Team roster (separate from sign-in accounts, managed by admins)
-- ---------------------------------------------------------------------
create table if not exists public.roster (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  position       text not null default '',
  phone          text not null default '',
  email          text not null default '',
  photo_path     text,
  is_medical     boolean not null default false,
  medical_notes  text not null default '',
  active         boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles(id) on delete set null
);

drop trigger if exists roster_stamp on public.roster;
create trigger roster_stamp before insert or update on public.roster
  for each row execute function public.stamp_row();

-- CCW qualification, and a link to the person's app account
-- (the link is what makes "My assignments" and self-service swaps work).
alter table public.roster add column if not exists ccw_qualified boolean not null default false;
alter table public.roster add column if not exists ccw_expires_on date;
alter table public.roster add column if not exists profile_id uuid references public.profiles(id) on delete set null;
create unique index if not exists roster_profile_id_key on public.roster(profile_id) where profile_id is not null;

create or replace function public.my_roster_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.roster where profile_id = auth.uid() and active order by created_at limit 1
$$;

-- ---------------------------------------------------------------------
-- Self-service profile: each person can add their own phone and photo.
-- Kept on their account, and copied onto their roster entry when linked.
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists phone text not null default '';
alter table public.profiles add column if not exists photo_path text;

-- When a roster entry gets linked to an app account, merge the account in:
-- the sign-in email always wins; phone and photo fill in only if blank.
create or replace function public.roster_merge_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.profile_id is not null
     and (tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id) then
    select email, phone, photo_path into p from public.profiles where id = new.profile_id;
    if found then
      if coalesce(p.email, '') <> '' then new.email := p.email; end if;
      if coalesce(new.phone, '') = '' and coalesce(p.phone, '') <> '' then new.phone := p.phone; end if;
      if new.photo_path is null and p.photo_path is not null then new.photo_path := p.photo_path; end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists roster_merge_profile on public.roster;
create trigger roster_merge_profile before insert or update of profile_id on public.roster
  for each row execute function public.roster_merge_profile();

-- Entries linked before this existed: bring their email in line with the sign-in.
update public.roster r set email = p.email
  from public.profiles p
 where p.id = r.profile_id and coalesce(p.email, '') <> '' and r.email is distinct from p.email;

-- Update my own phone and/or photo (and my roster entry, if linked).
-- p_set_photo = false leaves the photo alone; true sets it (null removes it).
-- Returns the previous photo path so the app can clean up the old file.
create or replace function public.update_my_profile(p_phone text, p_set_photo boolean, p_photo_path text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  me       uuid := public.my_roster_id();
  old_path text;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  if p_set_photo and p_photo_path is not null
     and p_photo_path not like 'self/' || auth.uid()::text || '/%' then
    raise exception 'Invalid photo';
  end if;
  if me is not null then
    select photo_path into old_path from public.roster where id = me;
  else
    select photo_path into old_path from public.profiles where id = auth.uid();
  end if;

  update public.profiles
     set phone = coalesce(left(trim(p_phone), 40), phone),
         photo_path = case when p_set_photo then p_photo_path else photo_path end
   where id = auth.uid();

  if me is not null then
    update public.roster
       set phone = coalesce(left(trim(p_phone), 40), phone),
           photo_path = case when p_set_photo then p_photo_path else photo_path end
     where id = me;
  end if;

  return case when p_set_photo and old_path is distinct from p_photo_path then old_path end;
end $$;

revoke all on function public.update_my_profile(text, boolean, text) from public, anon;
grant execute on function public.update_my_profile(text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- Schedule: events (services) with posts/shifts assigned to roster people
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  location    text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  constraint events_time_order check (ends_at > starts_at)
);
create index if not exists events_starts_idx on public.events(starts_at);

drop trigger if exists events_stamp on public.events;
create trigger events_stamp before insert or update on public.events
  for each row execute function public.stamp_row();

create table if not exists public.shifts (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.events(id) on delete cascade,
  post             text not null default '',
  starts_at        timestamptz,          -- blank = same as the event
  ends_at          timestamptz,
  roster_id        uuid references public.roster(id) on delete set null,  -- blank = open post
  cover_requested  boolean not null default false,
  note             text not null default '',
  last_change      text not null default '',
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null
);
create index if not exists shifts_event_idx on public.shifts(event_id);
create index if not exists shifts_roster_idx on public.shifts(roster_id);

drop trigger if exists shifts_stamp on public.shifts;
create trigger shifts_stamp before insert or update on public.shifts
  for each row execute function public.stamp_row();

-- ---------------------------------------------------------------------
-- Repeating events (like a phone calendar). A series holds the pattern,
-- the event details and the template posts; real events are generated
-- from it about 6 months ahead and keep a link back to the series.
-- ---------------------------------------------------------------------
create table if not exists public.event_series (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  location      text not null default '',
  notes         text not null default '',
  start_time    time not null,
  end_time      time not null,                      -- earlier than start = next day
  freq          text not null default 'weekly' check (freq in ('daily','weekly','monthly')),
  interval_n    int  not null default 1 check (interval_n between 1 and 12),
  by_weekday    int[] not null default '{}',        -- weekly: 0 = Sunday … 6 = Saturday
  monthly_mode  text not null default 'day' check (monthly_mode in ('day','nth','last')),
  starts_on     date not null,
  until         date,                               -- blank = no end
  exdates       date[] not null default '{}',       -- single dates deleted from the series
  time_zone     text not null default 'America/New_York',
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null
);

drop trigger if exists event_series_stamp on public.event_series;
create trigger event_series_stamp before insert or update on public.event_series
  for each row execute function public.stamp_row();

create table if not exists public.series_posts (
  id            uuid primary key default gen_random_uuid(),
  series_id     uuid not null references public.event_series(id) on delete cascade,
  post          text not null default '',
  requires_ccw  boolean not null default false,
  roster_id     uuid references public.roster(id) on delete set null,   -- default person
  start_time    time,
  end_time      time,
  note          text not null default '',
  sort_order    int  not null default 0
);
create index if not exists series_posts_series_idx on public.series_posts(series_id);

-- Week-of-month rotation ("Update assignments"): for a repeating service,
-- who fills each post on the 1st, 2nd, 3rd, 4th and 5th week of the month.
-- When a series uses the rotation it replaces the post's single default person.
alter table public.event_series add column if not exists use_rotation boolean not null default false;
create table if not exists public.rotation_slots (
  series_post_id  uuid not null references public.series_posts(id) on delete cascade,
  week_of_month   int  not null check (week_of_month between 1 and 5),
  roster_id       uuid references public.roster(id) on delete set null,   -- blank = open
  primary key (series_post_id, week_of_month)
);

-- Who a template post should go to on a given date.
create or replace function public.template_roster(p_post uuid, p_default uuid, d date) returns uuid
language sql stable security definer set search_path = public as $$
  select case when s.use_rotation
              then (select rs.roster_id from public.rotation_slots rs
                     where rs.series_post_id = p_post
                       and rs.week_of_month = ceil(extract(day from d) / 7.0)::int)
              else p_default end
    from public.series_posts sp join public.event_series s on s.id = sp.series_id
   where sp.id = p_post
$$;

alter table public.events add column if not exists series_id uuid references public.event_series(id) on delete set null;
alter table public.events add column if not exists occurrence_date date;
alter table public.events add column if not exists is_exception boolean not null default false;
create unique index if not exists events_series_date_key on public.events(series_id, occurrence_date) where series_id is not null;

alter table public.shifts add column if not exists requires_ccw boolean not null default false;
alter table public.shifts add column if not exists series_post_id uuid references public.series_posts(id) on delete set null;
alter table public.shifts add column if not exists assignee_from_template boolean not null default false;
alter table public.shifts add column if not exists custom boolean not null default false;

-- Tracks who changed a post and keeps series defaults from overwriting
-- one-off changes (swaps, a different person this week, etc.).
create or replace function public.shifts_track_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text;
  from_template boolean := coalesce(current_setting('koinos.template', true), '') = 'on';
begin
  if new.roster_id is distinct from old.roster_id then
    new.cover_requested := false;
    if from_template then
      if new.last_change is not distinct from old.last_change then
        new.last_change := 'Updated from the repeating schedule';
      end if;
    else
      new.assignee_from_template := false;
      if new.last_change is not distinct from old.last_change then
        select full_name into who from public.profiles where id = auth.uid();
        new.last_change := 'Reassigned by ' || coalesce(nullif(who, ''), 'an admin');
      end if;
    end if;
  end if;
  if not from_template and new.series_post_id is not null
     and (new.post, new.requires_ccw, new.note, new.starts_at, new.ends_at)
         is distinct from (old.post, old.requires_ccw, old.note, old.starts_at, old.ends_at) then
    new.custom := true;
  end if;
  return new;
end $$;

drop trigger if exists shifts_changes on public.shifts;
create trigger shifts_changes before update on public.shifts
  for each row execute function public.shifts_track_change();

-- Dates a series falls on between two dates.
create or replace function public.series_dates(s public.event_series, d_from date, d_to date)
returns setof date language plpgsql stable set search_path = public as $$
declare
  lo    date := greatest(d_from, s.starts_on);
  hi    date := least(d_to, coalesce(s.until, d_to));
  d     date;
  week0 date := s.starts_on - extract(dow from s.starts_on)::int;
  m0    int  := extract(year from s.starts_on)::int * 12 + extract(month from s.starts_on)::int;
  nth   int  := ceil(extract(day from s.starts_on) / 7.0)::int;
  wd    int  := extract(dow from s.starts_on)::int;
  days  int[] := case when cardinality(s.by_weekday) = 0 then array[extract(dow from s.starts_on)::int] else s.by_weekday end;
  mi    int;
begin
  if lo > hi then return; end if;
  d := lo;
  while d <= hi loop
    if not (d = any(s.exdates)) then
      if s.freq = 'daily' then
        if (d - s.starts_on) % s.interval_n = 0 then return next d; end if;
      elsif s.freq = 'weekly' then
        if extract(dow from d)::int = any(days)
           and (((d - extract(dow from d)::int) - week0) / 7) % s.interval_n = 0 then
          return next d;
        end if;
      else
        mi := extract(year from d)::int * 12 + extract(month from d)::int;
        if (mi - m0) % s.interval_n = 0 then
          if s.monthly_mode = 'day' and extract(day from d) = extract(day from s.starts_on) then
            return next d;
          elsif s.monthly_mode = 'nth' and extract(dow from d)::int = wd
                and ceil(extract(day from d) / 7.0)::int = nth then
            return next d;
          elsif s.monthly_mode = 'last' and extract(dow from d)::int = wd
                and extract(month from d + 7) <> extract(month from d) then
            return next d;
          end if;
        end if;
      end if;
    end if;
    d := d + 1;
  end loop;
end $$;

create or replace function public.local_ts(d date, t time, tz text) returns timestamptz
language sql immutable as $$ select (d + t) at time zone tz $$;

create or replace function public.local_end_ts(d date, t_start time, t_end time, tz text) returns timestamptz
language sql immutable as $$
  select ((d + case when t_end <= t_start then 1 else 0 end) + t_end) at time zone tz
$$;

-- Push the series details and template posts onto its events from a date on.
-- p_new_posts: template posts that are new, so they get added to existing events.
create or replace function public.apply_series(p_series uuid, p_from date, p_new_posts uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare s public.event_series;
begin
  select * into s from public.event_series where id = p_series;
  if not found then return; end if;
  perform set_config('koinos.template', 'on', true);

  update public.events e
     set title = s.title, location = s.location, notes = s.notes,
         starts_at = public.local_ts(e.occurrence_date, s.start_time, s.time_zone),
         ends_at   = public.local_end_ts(e.occurrence_date, s.start_time, s.end_time, s.time_zone)
   where e.series_id = s.id and e.occurrence_date >= p_from and not e.is_exception;

  update public.shifts sh
     set post = sp.post, requires_ccw = sp.requires_ccw, note = sp.note, sort_order = sp.sort_order,
         starts_at = case when sp.start_time is null then null else public.local_ts(e.occurrence_date, sp.start_time, s.time_zone) end,
         ends_at   = case when sp.start_time is null then null else public.local_end_ts(e.occurrence_date, sp.start_time, coalesce(sp.end_time, s.end_time), s.time_zone) end
    from public.series_posts sp, public.events e
   where sh.series_post_id = sp.id and sp.series_id = s.id and e.id = sh.event_id
     and e.occurrence_date >= p_from and not e.is_exception and not sh.custom;

  update public.shifts sh
     set roster_id = public.template_roster(sp.id, sp.roster_id, e.occurrence_date)
    from public.series_posts sp, public.events e
   where sh.series_post_id = sp.id and sp.series_id = s.id and e.id = sh.event_id
     and e.occurrence_date >= p_from and not e.is_exception
     and sh.assignee_from_template
     and sh.roster_id is distinct from public.template_roster(sp.id, sp.roster_id, e.occurrence_date);

  insert into public.shifts (event_id, post, requires_ccw, roster_id, assignee_from_template, series_post_id, note, sort_order, starts_at, ends_at)
  select e.id, sp.post, sp.requires_ccw, public.template_roster(sp.id, sp.roster_id, e.occurrence_date), true, sp.id, sp.note, sp.sort_order,
         case when sp.start_time is null then null else public.local_ts(e.occurrence_date, sp.start_time, s.time_zone) end,
         case when sp.start_time is null then null else public.local_end_ts(e.occurrence_date, sp.start_time, coalesce(sp.end_time, s.end_time), s.time_zone) end
    from public.events e
    join public.series_posts sp on sp.series_id = s.id
   where e.series_id = s.id and e.occurrence_date >= p_from and not e.is_exception
     and sp.id = any(coalesce(p_new_posts, '{}'))
     and not exists (select 1 from public.shifts x where x.event_id = e.id and x.series_post_id = sp.id);

  perform set_config('koinos.template', '', true);
end $$;

-- Create any missing events up to ~6 months ahead; optionally remove
-- (non-customized) events from p_from on that no longer fit the pattern.
create or replace function public.materialize_series(p_series uuid, p_from date, p_prune boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  s       public.event_series;
  d       date;
  ev      uuid;
  horizon date := current_date + 182;
begin
  select * into s from public.event_series where id = p_series;
  if not found then return; end if;
  perform set_config('koinos.template', 'on', true);

  if p_prune then
    delete from public.events e
     where e.series_id = s.id and e.occurrence_date >= p_from and not e.is_exception
       and not exists (select 1 from public.series_dates(s, e.occurrence_date, e.occurrence_date));
  end if;

  for d in select * from public.series_dates(s, greatest(p_from, current_date - 1), horizon) loop
    if not exists (select 1 from public.events where series_id = s.id and occurrence_date = d) then
      insert into public.events (title, starts_at, ends_at, location, notes, series_id, occurrence_date)
      values (s.title, public.local_ts(d, s.start_time, s.time_zone),
              public.local_end_ts(d, s.start_time, s.end_time, s.time_zone),
              s.location, s.notes, s.id, d)
      returning id into ev;
      insert into public.shifts (event_id, post, requires_ccw, roster_id, assignee_from_template, series_post_id, note, sort_order, starts_at, ends_at)
      select ev, sp.post, sp.requires_ccw, public.template_roster(sp.id, sp.roster_id, d), true, sp.id, sp.note, sp.sort_order,
             case when sp.start_time is null then null else public.local_ts(d, sp.start_time, s.time_zone) end,
             case when sp.start_time is null then null else public.local_end_ts(d, sp.start_time, coalesce(sp.end_time, s.end_time), s.time_zone) end
        from public.series_posts sp where sp.series_id = s.id;
    end if;
  end loop;
  perform set_config('koinos.template', '', true);
end $$;

-- Called by the app when it loads, so open-ended series keep rolling forward.
create or replace function public.extend_series() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.is_member() then return; end if;
  for r in select id from public.event_series where until is null or until >= current_date loop
    perform public.materialize_series(r.id, current_date, false);
  end loop;
end $$;

-- Save a new event (one-off or repeating) or edit a series.
--   p.series_id  blank = new
--   p.scope      'all' | 'future' (with p.from_date = the occurrence being edited)
--   p.freq       'none' | 'daily' | 'weekly' | 'monthly'
--   p.posts      [{id?, post, requires_ccw, roster_id, note}]
--   p.convert_event_id  turn an existing one-off event into the first of a series
create or replace function public.save_event_series(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sid        uuid := nullif(p->>'series_id', '')::uuid;
  scope      text := coalesce(nullif(p->>'scope', ''), 'all');
  d_from     date := nullif(p->>'from_date', '')::date;
  d_start    date := nullif(p->>'starts_on', '')::date;
  v_freq     text := coalesce(nullif(p->>'freq', ''), 'none');
  cur        public.event_series;
  new_id     uuid;
  ev         uuid;
  pj         jsonb;
  pid        uuid;
  kept       uuid[] := '{}';
  added      uuid[] := '{}';
  id_map     jsonb := '{}';
  apply_from date;
  n          int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can change the schedule'; end if;
  if coalesce(trim(p->>'title'), '') = '' then raise exception 'Enter the service or event name'; end if;
  if nullif(p->>'start_time', '') is null or nullif(p->>'end_time', '') is null then raise exception 'Enter start and end times'; end if;

  -- One-off event (no repeat)
  if sid is null and v_freq = 'none' then
    if d_start is null then raise exception 'Pick a date'; end if;
    insert into public.events (title, starts_at, ends_at, location, notes)
    values (trim(p->>'title'),
            public.local_ts(d_start, (p->>'start_time')::time, coalesce(p->>'time_zone', 'America/New_York')),
            public.local_end_ts(d_start, (p->>'start_time')::time, (p->>'end_time')::time, coalesce(p->>'time_zone', 'America/New_York')),
            coalesce(p->>'location', ''), coalesce(p->>'notes', ''))
    returning id into ev;
    for pj in select * from jsonb_array_elements(coalesce(p->'posts', '[]')) loop
      insert into public.shifts (event_id, post, requires_ccw, roster_id, note, sort_order)
      values (ev, coalesce(pj->>'post', ''), coalesce((pj->>'requires_ccw')::boolean, false),
              nullif(pj->>'roster_id', '')::uuid, coalesce(pj->>'note', ''), n);
      n := n + 1;
    end loop;
    return ev;
  end if;

  if v_freq not in ('daily','weekly','monthly') then raise exception 'Unknown repeat option'; end if;

  if sid is not null then
    select * into cur from public.event_series where id = sid for update;
    if not found then raise exception 'Repeating event not found'; end if;
  end if;

  -- Split: "this and following" from a later date starts a new series there.
  if sid is not null and scope = 'future' and d_from is not null and d_from > cur.starts_on then
    update public.event_series set until = d_from - 1 where id = sid;
    d_start := coalesce(d_start, d_from);
  elsif sid is null then
    if d_start is null then raise exception 'Pick a start date'; end if;
  end if;

  if sid is null or (scope = 'future' and d_from is not null and d_from > cur.starts_on) then
    insert into public.event_series (title, location, notes, start_time, end_time, freq, interval_n, by_weekday, monthly_mode, starts_on, until, time_zone)
    values (trim(p->>'title'), coalesce(p->>'location', ''), coalesce(p->>'notes', ''),
            (p->>'start_time')::time, (p->>'end_time')::time, v_freq,
            coalesce(nullif(p->>'interval_n', '')::int, 1),
            coalesce((select array_agg(x::int) from jsonb_array_elements_text(p->'by_weekday') x), '{}'),
            coalesce(nullif(p->>'monthly_mode', ''), 'day'),
            d_start, nullif(p->>'until', '')::date, coalesce(p->>'time_zone', 'America/New_York'))
    returning id into new_id;

    for pj in select * from jsonb_array_elements(coalesce(p->'posts', '[]')) loop
      insert into public.series_posts (series_id, post, requires_ccw, roster_id, note, sort_order)
      values (new_id, coalesce(pj->>'post', ''), coalesce((pj->>'requires_ccw')::boolean, false),
              nullif(pj->>'roster_id', '')::uuid, coalesce(pj->>'note', ''), n)
      returning id into pid;
      if nullif(pj->>'id', '') is not null then id_map := id_map || jsonb_build_object(pj->>'id', pid);
      else added := added || pid; end if;
      n := n + 1;
    end loop;

    if sid is not null then
      -- Move this and later events into the new series, keeping swaps where the date still fits.
      perform set_config('koinos.template', 'on', true);
      update public.events set series_id = new_id where series_id = sid and occurrence_date >= d_from;
      delete from public.shifts sh using public.events e
       where e.id = sh.event_id and e.series_id = new_id
         and sh.series_post_id is not null and not (id_map ? sh.series_post_id::text);
      update public.shifts sh set series_post_id = (id_map->>sh.series_post_id::text)::uuid
        from public.events e
       where e.id = sh.event_id and e.series_id = new_id and id_map ? sh.series_post_id::text;
      perform set_config('koinos.template', '', true);
      -- Carry the week-of-month rotation over to the new series.
      update public.event_series set use_rotation = cur.use_rotation where id = new_id;
      insert into public.rotation_slots (series_post_id, week_of_month, roster_id)
      select (id_map->>rs.series_post_id::text)::uuid, rs.week_of_month, rs.roster_id
        from public.rotation_slots rs
       where id_map ? rs.series_post_id::text
      on conflict do nothing;
      perform public.apply_series(new_id, d_from, added);
      perform public.materialize_series(new_id, d_from, true);
    else
      if nullif(p->>'convert_event_id', '') is not null then
        update public.events set series_id = new_id, occurrence_date = d_start
         where id = (p->>'convert_event_id')::uuid and series_id is null;
        update public.shifts sh set series_post_id = sp.id,
               assignee_from_template = (sh.roster_id is not distinct from sp.roster_id)
          from public.series_posts sp
         where sh.event_id = (p->>'convert_event_id')::uuid and sp.series_id = new_id
           and sh.post = sp.post and sh.series_post_id is null;
      end if;
      perform public.apply_series(new_id, d_start, added);
      perform public.materialize_series(new_id, d_start, false);
    end if;
    return new_id;
  end if;

  -- Edit the whole series in place (applies from today, or from the edited date on).
  apply_from := greatest(current_date, coalesce(case when scope = 'future' then d_from end, current_date));
  update public.event_series
     set title = trim(p->>'title'), location = coalesce(p->>'location', ''), notes = coalesce(p->>'notes', ''),
         start_time = (p->>'start_time')::time, end_time = (p->>'end_time')::time, freq = v_freq,
         interval_n = coalesce(nullif(p->>'interval_n', '')::int, 1),
         by_weekday = coalesce((select array_agg(x::int) from jsonb_array_elements_text(p->'by_weekday') x), '{}'),
         monthly_mode = coalesce(nullif(p->>'monthly_mode', ''), 'day'),
         starts_on = case when scope = 'future' and d_from = cur.starts_on and d_start is not null then d_start else starts_on end,
         until = nullif(p->>'until', '')::date
   where id = sid;

  for pj in select * from jsonb_array_elements(coalesce(p->'posts', '[]')) loop
    pid := nullif(pj->>'id', '')::uuid;
    if pid is not null and exists (select 1 from public.series_posts where id = pid and series_id = sid) then
      update public.series_posts
         set post = coalesce(pj->>'post', ''), requires_ccw = coalesce((pj->>'requires_ccw')::boolean, false),
             roster_id = nullif(pj->>'roster_id', '')::uuid, note = coalesce(pj->>'note', ''), sort_order = n
       where id = pid;
    else
      insert into public.series_posts (series_id, post, requires_ccw, roster_id, note, sort_order)
      values (sid, coalesce(pj->>'post', ''), coalesce((pj->>'requires_ccw')::boolean, false),
              nullif(pj->>'roster_id', '')::uuid, coalesce(pj->>'note', ''), n)
      returning id into pid;
      added := added || pid;
    end if;
    kept := kept || pid;
    n := n + 1;
  end loop;

  -- Posts removed from the series: remove them from upcoming events too.
  delete from public.shifts sh using public.events e, public.series_posts sp
   where sh.event_id = e.id and sh.series_post_id = sp.id and sp.series_id = sid
     and not (sp.id = any(kept)) and e.occurrence_date >= apply_from and not e.is_exception;
  delete from public.series_posts where series_id = sid and not (id = any(kept));

  perform public.apply_series(sid, apply_from, added);
  perform public.materialize_series(sid, apply_from, true);
  return sid;
end $$;

-- Save the week-of-month rotation and fill the schedule from it (~6 months ahead).
--   p.series   [{series_id, slots: [{series_post_id, week, roster_id}]}]
--   p.replace_changes  true = also overwrite swaps, covers, volunteers and one-off edits
-- Returns {updated, kept, sundays}.
create or replace function public.save_rotation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sj       jsonb;
  sl       jsonb;
  sid      uuid;
  v_replace boolean := coalesce((p->>'replace_changes')::boolean, false);
  sids     uuid[] := '{}';
  n_upd    int := 0;
  n_kept   int := 0;
  n_days   int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can change the schedule'; end if;

  for sj in select * from jsonb_array_elements(coalesce(p->'series', '[]')) loop
    sid := (sj->>'series_id')::uuid;
    if not exists (select 1 from public.event_series where id = sid) then
      raise exception 'Repeating service not found';
    end if;
    sids := sids || sid;
    update public.event_series set use_rotation = true where id = sid;
    for sl in select * from jsonb_array_elements(coalesce(sj->'slots', '[]')) loop
      if not exists (select 1 from public.series_posts where id = (sl->>'series_post_id')::uuid and series_id = sid) then
        continue;  -- post was removed meanwhile
      end if;
      insert into public.rotation_slots (series_post_id, week_of_month, roster_id)
      values ((sl->>'series_post_id')::uuid, (sl->>'week')::int, nullif(sl->>'roster_id', '')::uuid)
      on conflict (series_post_id, week_of_month) do update set roster_id = excluded.roster_id;
    end loop;
  end loop;

  -- Make sure the next ~6 months of dates exist.
  foreach sid in array sids loop
    perform public.materialize_series(sid, current_date, false);
  end loop;

  -- Count what will change (and what is kept) before applying.
  select count(*) filter (where sh.assignee_from_template or v_replace),
         count(*) filter (where not sh.assignee_from_template and not v_replace)
    into n_upd, n_kept
    from public.shifts sh
    join public.events e on e.id = sh.event_id
    join public.series_posts sp on sp.id = sh.series_post_id
   where e.series_id = any(sids) and e.occurrence_date >= current_date and not e.is_exception
     and sh.roster_id is distinct from public.template_roster(sp.id, sp.roster_id, e.occurrence_date);

  if v_replace then
    perform set_config('koinos.template', 'on', true);
    update public.shifts sh set assignee_from_template = true, cover_requested = false
      from public.events e
     where e.id = sh.event_id and e.series_id = any(sids) and e.occurrence_date >= current_date
       and not e.is_exception and sh.series_post_id is not null;
    perform set_config('koinos.template', '', true);
  end if;

  foreach sid in array sids loop
    perform public.apply_series(sid, current_date, '{}');
  end loop;

  select count(distinct e.occurrence_date) into n_days
    from public.events e where e.series_id = any(sids) and e.occurrence_date >= current_date;

  return jsonb_build_object('updated', n_upd, 'kept', n_kept, 'sundays', n_days);
end $$;

-- Stop using the rotation for a service (its posts go back to their default person).
create or replace function public.clear_rotation(p_series uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can change the schedule'; end if;
  update public.event_series set use_rotation = false where id = p_series;
  delete from public.rotation_slots rs using public.series_posts sp
   where sp.id = rs.series_post_id and sp.series_id = p_series;
  perform public.apply_series(p_series, current_date, '{}');
end $$;

revoke all on function public.template_roster(uuid, uuid, date) from public, anon;
revoke all on function public.save_rotation(jsonb) from public, anon;
revoke all on function public.clear_rotation(uuid) from public, anon;
grant execute on function public.template_roster(uuid, uuid, date) to authenticated;
grant execute on function public.save_rotation(jsonb) to authenticated;
grant execute on function public.clear_rotation(uuid) to authenticated;

-- Delete one event of a series, this and following, or the whole series
-- (past events stay on record when deleting "all").
create or replace function public.delete_series_event(p_event uuid, p_scope text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.events; s public.event_series;
begin
  if not public.is_admin() then raise exception 'Only admins can change the schedule'; end if;
  select * into e from public.events where id = p_event;
  if not found then raise exception 'Event not found'; end if;
  if e.series_id is null or p_scope = 'one' then
    if e.series_id is not null then
      update public.event_series set exdates = array_append(exdates, e.occurrence_date) where id = e.series_id;
    end if;
    delete from public.events where id = p_event;
    return;
  end if;
  select * into s from public.event_series where id = e.series_id;
  if p_scope = 'future' and e.occurrence_date > s.starts_on then
    update public.event_series set until = e.occurrence_date - 1 where id = s.id;
    delete from public.events where series_id = s.id and occurrence_date >= e.occurrence_date;
  else
    delete from public.events where series_id = s.id and occurrence_date >= least(current_date, e.occurrence_date);
    delete from public.event_series where id = s.id;
  end if;
end $$;

revoke all on function public.series_dates(public.event_series, date, date) from public, anon;
revoke all on function public.apply_series(uuid, date, uuid[]) from public, anon, authenticated;
revoke all on function public.materialize_series(uuid, date, boolean) from public, anon, authenticated;
revoke all on function public.extend_series() from public, anon;
revoke all on function public.save_event_series(jsonb) from public, anon;
revoke all on function public.delete_series_event(uuid, text) from public, anon;
grant execute on function public.extend_series() to authenticated;
grant execute on function public.save_event_series(jsonb) to authenticated;
grant execute on function public.delete_series_event(uuid, text) to authenticated;

-- CCW check (kept for reference/reporting; volunteering and covering no longer require it).
create or replace function public.ccw_ok(p_roster uuid, p_on date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.roster
                  where id = p_roster and ccw_qualified
                    and (ccw_expires_on is null or ccw_expires_on >= p_on))
$$;

-- Self-service actions for members (they cannot edit shifts directly).
create or replace function public.volunteer_shift(p_shift uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me      uuid := public.my_roster_id();
  s       record;
  my_name text;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  if me is null then raise exception 'Your account is not linked to a roster entry yet. Ask an admin to link it.'; end if;
  select sh.*, e.ends_at as event_end, e.starts_at as event_start into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  if s.roster_id is not null then raise exception 'That post is already filled'; end if;
  -- CCW is preferred, not required: the app flags a mismatch instead of blocking it.
  select name into my_name from public.roster where id = me;
  update public.shifts
     set roster_id = me, cover_requested = false, last_change = my_name || ' volunteered'
   where id = p_shift;
end $$;

create or replace function public.request_cover(p_shift uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me      uuid := public.my_roster_id();
  s       record;
  my_name text;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  select sh.*, e.ends_at as event_end into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if me is null or s.roster_id is distinct from me then raise exception 'You can only ask for cover on your own posts'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  select name into my_name from public.roster where id = me;
  update public.shifts
     set cover_requested = p_on,
         last_change = my_name || case when p_on then ' asked for cover' else ' no longer needs cover' end,
         confirm_state = case when p_on then 'declined' else 'confirmed' end,
         confirmed_at = case when p_on then null else now() end
   where id = p_shift;
  -- Board post for the request (removed again if withdrawn before anyone replied).
  if p_on then
    perform public.ensure_swap_post(p_shift);
  else
    delete from public.posts p
     where p.kind = 'swap' and p.shift_id = p_shift
       and not exists (select 1 from public.post_replies r where r.post_id = p.id);
  end if;
end $$;

create or replace function public.cover_shift(p_shift uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := public.my_roster_id();
  s         record;
  my_name   text;
  prev_name text;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  if me is null then raise exception 'Your account is not linked to a roster entry yet. Ask an admin to link it.'; end if;
  select sh.*, e.ends_at as event_end, e.starts_at as event_start into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  if not s.cover_requested then raise exception 'That post no longer needs cover'; end if;
  if s.roster_id = me then raise exception 'This is already your post'; end if;
  -- CCW is preferred, not required: the app flags a mismatch instead of blocking it.
  select name into my_name from public.roster where id = me;
  select name into prev_name from public.roster where id = s.roster_id;
  update public.shifts
     set roster_id = me, cover_requested = false,
         last_change = my_name || ' is covering for ' || coalesce(prev_name, 'someone')
   where id = p_shift;
  -- Note it on the board thread (also lets the requester know).
  insert into public.post_replies (post_id, author_id, body)
  select p.id, auth.uid(), my_name || ' is covering this.'
    from public.posts p where p.kind = 'swap' and p.shift_id = p_shift;
end $$;

revoke all on function public.volunteer_shift(uuid) from public, anon;
revoke all on function public.request_cover(uuid, boolean) from public, anon;
revoke all on function public.cover_shift(uuid) from public, anon;
revoke all on function public.ccw_ok(uuid, date) from public, anon;
grant execute on function public.volunteer_shift(uuid) to authenticated;
grant execute on function public.request_cover(uuid, boolean) to authenticated;
grant execute on function public.cover_shift(uuid) to authenticated;
grant execute on function public.ccw_ok(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- Calendar subscriptions: each person can make private links (a long
-- random token) that calendar apps poll. Deleting the link revokes it.
-- ---------------------------------------------------------------------
create table if not exists public.calendar_feeds (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name        text not null,
  roster_id   uuid references public.roster(id) on delete cascade,   -- blank = whole team
  token       text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at  timestamptz not null default now()
);

alter table public.calendar_feeds enable row level security;
drop policy if exists calendar_feeds_select on public.calendar_feeds;
drop policy if exists calendar_feeds_insert on public.calendar_feeds;
drop policy if exists calendar_feeds_delete on public.calendar_feeds;
create policy calendar_feeds_select on public.calendar_feeds for select to authenticated
  using (profile_id = auth.uid() and public.is_member());
create policy calendar_feeds_insert on public.calendar_feeds for insert to authenticated
  with check (profile_id = auth.uid() and public.is_member());
create policy calendar_feeds_delete on public.calendar_feeds for delete to authenticated
  using (profile_id = auth.uid());
revoke all on public.calendar_feeds from anon, authenticated;
grant select, insert, delete on public.calendar_feeds to authenticated;

-- Used by the calendar link (no sign-in; the token is the key).
-- Stops working if the link is deleted or its owner loses access.
create or replace function public.calendar_feed(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare f record;
begin
  select cf.name, cf.roster_id, p.role into f
    from public.calendar_feeds cf join public.profiles p on p.id = cf.profile_id
   where cf.token = p_token;
  if not found or f.role not in ('member','admin','superuser') then
    raise exception 'Calendar not found';
  end if;
  return jsonb_build_object(
    'name', f.name,
    'filtered', f.roster_id is not null,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'shift_id', s.id,
               'event_title', e.title,
               'post', s.post,
               'starts_at', coalesce(s.starts_at, e.starts_at),
               'ends_at', coalesce(s.ends_at, e.ends_at),
               'location', e.location,
               'notes', e.notes,
               'person', r.name,
               'roster_id', s.roster_id,
               'cover_requested', s.cover_requested,
               'requires_ccw', s.requires_ccw,
               'updated_at', greatest(s.updated_at, e.updated_at))
             order by coalesce(s.starts_at, e.starts_at))
        from public.shifts s
        join public.events e on e.id = s.event_id
        left join public.roster r on r.id = s.roster_id
       where e.ends_at > now() - interval '60 days'
         and (f.roster_id is null or s.roster_id = f.roster_id)
    ), '[]'::jsonb));
end $$;

revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Row-level security: members read, admins write. Nobody signed out
-- (and nobody still pending approval) can see anything.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sops','sop_categories','contacts','bulletins','roster','events','shifts','event_series','series_posts','rotation_slots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_delete', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- Team board: posts with replies and photos. Swap/cover posts are tied to
-- a schedule post (shift). Unpinned threads are removed 90 days after
-- their last activity (see purge_board); admins can pin to keep them.
-- ---------------------------------------------------------------------
create table if not exists public.posts (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid default auth.uid() references public.profiles(id) on delete set null,
  kind              text not null default 'general' check (kind in ('general','swap','intro')),
  body              text not null default '',
  photo_path        text,
  shift_id          uuid references public.shifts(id) on delete set null,   -- swap: the post being offered
  roster_id         uuid references public.roster(id) on delete set null,   -- intro: who is being welcomed
  pinned            boolean not null default false,
  edited_at         timestamptz,
  last_activity_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  notified_at       timestamptz
);
create index if not exists posts_activity_idx on public.posts(last_activity_at desc);
-- Cover/swap posts are archived (hidden) as soon as the schedule no longer needs
-- cover, then deleted by purge_board about an hour later.
alter table public.posts add column if not exists resolved_at timestamptz;
create unique index if not exists posts_swap_shift_key on public.posts(shift_id) where kind = 'swap' and shift_id is not null;

create table if not exists public.post_replies (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.posts(id) on delete cascade,
  author_id    uuid default auth.uid() references public.profiles(id) on delete set null,
  body         text not null default '',
  photo_path   text,
  edited_at    timestamptz,
  created_at   timestamptz not null default now(),
  notified_at  timestamptz
);
create index if not exists post_replies_post_idx on public.post_replies(post_id);

alter table public.bulletins add column if not exists notified_at timestamptz;

-- Keep authorship, kind and pinning honest; stamp edits.
create or replace function public.posts_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.last_activity_at := now();
    new.notified_at := null;
    new.edited_at := null;
    if not public.is_admin() then new.pinned := false; end if;
  else
    new.author_id := old.author_id;
    new.kind := old.kind;
    new.shift_id := old.shift_id;
    new.roster_id := old.roster_id;
    new.created_at := old.created_at;
    if auth.uid() is not null and not public.is_admin() then new.pinned := old.pinned; end if;
    -- (Filling in the message in the same step that created the post, as a
    -- cover request does, isn't an edit.)
    if (new.body, new.photo_path) is distinct from (old.body, old.photo_path) and old.created_at <> now() then
      new.edited_at := now();
      new.last_activity_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists posts_guard on public.posts;
create trigger posts_guard before insert or update on public.posts
  for each row execute function public.posts_guard();

create or replace function public.post_replies_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.notified_at := null;
    new.edited_at := null;
  else
    new.post_id := old.post_id;
    new.author_id := old.author_id;
    new.created_at := old.created_at;
    if (new.body, new.photo_path) is distinct from (old.body, old.photo_path) then new.edited_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists post_replies_guard on public.post_replies;
create trigger post_replies_guard before insert or update on public.post_replies
  for each row execute function public.post_replies_guard();

-- A reply keeps its thread alive (resets the 90-day clock).
create or replace function public.post_replies_bump() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.posts set last_activity_at = now() where id = new.post_id;
  return null;
end $$;
drop trigger if exists post_replies_bump on public.post_replies;
create trigger post_replies_bump after insert on public.post_replies
  for each row execute function public.post_replies_bump();

alter table public.posts enable row level security;
alter table public.post_replies enable row level security;
drop policy if exists posts_select on public.posts;
drop policy if exists posts_insert on public.posts;
drop policy if exists posts_update on public.posts;
drop policy if exists posts_delete on public.posts;
create policy posts_select on public.posts for select to authenticated using (public.is_member());
-- Swap posts linked to a schedule post are created through request_cover / create_swap_post.
create policy posts_insert on public.posts for insert to authenticated
  with check (public.is_member() and author_id = auth.uid() and (kind <> 'swap' or shift_id is null) and roster_id is null);
create policy posts_update on public.posts for update to authenticated
  using (public.is_member() and (author_id = auth.uid() or public.is_admin()));
create policy posts_delete on public.posts for delete to authenticated
  using (public.is_member() and (author_id = auth.uid() or public.is_admin()));
drop policy if exists post_replies_select on public.post_replies;
drop policy if exists post_replies_insert on public.post_replies;
drop policy if exists post_replies_update on public.post_replies;
drop policy if exists post_replies_delete on public.post_replies;
create policy post_replies_select on public.post_replies for select to authenticated using (public.is_member());
create policy post_replies_insert on public.post_replies for insert to authenticated
  with check (public.is_member() and author_id = auth.uid());
create policy post_replies_update on public.post_replies for update to authenticated
  using (public.is_member() and author_id = auth.uid());
create policy post_replies_delete on public.post_replies for delete to authenticated
  using (public.is_member() and (author_id = auth.uid() or public.is_admin()));
revoke all on public.posts, public.post_replies from anon, authenticated;
grant select, insert, update, delete on public.posts, public.post_replies to authenticated;

-- Create (or re-open) the board post for a cover request on a schedule post.
create or replace function public.ensure_swap_post(p_shift uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s    record;
  body text;
  pid  uuid;
begin
  select sh.post, e.title, coalesce(sh.starts_at, e.starts_at) as st into s
    from public.shifts sh join public.events e on e.id = sh.event_id where sh.id = p_shift;
  if not found then return null; end if;
  body := 'Can anyone cover ' || coalesce(nullif(s.post, ''), 'my post') || ' at ' || s.title || ' on '
          || to_char(s.st at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') || '?';
  insert into public.posts (author_id, kind, body, shift_id)
  values (auth.uid(), 'swap', body, p_shift)
  on conflict (shift_id) where kind = 'swap' and shift_id is not null
  do update set author_id = excluded.author_id, body = excluded.body,
                last_activity_at = now(), notified_at = null, resolved_at = null
  returning id into pid;
  return pid;
end $$;
revoke all on function public.ensure_swap_post(uuid) from public, anon, authenticated;

-- When a post stops needing cover (someone covered it, an admin reassigned it,
-- or the request was withdrawn), archive its board post.
create or replace function public.shifts_resolve_swap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.cover_requested and not new.cover_requested then
    update public.posts set resolved_at = now()
     where kind = 'swap' and shift_id = new.id and resolved_at is null;
  end if;
  return null;
end $$;
drop trigger if exists shifts_resolve_swap on public.shifts;
-- (no column list: cover_requested is often cleared by another trigger, not the UPDATE itself)
create trigger shifts_resolve_swap after update on public.shifts
  for each row execute function public.shifts_resolve_swap();

-- Ask for cover from the board, with an optional message.
create or replace function public.create_swap_post(p_shift uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  perform public.request_cover(p_shift, true);
  select id into pid from public.posts where kind = 'swap' and shift_id = p_shift;
  if coalesce(trim(p_body), '') <> '' then
    update public.posts set body = left(trim(p_body), 4000) where id = pid;
  end if;
  return pid;
end $$;
revoke all on function public.create_swap_post(uuid, text) from public, anon;
grant execute on function public.create_swap_post(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Shift confirmations. About 2½ days before a shift (7 PM on the evening
-- that falls 48–72 hours before it, e.g. Thursday evening for Sunday
-- morning) the assigned person gets "Are you still on?" with a reminder the
-- next evening if they haven't answered. Sent by the scheduled Netlify
-- function netlify/functions/shift-reminders.mjs.
--   none       not asked yet
--   asked      asked, no answer yet
--   confirmed  said yes (or volunteered/covered it themselves)
--   declined   said no / asked for cover
-- shift_confirm_tokens lets the notification's "Yes" button confirm without
-- opening the app (see netlify/functions/shift-reply.mjs). Only the server
-- can read it.
-- ---------------------------------------------------------------------
alter table public.shifts add column if not exists confirm_state text not null default 'none';
alter table public.shifts add column if not exists confirm_asked_at timestamptz;
alter table public.shifts add column if not exists confirm_reminded_at timestamptz;
alter table public.shifts add column if not exists confirmed_at timestamptz;
do $$ begin
  alter table public.shifts add constraint shifts_confirm_state_check check (confirm_state in ('none','asked','confirmed','declined'));
exception when duplicate_object then null; end $$;

create table if not exists public.shift_confirm_tokens (
  token       text primary key,
  shift_id    uuid not null references public.shifts(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists shift_confirm_tokens_shift_idx on public.shift_confirm_tokens(shift_id);
alter table public.shift_confirm_tokens enable row level security;   -- no policies: server only
revoke all on public.shift_confirm_tokens from anon, authenticated;

-- A new person on the post, or a new time, starts over. Someone who takes a
-- post themselves (volunteers or covers) has obviously confirmed it.
create or replace function public.shifts_confirm_reset() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  from_template boolean := coalesce(current_setting('koinos.template', true), '') = 'on';
begin
  if new.roster_id is distinct from old.roster_id then
    new.confirm_asked_at := null; new.confirm_reminded_at := null;
    delete from public.shift_confirm_tokens where shift_id = new.id;
    if new.roster_id is not null and not from_template and auth.uid() is not null
       and new.roster_id = public.my_roster_id() then
      new.confirm_state := 'confirmed'; new.confirmed_at := now();
    else
      new.confirm_state := 'none'; new.confirmed_at := null;
    end if;
  elsif (new.starts_at, new.ends_at) is distinct from (old.starts_at, old.ends_at)
        and new.confirm_state in ('asked','confirmed') then
    new.confirm_state := 'none'; new.confirmed_at := null;
    new.confirm_asked_at := null; new.confirm_reminded_at := null;
    delete from public.shift_confirm_tokens where shift_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists shifts_confirm on public.shifts;
create trigger shifts_confirm before update on public.shifts
  for each row execute function public.shifts_confirm_reset();

-- An event moved to a different time: everyone on it is asked again.
create or replace function public.events_confirm_reset() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.starts_at is distinct from old.starts_at then
    update public.shifts
       set confirm_state = 'none', confirmed_at = null, confirm_asked_at = null, confirm_reminded_at = null
     where event_id = new.id and starts_at is null and confirm_state in ('asked','confirmed');
    delete from public.shift_confirm_tokens t using public.shifts sh
     where t.shift_id = sh.id and sh.event_id = new.id and sh.starts_at is null and sh.confirm_state = 'none';
  end if;
  return null;
end $$;
drop trigger if exists events_confirm_reset on public.events;
create trigger events_confirm_reset after update on public.events
  for each row execute function public.events_confirm_reset();

-- "Yes, I'll be there" from the app.
create or replace function public.confirm_shift(p_shift uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.my_roster_id();
  s  record;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  select sh.*, e.ends_at as event_end into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if me is null or s.roster_id is distinct from me then raise exception 'This post isn''t assigned to you any more.'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  if s.cover_requested then raise exception 'You''ve asked for cover on this post. Withdraw the request on the board first if you can make it after all.'; end if;
  update public.shifts set confirm_state = 'confirmed', confirmed_at = now() where id = p_shift;
end $$;
revoke all on function public.confirm_shift(uuid) from public, anon;
grant execute on function public.confirm_shift(uuid) to authenticated;

-- The notification's "Yes" button (server only: netlify/functions/shift-reply.mjs).
-- Returns what the post's state is afterwards: confirmed, declined, over or gone.
create or replace function public.confirm_shift_by_token(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select sh.id, sh.confirm_state, sh.cover_requested, e.ends_at as event_end into s
    from public.shift_confirm_tokens t
    join public.shifts sh on sh.id = t.shift_id
    join public.events e on e.id = sh.event_id
   where t.token = p_token
   for update of sh;
  if not found then return 'gone'; end if;
  if s.event_end < now() then return 'over'; end if;
  if s.cover_requested then return 'declined'; end if;
  update public.shifts set confirm_state = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
   where id = s.id and confirm_state in ('none','asked','confirmed');
  return 'confirmed';
end $$;
revoke all on function public.confirm_shift_by_token(text) from public, anon, authenticated;
grant execute on function public.confirm_shift_by_token(text) to service_role;

-- Welcome post when a roster entry is first linked to an app account.
create or replace function public.roster_intro_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.profile_id is not null and new.active and auth.uid() is not null
     and (tg_op = 'INSERT' or old.profile_id is null)
     and not exists (select 1 from public.posts where kind = 'intro' and roster_id = new.id) then
    insert into public.posts (author_id, kind, roster_id, body)
    values (auth.uid(), 'intro', new.id,
            'Please welcome ' || new.name || ' to the security team!'
            || case when coalesce(new.position, '') <> '' then ' (' || new.position || ')' else '' end);
  end if;
  return null;
end $$;
drop trigger if exists roster_intro_post on public.roster;
create trigger roster_intro_post after insert or update of profile_id on public.roster
  for each row execute function public.roster_intro_post();

update public.posts p set resolved_at = now()
  from public.shifts sh
 where p.kind = 'swap' and p.shift_id = sh.id and not sh.cover_requested and p.resolved_at is null;

-- Delete unpinned threads with no activity for 90 days. Returns the photo
-- paths that were in use so the app can remove the files.
create or replace function public.purge_board() returns text[]
language plpgsql security definer set search_path = public as $$
declare
  paths text[];
  ids   uuid[];
begin
  if not public.is_member() then return '{}'; end if;
  select array_agg(id) into ids from public.posts p
   where (not p.pinned and p.last_activity_at < now() - interval '90 days')
      -- settled cover/swap requests (kept ~1 hour so the "covering" notice goes out)
      or (p.kind = 'swap' and not p.pinned and (
            p.resolved_at < now() - interval '1 hour'
         or p.shift_id is null
         or exists (select 1 from public.shifts sh join public.events e on e.id = sh.event_id
                     where sh.id = p.shift_id and e.ends_at < now())));
  if ids is null then return '{}'; end if;
  select array_agg(x) into paths from (
    select photo_path x from public.posts where id = any(ids) and photo_path is not null
    union all
    select photo_path from public.post_replies where post_id = any(ids) and photo_path is not null) t;
  delete from public.posts where id = any(ids);
  return coalesce(paths, '{}');
end $$;
revoke all on function public.purge_board() from public, anon;
grant execute on function public.purge_board() to authenticated;

-- ---------------------------------------------------------------------
-- Push notifications: one row per device that allowed notifications.
-- Sent by the Netlify function netlify/functions/push.mjs.
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text not null default '',
  created_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (profile_id = auth.uid());
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

alter table public.profiles add column if not exists notify_posts   boolean not null default true;
alter table public.profiles add column if not exists notify_replies boolean not null default true;
alter table public.profiles add column if not exists notify_cover   boolean not null default true;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' then raise exception 'Invalid subscription'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;   -- device may have changed hands
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua, ''), 300));
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and profile_id = auth.uid()
$$;

create or replace function public.update_my_notify(p_posts boolean, p_replies boolean, p_cover boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  update public.profiles
     set notify_posts = coalesce(p_posts, notify_posts),
         notify_replies = coalesce(p_replies, notify_replies),
         notify_cover = coalesce(p_cover, notify_cover)
   where id = auth.uid();
end $$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
revoke all on function public.update_my_notify(boolean, boolean, boolean) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.update_my_notify(boolean, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Attendance count: the weekly "Worship Service Count" form.
--   attendance_settings   one row: services (First/Second…), who gets the
--                         email, and when it is sent
--   attendance_sections   the form's sections (Worship Center, KidzZone…)
--   attendance_fields     the lines in each section (Children, Adults…)
--   attendance_counts     one per date + service: open (in progress) or
--                         submitted, with its total and email status
--   attendance_values     one row per line counted; the section and line
--                         names are copied in, so renaming or removing a
--                         line later never changes old counts
--   attendance_report     view: date, service, area, count — one row per
--                         line plus a "Total" row per service (for exports)
-- Members start, fill in and submit counts; once submitted, only admins
-- can correct it. Admins edit the form. Emails are sent by the Netlify
-- function netlify/functions/attendance-email.mjs.
-- ---------------------------------------------------------------------
create table if not exists public.attendance_settings (
  id           int primary key default 1 check (id = 1),
  services     jsonb not null default '[{"no":1,"label":"First Service","time":"09:00"},{"no":2,"label":"Second Service","time":"10:45"}]',
  recipients   text[] not null default '{}',
  email_when   text not null default 'each' check (email_when in ('each','day')),  -- each = after every service; day = once all services that day are in
  reply_to     text not null default '',        -- blank = replies go to whoever submitted
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id) on delete set null
);
insert into public.attendance_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.attendance_sections (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  sort_order  int  not null default 0
);

create table if not exists public.attendance_fields (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references public.attendance_sections(id) on delete cascade,
  label       text not null,
  in_total    boolean not null default true,    -- added into the service total
  sort_order  int  not null default 0
);
create index if not exists attendance_fields_section_idx on public.attendance_fields(section_id);

create table if not exists public.attendance_counts (
  id                uuid primary key default gen_random_uuid(),
  service_date      date not null,
  service_no        int  not null check (service_no between 1 and 20),
  service_label     text not null default '',
  status            text not null default 'open' check (status in ('open','submitted')),
  total             int  not null default 0,
  notes             text not null default '',
  started_by        uuid references public.profiles(id) on delete set null,
  started_at        timestamptz not null default now(),
  submitted_by      uuid references public.profiles(id) on delete set null,
  submitted_at      timestamptz,
  corrected_by      uuid references public.profiles(id) on delete set null,
  corrected_at      timestamptz,
  corrections       int  not null default 0,
  -- none → pending (waiting for the email function) → sending → sent | failed
  -- waiting = "email once all services are in" and the others aren't yet
  email_state       text not null default 'none' check (email_state in ('none','pending','sending','waiting','sent','failed')),
  email_error       text not null default '',
  emailed_at        timestamptz,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id) on delete set null,
  unique (service_date, service_no)
);
create index if not exists attendance_counts_date_idx on public.attendance_counts(service_date desc);

create table if not exists public.attendance_values (
  count_id       uuid not null references public.attendance_counts(id) on delete cascade,
  field_key      text not null,              -- the form line's id when it was counted
  section_title  text not null default '',
  field_label    text not null default '',
  in_total       boolean not null default true,
  sort_order     int  not null default 0,
  value          int  check (value between 0 and 100000),   -- blank = not counted yet
  primary key (count_id, field_key)
);

-- Starting form, copied from the paper "Worship Service Count" (only if the form is empty).
do $$
declare s uuid;
begin
  if not exists (select 1 from public.attendance_sections) then
    insert into public.attendance_sections (title, sort_order) values ('Worship Center', 1) returning id into s;
    insert into public.attendance_fields (section_id, label, sort_order) values (s, 'People after children are dismissed', 1);
    insert into public.attendance_sections (title, sort_order) values ('KidzZone', 2) returning id into s;
    insert into public.attendance_fields (section_id, label, sort_order) values (s, 'Children', 1), (s, 'Adults', 2);
    insert into public.attendance_sections (title, sort_order) values ('Nursery', 3) returning id into s;
    insert into public.attendance_fields (section_id, label, sort_order) values (s, 'Children', 1), (s, 'Adults', 2);
    insert into public.attendance_sections (title, sort_order) values ('Preschool', 4) returning id into s;
    insert into public.attendance_fields (section_id, label, sort_order) values (s, 'Children', 1), (s, 'Adults', 2);
  end if;
end $$;

-- Everyone on the team can read; changes go through the functions below
-- (plus: admins can delete a count, and whoever started an open count can discard it).
do $$
declare t text;
begin
  foreach t in array array['attendance_settings','attendance_sections','attendance_fields','attendance_counts','attendance_values'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())', t || '_select', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
drop policy if exists attendance_counts_delete on public.attendance_counts;
create policy attendance_counts_delete on public.attendance_counts for delete to authenticated
  using (public.is_admin() or (status = 'open' and started_by = auth.uid() and public.is_member()));
grant delete on public.attendance_counts to authenticated;

create or replace view public.attendance_report with (security_invoker = true) as
  select c.service_date, c.service_no, c.service_label, c.status,
         v.sort_order, v.section_title, v.field_label, v.in_total, v.value
    from public.attendance_counts c join public.attendance_values v on v.count_id = c.id
  union all
  select c.service_date, c.service_no, c.service_label, c.status,
         1000000, '', 'Total', false, c.total
    from public.attendance_counts c;
revoke all on public.attendance_report from anon, authenticated;
grant select on public.attendance_report to authenticated;

-- Admins: save the whole setup at once (settings, services, sections and lines).
-- p = { services: [{no,label,time}], recipients: [..], email_when, reply_to,
--       sections: [{id?, title, fields: [{id?, label, in_total}]}] }
-- Sections/lines left out are removed (old counts keep their copied names).
create or replace function public.attendance_save_setup(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  sec jsonb; fld jsonb; svc jsonb;
  s_id uuid; f_id uuid;
  keep_s uuid[] := '{}'; keep_f uuid[] := '{}';
  i int := 0; j int;
  nos int[] := '{}';
  em text;
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;

  if jsonb_typeof(p->'services') <> 'array' or jsonb_array_length(p->'services') = 0 then
    raise exception 'Add at least one service.';
  end if;
  for svc in select * from jsonb_array_elements(p->'services') loop
    if coalesce(trim(svc->>'label'), '') = '' then raise exception 'Every service needs a name.'; end if;
    if (svc->>'no')::int is null or (svc->>'no')::int not between 1 and 20 or (svc->>'no')::int = any(nos) then
      raise exception 'Service numbers must be different (1–20).';
    end if;
    if coalesce(svc->>'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Give each service a start time.'; end if;
    nos := nos || (svc->>'no')::int;
  end loop;
  foreach em in array coalesce(array(select jsonb_array_elements_text(p->'recipients')), '{}') loop
    if em !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception '"%" is not an email address.', em; end if;
  end loop;
  if coalesce(p->>'reply_to', '') <> '' and p->>'reply_to' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Reply-to must be an email address (or blank).';
  end if;

  update public.attendance_settings
     set services = (select jsonb_agg(jsonb_build_object('no', (e->>'no')::int, 'label', trim(e->>'label'), 'time', e->>'time')
                                      order by e->>'time')
                       from jsonb_array_elements(p->'services') e),
         recipients = coalesce(array(select lower(trim(x)) from jsonb_array_elements_text(p->'recipients') x where trim(x) <> ''), '{}'),
         email_when = case when p->>'email_when' = 'day' then 'day' else 'each' end,
         reply_to = lower(trim(coalesce(p->>'reply_to', ''))),
         updated_at = now(), updated_by = auth.uid()
   where id = 1;

  for sec in select * from jsonb_array_elements(coalesce(p->'sections', '[]')) loop
    i := i + 1;
    if coalesce(trim(sec->>'title'), '') = '' then raise exception 'Every section needs a name.'; end if;
    s_id := nullif(sec->>'id', '')::uuid;
    if s_id is not null and exists (select 1 from public.attendance_sections where id = s_id) then
      update public.attendance_sections set title = trim(sec->>'title'), sort_order = i where id = s_id;
    else
      insert into public.attendance_sections (title, sort_order) values (trim(sec->>'title'), i) returning id into s_id;
    end if;
    keep_s := keep_s || s_id;
    j := 0;
    for fld in select * from jsonb_array_elements(coalesce(sec->'fields', '[]')) loop
      j := j + 1;
      if coalesce(trim(fld->>'label'), '') = '' then raise exception 'Every line in "%" needs a name.', trim(sec->>'title'); end if;
      f_id := nullif(fld->>'id', '')::uuid;
      if f_id is not null and exists (select 1 from public.attendance_fields where id = f_id) then
        update public.attendance_fields
           set section_id = s_id, label = trim(fld->>'label'), in_total = coalesce((fld->>'in_total')::boolean, true), sort_order = j
         where id = f_id;
      else
        insert into public.attendance_fields (section_id, label, in_total, sort_order)
        values (s_id, trim(fld->>'label'), coalesce((fld->>'in_total')::boolean, true), j) returning id into f_id;
      end if;
      keep_f := keep_f || f_id;
    end loop;
    if j = 0 then raise exception 'Section "%" needs at least one line to count.', trim(sec->>'title'); end if;
  end loop;
  if i = 0 then raise exception 'The form needs at least one section.'; end if;

  delete from public.attendance_fields where not (id = any(keep_f));
  delete from public.attendance_sections where not (id = any(keep_s));
end $$;

-- Recalculate a count's total from its lines.
create or replace function public.attendance_total(p_count uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(value) filter (where in_total), 0)::int from public.attendance_values where count_id = p_count
$$;

-- Start, save (autosave), submit, or (admins) correct a count.
--   p_values  { "<line id>": number or null, … }  — lines left out keep their value
--   p_notes   null = leave notes as they are
--   p_submit  true = submit (or, for an admin on a submitted count, save the correction)
--   p_email   false = an admin correction that should not be emailed again
create or replace function public.attendance_save(p_date date, p_service int, p_values jsonb, p_notes text,
                                                  p_submit boolean, p_email boolean default true)
returns public.attendance_counts
language plpgsql security definer set search_path = public as $$
declare
  c public.attendance_counts;
  svc jsonb;
  vals jsonb := coalesce(p_values, '{}');
  who text;
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  if p_date is null or p_service is null then raise exception 'Pick a date and service.'; end if;
  if p_date > (now() at time zone 'America/New_York')::date then raise exception 'That date hasn''t happened yet.'; end if;
  if jsonb_typeof(vals) <> 'object' then raise exception 'Invalid counts'; end if;

  select * into c from public.attendance_counts where service_date = p_date and service_no = p_service for update;
  if not found then
    select e into svc from public.attendance_settings s, jsonb_array_elements(s.services) e
     where s.id = 1 and (e->>'no')::int = p_service;
    if svc is null then raise exception 'That service isn''t on the form any more.'; end if;
    insert into public.attendance_counts (service_date, service_no, service_label, started_by, updated_by)
    values (p_date, p_service, svc->>'label', auth.uid(), auth.uid())
    on conflict (service_date, service_no) do nothing;
    select * into c from public.attendance_counts where service_date = p_date and service_no = p_service for update;
  end if;

  -- Once submitted, only an admin's deliberate correction (p_submit) can change it,
  -- never an autosave from a screen that was opened before it was submitted.
  if c.status = 'submitted' and not (public.is_admin() and p_submit) then
    select coalesce(nullif(full_name, ''), email) into who from public.profiles where id = c.submitted_by;
    raise exception 'This count was already submitted by % on %. Ask an admin if it needs a correction.',
      coalesce(who, 'someone'), to_char(c.submitted_at at time zone 'America/New_York', 'Mon FMDD at FMHH12:MI AM');
  end if;

  if c.status = 'open' then
    -- Open counts always follow the current form: add new lines, drop removed ones.
    insert into public.attendance_values (count_id, field_key, section_title, field_label, in_total, sort_order, value)
    select c.id, f.id::text, s.title, f.label, f.in_total, s.sort_order * 1000 + f.sort_order,
           case when vals ? f.id::text then nullif(vals->>f.id::text, '')::numeric::int
                else (select v.value from public.attendance_values v where v.count_id = c.id and v.field_key = f.id::text) end
      from public.attendance_fields f join public.attendance_sections s on s.id = f.section_id
    on conflict (count_id, field_key) do update
      set section_title = excluded.section_title, field_label = excluded.field_label,
          in_total = excluded.in_total, sort_order = excluded.sort_order, value = excluded.value;
    delete from public.attendance_values v
     where v.count_id = c.id and not exists (select 1 from public.attendance_fields f where f.id::text = v.field_key);
  else
    -- A correction keeps the lines exactly as they were when it was counted.
    update public.attendance_values v
       set value = nullif(vals->>v.field_key, '')::numeric::int
     where v.count_id = c.id and vals ? v.field_key;
  end if;

  update public.attendance_counts
     set total = public.attendance_total(c.id),
         notes = coalesce(left(p_notes, 2000), notes),
         updated_at = now(), updated_by = auth.uid()
   where id = c.id;

  if p_submit then
    if c.status = 'open' then
      update public.attendance_counts
         set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
             email_state = 'pending', email_error = ''
       where id = c.id;
    else
      update public.attendance_counts
         set corrected_by = auth.uid(), corrected_at = now(), corrections = corrections + 1,
             email_state = case when p_email then 'pending' else email_state end,
             email_error = case when p_email then '' else email_error end
       where id = c.id;
    end if;
  end if;

  select * into c from public.attendance_counts where id = c.id;
  return c;
end $$;

-- Send the email again: admins any time; whoever submitted it if sending failed.
create or replace function public.attendance_resend(p_count uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Not authorized'; end if;
  update public.attendance_counts
     set email_state = 'pending', email_error = ''
   where id = p_count and status = 'submitted'
     and (public.is_admin() or (submitted_by = auth.uid() and email_state = 'failed'));
  if not found then raise exception 'Only an admin can resend this.'; end if;
end $$;

revoke all on function public.attendance_save_setup(jsonb) from public, anon;
revoke all on function public.attendance_total(uuid) from public, anon, authenticated;
revoke all on function public.attendance_save(date, int, jsonb, text, boolean, boolean) from public, anon;
revoke all on function public.attendance_resend(uuid) from public, anon;
grant execute on function public.attendance_save_setup(jsonb) to authenticated;
grant execute on function public.attendance_save(date, int, jsonb, text, boolean, boolean) to authenticated;
grant execute on function public.attendance_resend(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Photo storage (private bucket; members view, admins upload)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos_select" on storage.objects;
drop policy if exists "photos_insert" on storage.objects;
drop policy if exists "photos_update" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;

create policy "photos_select" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());
create policy "photos_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_admin());
create policy "photos_update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.is_admin());
create policy "photos_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_admin());

-- Board photos: members upload under board/<their id>/. Files can be removed by
-- their owner, by admins, or by anyone once no post or reply uses them (cleanup).
drop policy if exists "photos_board_insert" on storage.objects;
drop policy if exists "photos_board_delete" on storage.objects;
create policy "photos_board_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member()
              and (storage.foldername(name))[1] = 'board'
              and (storage.foldername(name))[2] = auth.uid()::text);
create policy "photos_board_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member()
         and (storage.foldername(name))[1] = 'board'
         and ((storage.foldername(name))[2] = auth.uid()::text
              or (not exists (select 1 from public.posts p where p.photo_path = name)
                  and not exists (select 1 from public.post_replies r where r.photo_path = name))));

-- Members may upload and remove their own profile photo under self/<their id>/.
drop policy if exists "photos_self_insert" on storage.objects;
drop policy if exists "photos_self_delete" on storage.objects;
create policy "photos_self_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member()
              and (storage.foldername(name))[1] = 'self'
              and (storage.foldername(name))[2] = auth.uid()::text);
create policy "photos_self_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member()
         and (storage.foldername(name))[1] = 'self'
         and (storage.foldername(name))[2] = auth.uid()::text);

-- ---------------------------------------------------------------------
-- Live updates: push bulletin and schedule changes to open apps immediately
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bulletins','events','shifts','posts','post_replies','attendance_counts'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- =====================================================================
-- AFTER you sign in to the app for the first time, make yourself a
-- superuser by running this (with your email) in a new query:
--
--   update public.profiles set role = 'superuser' where email = 'you@example.com';
--
-- Do the same later for the other 2–3 superusers once they have signed in.
-- =====================================================================
