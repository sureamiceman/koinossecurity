-- =====================================================================
-- ONE-TIME CLEANUP of tables left over from an earlier version of the app.
-- Only run this if the app shows errors like
--   "Could not find the 'body' column of 'sops' in the schema cache".
-- It deletes the old app tables and everything in them (user sign-ins
-- are NOT touched). Afterwards, run schema.sql again.
-- =====================================================================

-- 1. Remove the old app tables (and their old security rules).
drop table if exists public.sops      cascade;
drop table if exists public.contacts  cascade;
drop table if exists public.bulletins cascade;
drop table if exists public.roster    cascade;
drop table if exists public.profiles  cascade;

-- 2. Remove any old sign-up triggers that pointed at the old tables.
--    (schema.sql puts back its own trigger.)
do $$
declare t record;
begin
  for t in
    select tg.tgname
    from pg_trigger tg
    join pg_proc p on p.oid = tg.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = 'auth.users'::regclass
      and not tg.tgisinternal
      and n.nspname = 'public'
  loop
    execute format('drop trigger if exists %I on auth.users', t.tgname);
  end loop;
end $$;

-- 3. Show any photo-storage rules still in place, for a quick review.
select policyname, cmd, roles, qual
from pg_policies
where schemaname = 'storage' and tablename = 'objects';
