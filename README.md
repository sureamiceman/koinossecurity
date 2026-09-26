# Koinos Security

Progressive Web App (PWA) for the Koinos church security team. It installs on iPhone and Android from the browser, with no app store involved.

- **Alerts**: safety bulletins and BOLOs with photos, priority (info / caution / urgent), optional expiry. New posts appear live on everyone's open app.
- **SOPs**: searchable procedures grouped by category, with one-step rollback to the previous version.
- **Contacts**: emergency contacts with tap-to-call, plus a Call 911 button.
- **Schedule**: services/events with posts. Members volunteer for open posts, ask for cover, or cover for someone; admins assign, duplicate and repeat events. List and month views, filters for Mine / Needs cover / any person.
- **Calendar subscriptions**: each person can create private links (their own posts, anyone's, or the whole team) that iPhone, Google and Outlook calendars subscribe to. Events read "Security Sunday Worship: 8:15–10:30 AM" and update when posts change.
- **Team**: roster with photos, tap to call/text, Medical and CCW filters. CCW qualification with expiry date; admins are warned 30 days before it expires.
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
- `netlify/functions/calendar.mjs`: the calendar subscription endpoint (`/cal/<token>.ics`)

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
7. **Link roster names to sign-ins.** Under *Team*, edit each person and pick their *App account* (it links automatically when the roster email matches their sign-in email). That powers *Mine*, volunteering and swaps.

## Passwords

- Anyone can change their own password under *More → Change password*.
- There is no "forgot password" email, because the project has no email sender. If you later set up custom SMTP (for example Gmail) under *Authentication → Emails → SMTP Settings*, password-reset emails can be added.

## Calendar links

- Made under *Schedule → Subscribe*. Each link is a long random secret; anyone with it can see those assignments, so share it only with family. *Turn off* disables it immediately.
- Links stop working automatically if the owner's access is removed.
- Calendar apps refresh subscribed calendars on their own schedule (iPhone: Settings → Calendar → Accounts → Fetch; Google: every few hours).

## Notes

- The Supabase anon key in `public/config.js` is meant to be public. **Never** put the `service_role` key in this repo.
- Photos are resized on the phone before upload and stored in a private bucket; the app shows them through short-lived signed links.
