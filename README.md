# Koinos Security

Progressive Web App (PWA) for the Koinos church security team. It installs on iPhone and Android from the browser, with no app store involved.

- **Alerts**: safety bulletins and BOLOs with photos, priority (info / caution / urgent), optional expiry. New posts appear live on everyone's open app.
- **Team board**: posts with replies and photos, live updates and an unread badge. Post types: general, *Ask for cover / offer a date to swap* (tied to one of your schedule posts: it marks it "Needs cover", and whoever taps *I'll cover* is put on the schedule automatically. Once the post no longer needs cover (covered, reassigned by an admin, or withdrawn) the request is taken off the board and deleted about an hour later; the schedule keeps the record, e.g. "Tim is covering for Tyler"), and welcome posts (created automatically when an admin links a new member's account). Threads are deleted 90 days after the last reply; admins can **Pin** a thread to keep it or **Make SOP** to turn it into a procedure.
- **Push notifications**: each person turns them on under *More → Notifications* (iPhone: the app must be on the Home Screen). Alerts always notify; cover requests, new posts and replies can each be switched off. Sent by `netlify/functions/push.mjs`.
- **SOPs**: searchable procedures grouped by category, with one-step rollback to the previous version.
- **Contacts**: every active team member from the roster appears automatically, with Call and Text buttons (Text opens the phone's messaging app addressed to them), plus other contacts admins add, such as police non-emergency, church staff or utilities (also with Call and Text).
- **Schedule**: services/events with posts. Members volunteer for open posts or cover for someone; admins assign and reassign people. *Need cover* on your own post opens a cover request on the team board with that post already chosen (the only way to ask for cover); once requested it shows *View request*. List and month views, filters for Mine / Needs cover / any person.
- **Repeating events** (like a phone calendar): daily, weekly on chosen days, every 2 weeks, or monthly (same date, e.g. 2nd Sunday, or last Sunday), with an optional end date. Posts, CCW preferences and default people carry to every date. Edits ask *This event only / This and following / All events*; swaps and one-off changes on specific dates are kept. Dates are generated about 6 months ahead and keep rolling forward.
- **Update assignments (Sunday rotation)**: admins fill a grid of who serves each post on the 1st–5th Sunday of the month, for each service (e.g. 1st/2nd Service × Front Door / Mid Hallway / Back Hallway). *Apply to next 6 months* fills every matching Sunday, and new months keep filling from the grid as the schedule rolls forward. Swaps, covers, volunteers and one-off admin changes are kept unless *Also replace one-off changes* is ticked. Flags CCW-preferred posts given to someone without a CCW, and anyone on two posts in the same service. Open it from the Schedule tab or More. If no weekly Sunday services exist yet, it offers to create them.
- **CCW-preferred posts**: a post can prefer a CCW-qualified person. It is never a hard requirement: anyone can be assigned, volunteer or cover. When the person on a CCW-preferred post has no current qualification on that date, their name is highlighted in red with a crossed-out CCW badge.
- **Calendar subscriptions**: each person can create private links (their own posts, anyone's, or the whole team) that iPhone, Google and Outlook calendars subscribe to. Events read "Security Sunday Worship: 8:15–10:30 AM" and update when posts change.
- **Team**: roster with photos, tap to call/text, Medical and CCW filters. CCW qualification with expiry date; admins are warned 30 days before it expires.
- **Users**: approve sign-ups; superusers grant/revoke admin. Approving someone whose email matches a roster entry links them automatically.
- **Your profile**: everyone can add their own phone number and photo. Until both are filled in, the app asks once each time it's opened or signed into ("Complete your profile"); it can be skipped and done later under *More → Edit profile*.
- **Linking merges details**: when a roster entry is linked to an app account, the roster email is replaced with the sign-in email, and the person's own phone and photo fill in anything the roster entry is missing.

Works offline with the last-loaded information (text only; photos need a connection).

## Roles

| Role | Can do |
|---|---|
| Pending | Signed up, waiting for approval. Sees nothing. |
| Member | View everything, call/text; volunteer/cover posts; post and reply on the board (edit/delete their own); edit their own name, phone and photo. |
| Admin | Member + add/edit/delete bulletins, SOPs, contacts and roster; approve or remove members; pin or delete any board post, Make SOP from a thread. |
| Superuser | Admin + grant/revoke admin. Superuser itself is only granted in the Supabase SQL editor. |

All permissions are enforced by the database (row-level security), not just hidden in the app.

## Stack

- `public/`: the static app (plain HTML/CSS/JS, no build step), served by Netlify
- `supabase/schema.sql`: database tables, security rules, photo storage
- `netlify.toml`: publish folder and security headers
- `netlify/functions/calendar.mjs`: the calendar subscription endpoint (`/cal/<token>.ics`)
- `netlify/functions/push.mjs`: sends push notifications (`/api/push`); `package.json` lists its one library (`web-push`)

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

## Push notifications setup (one time)

1. In Netlify: *Site configuration → Environment variables → Add a variable*, add both:
   - `SUPABASE_SERVICE_ROLE_KEY`: from Supabase *Project Settings → API Keys* (the **service_role** key, or a **secret** key). It stays on the server; never put it in this repo or in `config.js`.
   - `VAPID_PRIVATE_KEY`: the private half of the push key pair. The public half is `vapidPublicKey` in `public/config.js` and in `push.mjs`. To make a new pair: `npx web-push generate-vapid-keys`, then update all three places.
2. *Deploys → Trigger deploy → Deploy site* so the function picks up the variables.
3. In the app: *More → Notifications → Turn on notifications*, then *Send a test*.

If the variables are missing, the app still works; it just doesn't send notifications, and *Send a test* says the server isn't set up.

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
