-- =====================================================================
-- ROLLBACK: Teams (Alpha–Delta) and team activation   (added in 1.14.0)
--
-- Only run this AFTER the app code has been rolled back to 1.13.0
-- (see "Rolling back a release" in README.md). Run it in Supabase:
-- SQL Editor → New query → paste → Run.
--
-- It removes: the teams and team_activations tables, each person's team
-- on the roster, and the functions/triggers that went with them. Nothing
-- else in the app is touched. It is safe to run more than once.
--
-- The four starter SOPs ("Alpha Team – Emergency procedure", …) are KEPT,
-- because you may have edited them. To delete them too, remove the two
-- dashes in front of the DELETE line at the bottom before running.
-- =====================================================================
begin;

drop function if exists public.activate_team(text, boolean);
drop function if exists public.end_activation(uuid);

drop trigger if exists roster_team_left on public.roster;
drop function if exists public.roster_team_left();

alter table public.roster drop column if exists team_id;

drop table if exists public.team_activations;
drop table if exists public.teams;          -- also removes its triggers and rules
drop function if exists public.teams_lead_joins();

-- Optional: also delete the starter team procedures from the SOPs tab.
-- delete from public.sops where category = 'Emergency' and title in ('Alpha Team – Emergency procedure', 'Bravo Team – Emergency procedure', 'Charlie Team – Emergency procedure', 'Delta Team – Emergency procedure');

commit;
