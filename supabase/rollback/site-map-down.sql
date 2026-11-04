-- Undo 2.2.0's site map (run in the Supabase SQL editor after reverting the
-- app). Deletes the imported map, the area names/teams/merges set on it, and
-- every equipment/utility marker placed on it. Team colors are left as they
-- are (change them under Manage teams if you want the old ones back).
drop function if exists public.import_site_map(jsonb, boolean);
drop table if exists public.map_markers;
drop trigger if exists map_areas_touch on public.map_areas;
drop function if exists public.map_areas_touch();
drop table if exists public.map_areas;
drop table if exists public.site_map;
