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
  if tg_op = 'INSERT' then
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
     set roster_id = sp.roster_id
    from public.series_posts sp, public.events e
   where sh.series_post_id = sp.id and sp.series_id = s.id and e.id = sh.event_id
     and e.occurrence_date >= p_from and not e.is_exception
     and sh.assignee_from_template and sh.roster_id is distinct from sp.roster_id;

  insert into public.shifts (event_id, post, requires_ccw, roster_id, assignee_from_template, series_post_id, note, sort_order, starts_at, ends_at)
  select e.id, sp.post, sp.requires_ccw, sp.roster_id, true, sp.id, sp.note, sp.sort_order,
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
      select ev, sp.post, sp.requires_ccw, sp.roster_id, true, sp.id, sp.note, sp.sort_order,
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

-- CCW check used by self-service volunteering and covering.
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
  if s.requires_ccw and not public.ccw_ok(me, (s.event_start at time zone 'America/New_York')::date) then
    raise exception 'This post needs a CCW-qualified team member, and your CCW qualification is missing or expires before this date.';
  end if;
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
         last_change = my_name || case when p_on then ' asked for cover' else ' no longer needs cover' end
   where id = p_shift;
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
  if s.requires_ccw and not public.ccw_ok(me, (s.event_start at time zone 'America/New_York')::date) then
    raise exception 'This post needs a CCW-qualified team member, and your CCW qualification is missing or expires before this date.';
  end if;
  select name into my_name from public.roster where id = me;
  select name into prev_name from public.roster where id = s.roster_id;
  update public.shifts
     set roster_id = me, cover_requested = false,
         last_change = my_name || ' is covering for ' || coalesce(prev_name, 'someone')
   where id = p_shift;
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
  foreach t in array array['sops','contacts','bulletins','roster','events','shifts','event_series','series_posts'] loop
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

-- ---------------------------------------------------------------------
-- Live updates: push bulletin and schedule changes to open apps immediately
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bulletins','events','shifts'] loop
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
