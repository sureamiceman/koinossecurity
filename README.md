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
2. **Sign-in email.** In Supabase, go to *Authentication → Email Templates → Magic Link* and add the code to the email body so people can type it into the installed app:
   ```html
   <h2>Your Koinos Security sign-in code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   ```
3. **Site URL.** In Supabase, go to *Authentication → URL Configuration* and set *Site URL* to your Netlify address (e.g. `https://your-site.netlify.app`). Add it under *Redirect URLs* too.
4. **Netlify.** Connect this repo. No build command is needed; `netlify.toml` publishes the `public` folder.
5. **Make yourself superuser.** Open the site, sign in with your email, enter your name, then in Supabase's SQL editor run:
   ```sql
   update public.profiles set role = 'superuser' where email = 'your@email.com';
   ```
   Refresh the app. Repeat for the other superusers after they sign in.
6. **Invite the team.** Share the site link. Each person signs in, then an admin approves them under *More → Manage users*.

## Notes

- The Supabase anon key in `public/config.js` is meant to be public. **Never** put the `service_role` key in this repo.
- Supabase's built-in email sender is rate-limited (a few emails per hour). For a whole team signing in, set up custom SMTP under *Project Settings → Authentication → SMTP* (e.g. Resend, SendGrid, or Gmail SMTP).
- Photos are resized on the phone before upload and stored in a private bucket; the app shows them through short-lived signed links.
