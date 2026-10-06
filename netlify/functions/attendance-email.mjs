// Attendance email sender: https://<site>/api/attendance-email
//
// The app calls this (with the signed-in person's token) right after a
// count is submitted or corrected: { count_id, send_now? }. The function
// only sends a count the database has marked as waiting to be emailed
// (email_state = 'pending'), and marks it while sending, so the same count
// is never emailed twice and nobody can use this to send arbitrary email.
// The email always shows every service submitted for that date so far,
// plus the day total, laid out like the paper "Worship Service Count".
//
// Settings → "When":
//   each = email after every service is submitted
//   day  = wait until every service for that date is in, then send one email
//          (an admin can tap "Send now"; that's send_now: true)
//
// Needs these environment variables in Netlify (Site configuration →
// Environment variables), never in this repo:
//   SUPABASE_SERVICE_ROLE_KEY  (already set up for push notifications)
//   RESEND_API_KEY             Resend → API Keys (a "Sending access" key)
//   ATTENDANCE_FROM            e.g.  Koinos Security <attendance@schrammscape.com>
//                              (the domain must be verified in Resend)

const DEFAULT_SUPABASE_URL = 'https://kapowhcexzsgogvvchqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthcG93aGNleHpzZ29ndnZjaHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyODk5ODIsImV4cCI6MjEwNTg2NTk4Mn0.IjRi7jcrsS5vXvNcBJFJ85TVZuD1U7e4B1OsN2MQoK8';
const MEMBER_ROLES = ['member', 'admin', 'superuser'];
const ADMIN_ROLES = ['admin', 'superuser'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const config = { path: '/api/attendance-email' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default (req) => handle(req, { fetchImpl: fetch, env: process.env });

// Separate from the default export so tests can pass a fake fetch and settings.
export async function handle(req, { fetchImpl, env }) {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json(501, { state: 'failed', error: 'The server is missing its database key.' });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first' });
  let body = {};
  try { body = await req.json(); } catch { /* handled below */ }
  if (!UUID.test(body.count_id || '')) return json(400, { error: 'Missing count' });

  const base = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const db = makeDb(serviceKey, fetchImpl, base);
  try {
    const user = await currentUser(token, fetchImpl, base);
    if (!user) return json(401, { error: 'Sign in first' });
    const [me] = await db.get(`profiles?id=eq.${user.id}&select=id,role`);
    if (!me || !MEMBER_ROLES.includes(me.role)) return json(403, { error: 'Not authorized' });
    const sendNow = !!body.send_now && ADMIN_ROLES.includes(me.role);

    // Claim it: only a count waiting to be emailed, and only once.
    const claimable = sendNow ? '(pending,waiting)' : '(pending)';
    const [count] = await db.patch(`attendance_counts?id=eq.${body.count_id}&status=eq.submitted&email_state=in.${claimable}&select=*`, { email_state: 'sending' });
    if (!count) {
      const [now] = await db.get(`attendance_counts?id=eq.${body.count_id}&select=email_state,email_error`);
      return json(200, { state: now ? now.email_state : 'missing', error: now ? now.email_error : undefined });
    }
    const fail = async (msg, state = 'failed') => {
      await db.patch(`attendance_counts?id=eq.${count.id}`, { email_state: 'failed', email_error: msg.slice(0, 300) });
      return json(200, { state, error: msg });
    };

    const [settings] = await db.get('attendance_settings?id=eq.1&select=*');
    const recipients = (settings && settings.recipients) || [];
    if (!recipients.length) return fail('No secretary email address is set up yet.', 'no_recipients');
    if (!env.RESEND_API_KEY || !env.ATTENDANCE_FROM) return fail("Email isn't set up on the server yet.");

    const sameDay = await db.get(`attendance_counts?service_date=eq.${count.service_date}&select=*&order=service_no`);
    const services = (settings.services || []).map((s) => ({ no: Number(s.no), label: s.label, time: s.time }));
    if (settings.email_when === 'day' && !sendNow) {
      const allIn = services.every((s) => sameDay.some((c) => c.service_no === s.no && c.status === 'submitted'));
      if (!allIn) {
        await db.patch(`attendance_counts?id=eq.${count.id}`, { email_state: 'waiting', email_error: '' });
        return json(200, { state: 'waiting' });
      }
    }

    const submitted = sameDay.filter((c) => c.status === 'submitted');
    const ids = submitted.map((c) => `"${c.id}"`).join(',');
    const [values, profiles] = await Promise.all([
      db.get(`attendance_values?count_id=in.(${ids})&select=*&order=sort_order`),
      db.get('profiles?select=id,full_name,email')
    ]);
    const mail = buildEmail({ count, sameDay, services, values, profiles });
    const who = profiles.find((p) => p.id === (count.corrections ? count.corrected_by : count.submitted_by));
    const replyTo = settings.reply_to || (who && who.email) || undefined;

    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ATTENDANCE_FROM, to: recipients, subject: mail.subject, html: mail.html, text: mail.text, reply_to: replyTo })
    });
    if (!res.ok) {
      let msg = `Resend error ${res.status}`;
      try { const e = await res.json(); if (e && e.message) msg = e.message; } catch { /* keep status */ }
      console.error('attendance email failed', res.status, msg);
      return fail(msg);
    }

    // Sent. In "once a day" mode this email also covered the date's other waiting services.
    const stamp = { email_state: 'sent', email_error: '', emailed_at: new Date().toISOString() };
    await db.patch(`attendance_counts?id=eq.${count.id}`, stamp);
    if (settings.email_when === 'day') {
      await db.patch(`attendance_counts?service_date=eq.${count.service_date}&status=eq.submitted&email_state=in.(waiting,pending)`, stamp);
    }
    return json(200, { state: 'sent' });
  } catch (e) {
    console.error('attendance email crashed', e);
    try { await db.patch(`attendance_counts?id=eq.${body.count_id}&email_state=eq.sending`, { email_state: 'failed', email_error: 'Server error while sending.' }); } catch { /* ignore */ }
    return json(500, { state: 'failed', error: 'Server error while sending.' });
  }
}

