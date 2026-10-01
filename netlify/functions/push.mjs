// Push notification sender: https://<site>/api/push
//
// The app calls this (with the signed-in person's token) right after it
// posts something. The function then looks in the database for anything
// new that hasn't been announced yet (bulletins, board posts, replies,
// cover requests), marks it as announced, and sends a notification to the
// right people's devices. Nothing in the request body is trusted except
// { test: true }, which sends a test notification to the caller's devices.
//
// Needs two environment variables in Netlify (Site configuration →
// Environment variables), never in this repo:
//   SUPABASE_SERVICE_ROLE_KEY  Supabase → Project Settings → API Keys
//                              (the "service_role" key, or a "secret" key)
//   VAPID_PRIVATE_KEY          the private half of the push key pair
import webpush from 'web-push';

const SUPABASE_URL = 'https://kapowhcexzsgogvvchqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthcG93aGNleHpzZ29ndnZjaHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyODk5ODIsImV4cCI6MjEwNTg2NTk4Mn0.IjRi7jcrsS5vXvNcBJFJ85TVZuD1U7e4B1OsN2MQoK8';
export const VAPID_PUBLIC_KEY = 'BJAKYRuDufBtgXeb_EADMNi6Gti6Y6BAsjpg1ruhlnB-kokxa-gYWaddR0tn8O6a0LZn0oiXd6PHM6sr62v-Ico';
const VAPID_SUBJECT = 'https://koinossecurity.netlify.app';
const WINDOW_MINUTES = 15; // only announce things created/re-opened this recently
const MEMBER_ROLES = ['member', 'admin', 'superuser'];

export const config = { path: '/api/push' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!serviceKey || !vapidPrivate) return json(501, { error: 'Push is not set up on the server yet (missing environment variables).' });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first' });
  let body = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    const db = makeDb(serviceKey);
    const user = await currentUser(token);
    if (!user) return json(401, { error: 'Sign in first' });
    const [me] = await db.get(`profiles?id=eq.${user.id}&select=id,role`);
    if (!me || !MEMBER_ROLES.includes(me.role)) return json(403, { error: 'Not authorized' });

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, vapidPrivate);

    if (body.test) {
      const subs = await db.get(`push_subscriptions?profile_id=eq.${me.id}&select=*`);
      const res = await sendAll(db, subs.map((s) => ({ sub: s, msg: { title: 'Koinos Security', body: 'Notifications are working on this device.', url: '#/more', tag: 'test' } })));
      return json(200, { test: true, devices: subs.length, ...res });
    }

    const items = await claimNew(db);
    if (!items.bulletins.length && !items.posts.length && !items.replies.length) return json(200, { sent: 0 });
    const ctx = await loadContext(db, items);
    const deliveries = planDeliveries(items, ctx);
    const res = await sendAll(db, deliveries);
    return json(200, { items: items.bulletins.length + items.posts.length + items.replies.length, ...res });
  } catch (e) {
    console.error('push failed', e);
    return json(500, { error: 'Push failed' });
  }
};

