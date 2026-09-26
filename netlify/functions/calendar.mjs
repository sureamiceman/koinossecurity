// Calendar subscription endpoint: https://<site>/cal/<token>.ics
// Calendar apps (iPhone, Google, Outlook) poll this URL and show the
// person's security assignments. The token is a long random secret made
// in the app; deleting it in the app turns the link off.
//
// Uses only the public Supabase anon key; the database function
// calendar_feed() checks the token and returns just that feed's shifts.

const SUPABASE_URL = 'https://kapowhcexzsgogvvchqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthcG93aGNleHpzZ29ndnZjaHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyODk5ODIsImV4cCI6MjEwNTg2NTk4Mn0.IjRi7jcrsS5vXvNcBJFJ85TVZuD1U7e4B1OsN2MQoK8';
const TIME_ZONE = 'America/New_York';
const APP_URL = 'https://koinossecurity.netlify.app';

export const config = { path: '/cal/:token' };

export default async (req, context) => {
  const raw = (context.params && context.params.token) || new URL(req.url).pathname.split('/').pop() || '';
  const token = raw.replace(/\.ics$/i, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound();

  let feed;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/calendar_feed`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_token: token })
    });
    if (res.status >= 400 && res.status < 500) return notFound();
    if (!res.ok) return new Response('Calendar temporarily unavailable', { status: 503, headers: { 'Retry-After': '600' } });
    feed = await res.json();
  } catch {
    return new Response('Calendar temporarily unavailable', { status: 503, headers: { 'Retry-After': '600' } });
  }

  return new Response(buildIcs(feed), {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="koinos-security.ics"',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex'
    }
  });
};

function notFound() {
  return new Response('Calendar not found. The link may have been deleted in the Koinos Security app.', {
    status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// ---------------------------------------------------------------------
// iCalendar (RFC 5545) output
// ---------------------------------------------------------------------
export function buildIcs(feed) {
  const now = icsDate(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Koinos Security//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    prop('X-WR-CALNAME', feed.name || 'Koinos Security'),
    prop('X-WR-CALDESC', 'Security team assignments from the Koinos Security app'),
    'X-WR-TIMEZONE:' + TIME_ZONE,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  for (const ev of feed.events || []) {
    const start = new Date(ev.starts_at);
    const end = new Date(ev.ends_at);
    const updated = new Date(ev.updated_at || ev.starts_at);
    // Summary format: "Security <service/event>: <time block>"
    let summary = `Security ${ev.event_title}: ${timeBlock(start, end)}`;
    if (!feed.filtered) summary += ev.person ? ` (${ev.post ? ev.post + ' – ' : ''}${ev.person})` : ` (${ev.post ? ev.post + ' – ' : ''}OPEN)`;
    if (feed.filtered && ev.cover_requested) summary += ' – cover requested';

    const desc = [
      ev.post ? `Post: ${ev.post}` : null,
      `Assigned: ${ev.person || 'Open – needs a volunteer'}`,
      ev.cover_requested ? 'Cover has been requested for this post.' : null,
      ev.notes ? `\n${ev.notes}` : null,
      `\nSwap or cover in the app: ${APP_URL}/#/schedule`
    ].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      // UID includes the person, so a swap removes the event from the old
      // person's calendar and adds it to the new person's.
      `UID:shift-${ev.shift_id}-${ev.roster_id || 'open'}@koinossecurity`,
      'DTSTAMP:' + now,
      'LAST-MODIFIED:' + icsDate(updated),
      'SEQUENCE:' + Math.max(0, Math.floor(updated.getTime() / 1000) - 1700000000),
      'DTSTART:' + icsDate(start),
      'DTEND:' + icsDate(end),
      prop('SUMMARY', summary),
      ev.location ? prop('LOCATION', ev.location) : null,
      prop('DESCRIPTION', desc),
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function prop(name, value) { return `${name}:${escapeText(value)}`; }

// Fold lines longer than 75 octets (RFC 5545 §3.1).
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (curLen + len > limit) { parts.push(cur); cur = ''; curLen = 0; }
    cur += ch; curLen += len;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function timeBlock(start, end) {
  const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(d);
  const a = fmt(start), b = fmt(end);
  const ap = (s) => s.slice(-2);
  return ap(a) === ap(b) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}
