# Koinos Security

Progressive Web App (PWA) for the Koinos church security team. It installs on iPhone and Android from the browser, with no app store involved.

- **Alerts**: safety bulletins and BOLOs with photos, priority (info / caution / urgent), optional expiry. New posts appear live on everyone's open app.
- **SOPs**: searchable procedures grouped by category, with one-step rollback to the previous version.
- **Contacts**: emergency contacts with tap-to-call, plus a Call 911 button.
- **Team**: roster with photos, tap to call/text, and a Medical filter for medical points of contact.
- **Users**: approve sign-ups; superusers grant/revoke admin.

Works offline with the last-loaded information (text only; photos need a connection).

## Roles

| Role | Can do |
|---|---|
| Pending | Signed up, waiting for approval. Sees nothing. |
| Member | View everything, call/text. |
| Admin | Member + add/edit/delete bulletins, SOPs, contacts and roster; approve or remove members. |
| Superuser | Admin + grant/revoke admin. Superuser itself is only granted in the Supabase SQL editor. |

All permissions are enforced by the database (row-level security), not just hidden in the app.

## Stack

- `public/`: the static app (plain HTML/CSS/JS, no build step), served by Netlify
- `supabase/schema.sql`: database tables, security rules, photo storage
- `netlify.toml`: publish folder and security headers

## One-time setup

1. **Database.** In Supabase, open *SQL Editor → New query*, paste the whole of `supabase/schema.sql`, and click *Run*.
2. **Sign-in settings.** In Supabase, go to *Authentication → Sign In / Providers → Email*. Keep **Email** enabled, **turn off "Confirm email"**, and save. (There is no email sender set up, so the app uses email + password with no confirmation emails. New accounts still can't see anything until an admin approves them.)
3. **Site URL.** In *Authentication → URL Configuration*, set *Site URL* to `https://koinossecurity.netlify.app`.
4. **Netlify.** Connect this repo. No build command is needed; `netlify.toml` publishes the `public` folder.
5. **Make yourself superuser.** Open the site, tap *Create an account*, then in Supabase's SQL editor run:
   ```sql
   update public.profiles set role = 'superuser' where email = 'your@email.com';
   ```
   Refresh the app. Repeat for the other superusers after they create accounts.
6. **Invite the team.** Share the site link. Each person creates an account, then an admin approves them under *More → Manage users*.

## Passwords

- Anyone can change their own password under *More → Change password*.
- There is no "forgot password" email, because the project has no email sender. If you later set up custom SMTP (for example Gmail) under *Authentication → Emails → SMTP Settings*, password-reset emails can be added.

## Notes

- The Supabase anon key in `public/config.js` is meant to be public. **Never** put the `service_role` key in this repo.
- Photos are resized on the phone before upload and stored in a private bucket; the app shows them through short-lived signed links.