// ----------------------------------------------------------------------
// Database (Supabase REST with the service key; server side only)
// ----------------------------------------------------------------------
export function makeDb(serviceKey, base = SUPABASE_URL) {
  // New-style "sb_secret_" keys go in apikey only; legacy service_role JWTs in both headers.
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`;
  const call = async (method, path, payload, extra = {}) => {
    const res = await fetch(`${base}/rest/v1/${path}`, { method, headers: { ...headers, ...extra }, body: payload ? JSON.stringify(payload) : undefined });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path) => call('GET', path),
    patch: (path, payload) => call('PATCH', path, payload, { Prefer: 'return=representation' }),
    del: (path) => call('DELETE', path)
  };
}

async function currentUser(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

// Mark not-yet-announced recent items as announced and return them.
// Each item is claimed by exactly one call, so nothing is sent twice.
export async function claimNew(db, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60000).toISOString();
  const stamp = { notified_at: now.toISOString() };
  const [bulletins, posts, replies] = await Promise.all([
    db.patch(`bulletins?notified_at=is.null&active=is.true&created_at=gte.${encodeURIComponent(since)}&select=id,kind,priority,title,body,created_by`, stamp),
    db.patch(`posts?notified_at=is.null&last_activity_at=gte.${encodeURIComponent(since)}&select=id,kind,body,author_id,shift_id,photo_path`, stamp),
    db.patch(`post_replies?notified_at=is.null&created_at=gte.${encodeURIComponent(since)}&select=id,post_id,body,author_id,photo_path`, stamp)
  ]);
  return { bulletins: bulletins || [], posts: posts || [], replies: replies || [] };
}

async function loadContext(db, items) {
  const threadIds = [...new Set(items.replies.map((r) => r.post_id))];
  const inList = (ids) => `(${ids.map((x) => `"${x}"`).join(',')})`;
  const [profiles, subs, roster, threads, threadReplies] = await Promise.all([
    db.get('profiles?select=id,full_name,role,notify_posts,notify_replies,notify_cover'),
    db.get('push_subscriptions?select=*'),
    db.get('roster?select=name,profile_id&profile_id=not.is.null'),
    threadIds.length ? db.get(`posts?id=in.${inList(threadIds)}&select=id,author_id,kind`) : [],
    threadIds.length ? db.get(`post_replies?post_id=in.${inList(threadIds)}&select=post_id,author_id`) : []
  ]);
  return { profiles, subs, roster, threads, threadReplies };
}

// ----------------------------------------------------------------------
// Who gets what (pure; unit-tested)
// ----------------------------------------------------------------------
const clip = (s, n = 140) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function planDeliveries(items, ctx) {
  const members = new Map(ctx.profiles.filter((p) => MEMBER_ROLES.includes(p.role)).map((p) => [p.id, p]));
  const nameOf = (id) => {
    const r = ctx.roster.find((x) => x.profile_id === id);
    const p = members.get(id) || ctx.profiles.find((x) => x.id === id);
    return (r && r.name) || (p && p.full_name) || 'Someone';
  };
  const subsBy = new Map();
  for (const s of ctx.subs) if (members.has(s.profile_id)) (subsBy.get(s.profile_id) || subsBy.set(s.profile_id, []).get(s.profile_id)).push(s);
  const out = [];
  const toPeople = (ids, msg) => { for (const id of ids) for (const sub of subsBy.get(id) || []) out.push({ sub, msg }); };
  const everyone = (except, pref) => [...members.values()].filter((p) => p.id !== except && (!pref || p[pref] !== false)).map((p) => p.id);

  for (const b of items.bulletins) {
    const label = b.kind === 'bolo' ? 'BOLO' : 'Bulletin';
    toPeople(everyone(b.created_by), {
      title: (b.priority === 'urgent' ? 'URGENT ' : '') + `${label}: ${clip(b.title, 80)}`,
      body: clip(b.body) || 'Open the app for details.', url: '#/alerts', tag: 'bulletin-' + b.id, urgent: b.priority === 'urgent'
    });
  }
  for (const p of items.posts) {
    const who = nameOf(p.author_id);
    const msg = p.kind === 'swap' ? { title: `Cover needed: ${who}`, pref: 'notify_cover' }
      : p.kind === 'intro' ? { title: 'New team member', pref: 'notify_posts' }
        : { title: `${who} posted`, pref: 'notify_posts' };
    toPeople(everyone(p.author_id, msg.pref), {
      title: msg.title, body: clip(p.body) || (p.photo_path ? 'Shared a photo' : ''), url: '#/board/' + p.id, tag: 'post-' + p.id
    });
  }
  // Replies go to the thread's author and everyone who has replied in it.
  for (const r of items.replies) {
    const thread = ctx.threads.find((t) => t.id === r.post_id);
    const people = new Set([thread && thread.author_id, ...ctx.threadReplies.filter((x) => x.post_id === r.post_id).map((x) => x.author_id)]);
    people.delete(r.author_id);
    const ids = [...people].filter((id) => id && members.has(id) && members.get(id).notify_replies !== false);
    toPeople(ids, { title: `${nameOf(r.author_id)} replied`, body: clip(r.body) || (r.photo_path ? 'Shared a photo' : ''), url: '#/board/' + r.post_id, tag: 'post-' + r.post_id });
  }
  return out;
}

// ----------------------------------------------------------------------
// Sending
// ----------------------------------------------------------------------
export async function sendAll(db, deliveries) {
  let sent = 0, failed = 0;
  const gone = new Set();
  await Promise.all(deliveries.map(async ({ sub, msg }) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag }),
        { TTL: msg.urgent ? 6 * 3600 : 24 * 3600, urgency: msg.urgent ? 'high' : 'normal' });
      sent++;
    } catch (e) {
      failed++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.add(sub.endpoint); // device unsubscribed
      else console.error('push to device failed', e && e.statusCode, e && e.body);
    }
  }));
  for (const endpoint of gone) {
    try { await db.del(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`); } catch { /* try again next time */ }
  }
  return { sent, failed, removed: gone.size };
}
