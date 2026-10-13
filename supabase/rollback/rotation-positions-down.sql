-- =====================================================================
-- ROLLBACK: "Not used this week" + Edit positions   (added in 1.16.0)
-- Only run this AFTER the app code has been rolled back (see "Rolling back
-- a release" in README.md), then run the older supabase/schema.sql from
-- that version so the schedule functions go back to their earlier form.
-- Posts that were "not used" on some weeks will be created again on those
-- dates the next time the rotation is applied. Safe to run more than once.
-- =====================================================================
begin;
drop function if exists public.save_series_positions(uuid, jsonb);
alter table public.rotation_slots drop column if exists skip cascade;
drop function if exists public.template_skip(uuid, date) cascade;
commit;
