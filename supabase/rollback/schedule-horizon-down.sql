-- Undo 1.19.0's nightly schedule job (run in the Supabase SQL editor).
-- Keeps every event already on the schedule. Afterwards the schedule still
-- rolls forward whenever someone opens the app (whole months, as in 1.19.0,
-- until an older schema.sql is run again).
do $$ begin
  perform cron.unschedule('koinos-roll-schedule');
exception when others then null;
end $$;
drop function if exists public.roll_schedule();
