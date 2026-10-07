// Shift confirmations: runs every hour (Netlify scheduled function).
//
// About 2½ days before a shift, the person on it gets a notification:
// "Are you still on for Sunday?" with Yes / No buttons.
//   • Ask:      7 PM on the evening that falls 48–72 hours before the shift
//               (Sunday 8:15 AM → Thursday 7 PM).
//   • Reminder: 7 PM the next evening (Friday) if they haven't answered.
//   • Assigned later than that? They're asked at the next run, but never
//     overnight (only 8 AM–9 PM), and not within 3 hours of the shift.
// Yes marks the post Confirmed on the schedule. No opens the app with a
// cover request for that post already filled in.
//
// Uses the same Netlify environment variables as push notifications:
// SUPABASE_SERVICE_ROLE_KEY and VAPID_PRIVATE_KEY.
import crypto from 'node:crypto';
import webpush from 'web-push';
import { makeDb, sendAll, VAPID_PUBLIC_KEY } from './push.mjs';

export const config = { schedule: '@hourly' };

export const TIME_ZONE = 'America/New_York';
export const ASK_HOUR = 19;            // 7 PM
export const DAY_START = 8;            // late asks only between 8 AM…
export const DAY_END = 21;             // …and 9 PM
const LATEST_BEFORE_MS = 3 * 3600e3;   // don't ask within 3 hours of the shift
const ON_TIME_MS = 90 * 60e3;          // a run within 90 min of 7 PM counts as "on time"
const MEMBER_ROLES = ['member', 'admin', 'superuser'];
const H = 3600e3;

export default async () => {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!serviceKey || !vapidPrivate) { console.log('shift-reminders: not set up (missing environment variables)'); return; }
  webpush.setVapidDetails('https://koinossecurity.netlify.app', VAPID_PUBLIC_KEY, vapidPrivate);
  const db = makeDb(serviceKey);
  const res = await run({ db, now: new Date(), send: (deliveries) => sendAll(db, deliveries) });
  console.log('shift-reminders', JSON.stringify(res));
};

// ----------------------------------------------------------------------
// Time zone helpers (pure)
// ----------------------------------------------------------------------
function zoneParts(date, tz = TIME_ZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}
// The moment it is hh:00 on a calendar date in the time zone (handles daylight saving).
export function zonedTime(y, m, d, hh, tz = TIME_ZONE) {
  let guess = Date.UTC(y, m - 1, d, hh, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const want = Date.UTC(y, m - 1, d, hh, 0, 0);
    if (asUtc === want) break;
    guess += want - asUtc;
  }
  return new Date(guess);
}
// 7 PM on the evening that falls 48–72 hours before the shift, and the next evening.
export function askTimes(start) {
  const latest = new Date(start.getTime() - 48 * H);
  const p = zoneParts(latest);
  let ask = zonedTime(p.y, p.m, p.d, ASK_HOUR);
  if (ask > latest) {
    const prev = zoneParts(new Date(ask.getTime() - 24 * H));
    ask = zonedTime(prev.y, prev.m, prev.d, ASK_HOUR);
  }
  const n = zoneParts(new Date(ask.getTime() + 24 * H));
  return { ask, remind: zonedTime(n.y, n.m, n.d, ASK_HOUR) };
}
const daytime = (now) => { const h = zoneParts(now).h; return h >= DAY_START && h < DAY_END; };

// What to do for one shift right now: 'ask', 'remind' or null.
export function nextStep(shift, start, now) {
  if (!shift.roster_id || shift.cover_requested) return null;
  if (start.getTime() - now.getTime() < LATEST_BEFORE_MS) return null;
  const { ask, remind } = askTimes(start);
  const due = (at) => now >= at && (now - at < ON_TIME_MS || daytime(now));
  if (shift.confirm_state === 'none') return due(ask) ? 'ask' : null;
  if (shift.confirm_state === 'asked' && !shift.confirm_reminded_at) {
    // Asked late (e.g. assigned Friday afternoon)? Don't remind the same evening.
    const askedAt = shift.confirm_asked_at ? new Date(shift.confirm_asked_at) : ask;
    if (remind.getTime() - askedAt.getTime() < 6 * H) return null;
    return due(remind) ? 'remind' : null;
  }
  return null;
}

