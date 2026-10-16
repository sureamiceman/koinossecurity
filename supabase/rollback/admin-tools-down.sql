-- Undo 1.20.0's database additions (run in the Supabase SQL editor after
-- reverting the app). Removes the App settings (Teams on/off, Rally
-- Location) and what people declared about CCW / medical at sign-up.
-- Nothing on the roster is touched. Teams, leads and Rally Points stay.
do $$ begin alter publication supabase_realtime drop table public.app_settings; exception when others then null; end $$;
drop function if exists public.save_app_settings(boolean, text);
drop table if exists public.app_settings;
drop function if exists public.update_my_qualifications(boolean, date, boolean, text);
alter table public.profiles drop column if exists ccw_declared;
alter table public.profiles drop column if exists ccw_received_on;
alter table public.profiles drop column if exists medical_declared;
alter table public.profiles drop column if exists medical_quals;
-- handle_new_user keeps working without these columns (it skips them).