// ----------------------------------------------------------------------
// Database (Supabase REST with the service key; server side only)
// ----------------------------------------------------------------------
function makeDb(serviceKey, fetchImpl, base) {
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`;
  const call = async (method, path, payload, extra = {}) => {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, { method, headers: { ...headers, ...extra }, body: payload ? JSON.stringify(payload) : undefined });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path) => call('GET', path),
    patch: (path, payload) => call('PATCH', path, payload, { Prefer: 'return=representation' })
  };
}

async function currentUser(token, fetchImpl, base) {
  const res = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

// ----------------------------------------------------------------------
// The email (pure; unit-tested)
// ----------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayLabel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); };
const shortDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); };
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

export function buildEmail({ count, sameDay, services, values, profiles }) {
  const nameOf = (id) => { const p = profiles.find((x) => x.id === id); return p ? (p.full_name || p.email) : 'someone'; };
  // Columns: every service on the form, plus any extra service counted that day.
  const cols = services.map((s) => ({ ...s, count: sameDay.find((c) => c.service_no === s.no) }));
  for (const c of sameDay) if (c.status === 'submitted' && !cols.some((s) => s.no === c.service_no)) cols.push({ no: c.service_no, label: c.service_label, count: c });
  const shown = cols.filter((s) => s.count && s.count.status === 'submitted');
  const dayTotal = shown.reduce((n, s) => n + s.count.total, 0);
  const allIn = cols.every((s) => s.count && s.count.status === 'submitted');

  // Rows: each section/line in form order, across all services.
  const rows = [];
  for (const v of values) {
    const key = `${v.section_title}\u0000${v.field_label}`;
    let r = rows.find((x) => x.key === key);
    if (!r) rows.push(r = { key, section: v.section_title, label: v.field_label, in_total: v.in_total, order: v.sort_order, vals: {} });
    r.vals[v.count_id] = v.value;
  }
  rows.sort((a, b) => a.order - b.order);

  const thisLabel = count.service_label || `Service ${count.service_no}`;
  const corrected = count.corrections > 0;
  const subject = `${corrected ? 'Corrected: ' : ''}Worship Service Count – ${shortDay(count.service_date)} – ${thisLabel}: ${count.total}`;

  const cell = 'padding:6px 10px;border-bottom:1px solid #e3e7ec;';
  const num = cell + 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;';
  let lastSection = null;
  const bodyRows = rows.map((r) => {
    const head = r.section !== lastSection
      ? `<tr><td colspan="${shown.length + 1}" style="padding:12px 10px 4px;font-weight:700;color:#0f2742;">${esc(r.section)}</td></tr>` : '';
    lastSection = r.section;
    return head + `<tr><td style="${cell}padding-left:22px;">${esc(r.label)}${r.in_total ? '' : ' <span style="color:#5d6b7c;">(not in total)</span>'}</td>`
      + shown.map((s) => `<td style="${num}">${r.vals[s.count.id] == null ? '–' : esc(r.vals[s.count.id])}</td>`).join('') + '</tr>';
  }).join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16202c;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
<div style="background:#0f2742;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;">
  <div style="font-size:13px;color:#e8b23e;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">Worship Service Count${corrected ? ' · Corrected' : ''}</div>
  <div style="font-size:20px;font-weight:700;margin-top:4px;">${esc(dayLabel(count.service_date))}</div>
</div>
<div style="background:#fff;padding:16px 20px 20px;border-radius:0 0 12px 12px;">
  <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:14px;">
    ${cols.map((s) => `<tr><td style="${cell}font-size:16px;">${esc(s.label)}</td><td style="${num}font-size:20px;font-weight:700;">${s.count && s.count.status === 'submitted' ? s.count.total : '<span style="font-size:14px;font-weight:400;color:#5d6b7c;">not submitted yet</span>'}</td></tr>`).join('')}
    <tr><td style="padding:10px;font-size:16px;font-weight:700;">Total count for this date${allIn ? '' : ' (so far)'}</td><td style="padding:10px;text-align:right;font-size:22px;font-weight:800;">${dayTotal}</td></tr>
  </table>
  <div style="font-size:13px;color:#5d6b7c;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 4px;">Details</div>
  <table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;">
    <tr><td style="${cell}width:${shown.length > 1 ? 52 : 70}%;"></td>${shown.map((s) => `<td style="${num}font-weight:700;white-space:normal;">${esc(s.label)}</td>`).join('')}</tr>
    ${bodyRows}
    <tr><td style="padding:10px;font-weight:700;">Service total</td>${shown.map((s) => `<td style="padding:10px;text-align:right;font-weight:800;">${s.count.total}</td>`).join('')}</tr>
  </table>
  ${shown.filter((s) => s.count.notes).map((s) => `<p style="margin:12px 0 0;font-size:14px;"><strong>Notes (${esc(s.label)}):</strong> ${esc(s.count.notes)}</p>`).join('')}
  <p style="margin:18px 0 0;font-size:13px;color:#5d6b7c;">${shown.map((s) => `${esc(s.label)} submitted by ${esc(nameOf(s.count.submitted_by))} at ${clock(s.count.submitted_at)}${s.count.corrections ? `, corrected by ${esc(nameOf(s.count.corrected_by))}` : ''}.`).join('<br>')}</p>
</div>
<p style="font-size:12px;color:#5d6b7c;text-align:center;margin:12px 0 0;">Sent by the Koinos Security team app.</p>
</div></body></html>`;

  const lines = [`WORSHIP SERVICE COUNT${corrected ? ' (CORRECTED)' : ''}`, dayLabel(count.service_date), ''];
  for (const s of cols) lines.push(`${s.label}: ${s.count && s.count.status === 'submitted' ? s.count.total : 'not submitted yet'}`);
  lines.push(`Total count for this date${allIn ? '' : ' (so far)'}: ${dayTotal}`, '');
  for (const s of shown) {
    lines.push(`--- ${s.label} ---`);
    let sec = null;
    for (const r of rows) {
      if (!(s.count.id in r.vals)) continue;
      if (r.section !== sec) { lines.push(r.section); sec = r.section; }
      lines.push(`  ${r.label}${r.in_total ? '' : ' (not in total)'}: ${r.vals[s.count.id] == null ? '-' : r.vals[s.count.id]}`);
    }
    lines.push(`  Service total: ${s.count.total}`);
    if (s.count.notes) lines.push(`  Notes: ${s.count.notes}`);
    lines.push(`  Submitted by ${nameOf(s.count.submitted_by)} at ${clock(s.count.submitted_at)}`, '');
  }
  return { subject, html, text: lines.join('\n') };
}
