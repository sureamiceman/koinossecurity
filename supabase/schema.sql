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
      ('roster', 'medical_notes'), ('profiles', 'email')
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

-- When an admin reassigns a post directly, note it and clear any cover request.
create or replace function public.shifts_track_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if new.roster_id is distinct from old.roster_id then
    new.cover_requested := false;
    if new.last_change is not distinct from old.last_change then
      select full_name into who from public.profiles where id = auth.uid();
      new.last_change := 'Reassigned by ' || coalesce(nullif(who, ''), 'an admin');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists shifts_changes on public.shifts;
create trigger shifts_changes before update on public.shifts
  for each row execute function public.shifts_track_change();

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
  select sh.*, e.ends_at as event_end into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  if s.roster_id is not null then raise exception 'That post is already filled'; end if;
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
  select sh.*, e.ends_at as event_end into s
    from public.shifts sh join public.events e on e.id = sh.event_id
   where sh.id = p_shift for update of sh;
  if not found then raise exception 'Post not found'; end if;
  if s.event_end < now() then raise exception 'That event is already over'; end if;
  if not s.cover_requested then raise exception 'That post no longer needs cover'; end if;
  if s.roster_id = me then raise exception 'This is already your post'; end if;
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
grant execute on function public.volunteer_shift(uuid) to authenticated;
grant execute on function public.request_cover(uuid, boolean) to authenticated;
grant execute on function public.cover_shift(uuid) to authenticated;

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
  foreach t in array array['sops','contacts','bulletins','roster','events','shifts'] loop
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
