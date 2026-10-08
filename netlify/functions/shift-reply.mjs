// The "Yes, I'll be there" button on a shift-confirmation notification:
// https://<site>/api/shift-reply   { token }
//
// The notification carries a one-off random token for that one post (made by
// shift-reminders.mjs, readable only by the server), so the phone can confirm
// without opening the app or being signed in. "No" always opens the app,
// because asking for cover needs a reason.
import { makeDb } from './push.mjs';

export const config = { path: '/api/shift-reply' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default (req) => handle(req, { db: process.env.SUPABASE_SERVICE_ROLE_KEY ? makeDb(process.env.SUPABASE_SERVICE_ROLE_KEY) : null });

export async function handle(req, { db }) {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!db) return json(501, { error: 'Not set up' });
  let body = {};
  try { body = await req.json(); } catch { /* handled below */ }
  if (!/^[0-9a-f]{32,128}$/.test(body.token || '')) return json(400, { error: 'Missing token' });
  try {
    const state = await db.post('rpc/confirm_shift_by_token', { p_token: body.token });
    return json(200, { state });
  } catch (e) {
    console.error('shift-reply failed', e);
    return json(500, { error: 'Could not confirm' });
  }
}