// "Sun, Oct 11 at 8:15 AM"
export function whenText(start) {
  const day = start.toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' });
  const time = start.toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}
export function message(step, shift, event, start) {
  const weekday = start.toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'long' });
  return {
    title: step === 'remind' ? `Reminder: are you still on for ${weekday}?` : `Are you still on for ${weekday}?`,
    body: `${shift.post || 'Your post'} · ${event.title}, ${whenText(start)}. Tap Yes to confirm, or No if you need someone to cover.`,
    url: '#/confirm/' + shift.id,
    tag: 'confirm-' + shift.id
  };
}

// ----------------------------------------------------------------------
// One run
// ----------------------------------------------------------------------
export async function run({ db, now, send, newToken = () => crypto.randomBytes(24).toString('hex') }) {
  const from = new Date(now.getTime() - 24 * H).toISOString();   // shifts can have their own start time
  const to = new Date(now.getTime() + 80 * H).toISOString();
  const events = await db.get(`events?starts_at=gte.${encodeURIComponent(from)}&starts_at=lte.${encodeURIComponent(to)}&select=id,title,starts_at,ends_at,location`);
  if (!events.length) return { asked: 0, reminded: 0, sent: 0 };
  const ids = events.map((e) => `"${e.id}"`).join(',');
  const shifts = await db.get(`shifts?event_id=in.(${ids})&roster_id=not.is.null&cover_requested=is.false&confirm_state=in.(none,asked)&select=*`);
  if (!shifts.length) return { asked: 0, reminded: 0, sent: 0 };
  const [roster, profiles] = await Promise.all([
    db.get('roster?select=id,name,profile_id&profile_id=not.is.null'),
    db.get('profiles?select=id,role')
  ]);

  const deliveries = [];
  let asked = 0, reminded = 0;
  for (const s of shifts) {
    const e = events.find((x) => x.id === s.event_id);
    const start = new Date(s.starts_at || e.starts_at);
    const step = nextStep(s, start, now);
    if (!step) continue;
    const r = roster.find((x) => x.id === s.roster_id);
    const person = r && profiles.find((p) => p.id === r.profile_id && MEMBER_ROLES.includes(p.role));
    if (!person) continue;   // not linked to an app account yet: nobody to ask

    // Claim it first, so a shift is never asked twice even if runs overlap.
    const stamp = now.toISOString();
    const claimed = step === 'ask'
      ? await db.patch(`shifts?id=eq.${s.id}&confirm_state=eq.none&roster_id=eq.${s.roster_id}&select=id`, { confirm_state: 'asked', confirm_asked_at: stamp, confirm_reminded_at: null })
      : await db.patch(`shifts?id=eq.${s.id}&confirm_state=eq.asked&confirm_reminded_at=is.null&select=id`, { confirm_reminded_at: stamp });
    if (!claimed || !claimed.length) continue;
    if (step === 'ask') asked++; else reminded++;

    // A fresh token for the notification's Yes button (older ones stop working).
    const token = newToken();
    await db.del(`shift_confirm_tokens?shift_id=eq.${s.id}`);
    await db.post('shift_confirm_tokens', { token, shift_id: s.id });

    const subs = await db.get(`push_subscriptions?profile_id=eq.${person.id}&select=*`);
    const msg = message(step, s, e, start);
    msg.extra = {
      kind: 'confirm', token, shift: s.id, requireInteraction: true,
      actions: [{ action: 'yes', title: "Yes, I'll be there" }, { action: 'no', title: 'No, I need cover' }]
    };
    for (const sub of subs) deliveries.push({ sub, msg });
  }
  const res = deliveries.length ? await send(deliveries) : { sent: 0 };
  return { asked, reminded, ...res };
}
