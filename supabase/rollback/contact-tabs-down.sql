-- =====================================================================
-- ROLLBACK: Contact tabs   (added in 1.15.0)
-- Only run this AFTER the app code has been rolled back (see "Rolling back
-- a release" in README.md). Removes the contact tab list (names, colors,
-- order). Contacts themselves, and their categories, are kept.
-- Safe to run more than once.
-- =====================================================================
begin;
drop function if exists public.save_contact_categories(jsonb);
drop table if exists public.contact_categories;
commit;
