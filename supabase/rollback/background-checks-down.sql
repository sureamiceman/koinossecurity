-- Undo 2.1.0's background checks and Office Admin (run in the Supabase SQL
-- editor after reverting the app). Anyone can be scheduled again. The
-- statuses the office entered are deleted, so only run this if you mean it.
drop trigger if exists shifts_a_background_check on public.shifts;
drop function if exists public.shifts_background_check();
drop trigger if exists roster_background_open on public.roster;
drop function if exists public.roster_background_open();
drop function if exists public.set_background_check(uuid, text);
drop function if exists public.my_background_ok();
drop function if exists public.background_ok(uuid);
drop table if exists public.background_checks;
drop function if exists public.set_office_admin(uuid, boolean);
drop function if exists public.is_office_admin();
alter table public.profiles drop column if exists is_office_admin;
