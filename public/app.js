/* Koinos Security — PWA client
 * Plain JavaScript, no build step. Talks to Supabase with the public anon key;
 * every permission is enforced by the database rules in supabase/schema.sql.
 */
(() => {
  'use strict';

  const cfg = window.KOINOS_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const emptyData = () => ({ bulletins: [], sops: [], contacts: [], roster: [], profiles: [], events: [], shifts: [], calendar_feeds: [], event_series: [], series_posts: [] });
  const state = {
    session: null,
    profile: null,
    profileError: null,
    booting: true,
    auth: { step: 'signin', email: '', busy: false, error: '' },
    data: emptyData(),
    sched: { view: 'list', filter: 'upcoming', person: '', day: null, month: new Date() },
    photoUrls: {},
    photoUrlsAt: 0,
    showArchived: false,
    sopQuery: '',
    teamFilter: 'all',
    channel: null,
    installPrompt: null,
    lastSeenAlerts: 0
  };

  const ROLE_LABELS = { pending: 'Pending approval', member: 'Member', admin: 'Admin', superuser: 'Superuser' };
  const role = () => (state.profile && state.profile.role) || null;
  const isMember = () => ['member', 'admin', 'superuser'].includes(role());
  const isAdmin = () => ['admin', 'superuser'].includes(role());
  const isSuper = () => role() === 'superuser';

  // ------------------------------------------------------------------
  // Small DOM helpers (all text goes in as text nodes — no HTML injection)
  // ------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
  }

  const ICONS = {
    bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
    book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
    phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
    users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    menu: ['M3 12h18', 'M3 6h18', 'M3 18h18'],
    back: ['M15 18l-6-6 6-6'],
    chev: ['M9 18l6-6-6-6'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    msg: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    mail: ['M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z', 'M22 6l-10 7L2 6'],
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    calendar: ['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18']
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function friendlyError(e) {
    const msg = (e && (e.message || e.error_description)) || String(e);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach the server. Check your connection and try again.";
    if (/token has expired|otp.*(invalid|expired)|invalid.*token/i.test(msg)) return "That code didn't work or has expired. Check it or send a new one.";
    if (/row-level security|permission denied|not authorized/i.test(msg)) return "You don't have permission to do that.";
    return msg;
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------
  function relTime(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 7 * 86400) return Math.floor(diff / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function nameOf(uid) {
    if (!uid) return '';
    const p = state.data.profiles.find((x) => x.id === uid);
    return p ? (p.full_name || p.email) : '';
  }
  function initials(name) {
    return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }
  const telHref = (p) => 'tel:' + String(p).replace(/[^0-9+*#,;]/g, '');
  const smsHref = (p) => 'sms:' + String(p).replace(/[^0-9+]/g, '');
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

  // ------------------------------------------------------------------
  // Offline copy (kept on this device only; cleared on sign-out)
  // ------------------------------------------------------------------
  const CP = 'koinos:';
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem(CP + k)); } catch { return null; } }
  function cacheSet(k, v) { try { localStorage.setItem(CP + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
  function cacheClear() {
    try { Object.keys(localStorage).filter((k) => k.startsWith(CP)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  const since = () => new Date(Date.now() - 90 * 864e5).toISOString();
  const QUERIES = {
    bulletins: (t) => t.select('*').order('created_at', { ascending: false }),
    sops: (t) => t.select('*').order('category').order('sort_order').order('title'),
    contacts: (t) => t.select('*').order('category').order('sort_order').order('name'),
    roster: (t) => t.select('*').order('sort_order').order('name'),
    profiles: (t) => t.select('*').order('full_name'),
    events: (t) => t.select('*').gte('ends_at', since()).order('starts_at'),
    shifts: (t) => t.select('*, events!inner(ends_at)').gte('events.ends_at', since()).order('sort_order'),
    calendar_feeds: (t) => t.select('*').order('created_at'),
    event_series: (t) => t.select('*'),
    series_posts: (t) => t.select('*').order('sort_order')
  };

  function loadCachedData() {
    for (const t of Object.keys(QUERIES)) {
      const rows = cacheGet('data:' + t);
      if (Array.isArray(rows)) state.data[t] = rows;
    }
  }

  async function refreshTable(t) {
    const { data, error } = await QUERIES[t](sb.from(t));
    if (error) return error;
    if (t === 'shifts') for (const r of data) delete r.events;
    state.data[t] = data;
    cacheSet('data:' + t, data);
    return null;
  }

  async function refreshAll(showToast) {
    if (isMember() && Date.now() - (state.extendedAt || 0) > 12 * 3600 * 1000) {
      state.extendedAt = Date.now();
      try { await sb.rpc('extend_series'); } catch { /* offline */ }
    }
    const errors = (await Promise.all(Object.keys(QUERIES).map(refreshTable))).filter(Boolean);
    await resolvePhotos();
    render();
    if (errors.length) toast(navigator.onLine ? 'Could not refresh — showing saved information' : 'Offline — showing saved information');
    else if (showToast) toast('Up to date');
  }

  async function resolvePhotos() {
    if (Date.now() - state.photoUrlsAt > 6 * 3600 * 1000) { state.photoUrls = {}; state.photoUrlsAt = Date.now(); }
    const paths = [...new Set([...state.data.bulletins, ...state.data.roster]
      .map((r) => r.photo_path).filter((p) => p && !state.photoUrls[p]))];
    if (!paths.length) return;
    const { data, error } = await sb.storage.from('photos').createSignedUrls(paths, 12 * 3600);
    if (error || !data) return;
    for (const d of data) if (d.signedUrl && d.path) state.photoUrls[d.path] = d.signedUrl;
  }

  function subscribe() {
    if (state.channel) return;
    state.channel = sb.channel('koinos-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bulletins' }, async (payload) => {
        await refreshTable('bulletins');
        await resolvePhotos();
        render();
        if (payload.eventType === 'INSERT') {
          const b = payload.new || {};
          toast((b.priority === 'urgent' ? 'URGENT: ' : 'New: ') + (b.title || 'bulletin posted'), 5000);
          if (navigator.vibrate && b.priority === 'urgent') navigator.vibrate([200, 100, 200]);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, async (payload) => {
        await refreshTable('shifts');
        render();
        const n = payload.new || {};
        const me = myRoster();
        if (n.cover_requested && /asked for cover$/.test(n.last_change || '') && (!me || n.roster_id !== me.id)) {
          const e = eventOf(n);
          toast(`Cover needed: ${n.post || 'a post'}${e ? ' – ' + e.title : ''}`, 5000);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, async () => {
        await Promise.all([refreshTable('events'), refreshTable('shifts')]);
        render();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  }

  // ------------------------------------------------------------------
  // Photos
  // ------------------------------------------------------------------
  async function resizeImage(file, max = 1400) {
    let src;
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not read that image. Try a JPG or PNG photo.'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w = src.width, ht = src.height;
    const scale = Math.min(1, max / Math.max(w, ht));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(ht * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.85));
  }

  // Returns { path, oldToRemove }
  async function applyPhoto(folder, oldPath, photo) {
    if (photo && photo.file) {
      const blob = await resizeImage(photo.file);
      const path = `${folder}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
      return { path, oldToRemove: oldPath || null };
    }
    if (photo && photo.remove) return { path: null, oldToRemove: oldPath || null };
    return { path: oldPath || null, oldToRemove: null };
  }
  function removePhoto(path) {
    if (path) sb.storage.from('photos').remove([path]).then(() => {}, () => {});
  }

  function viewPhoto(url) {
    const dlg = h('dialog', { class: 'photo-dialog' },
      h('img', { src: url, alt: '' }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x')));
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.tagName === 'IMG') dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ------------------------------------------------------------------
  // Dialogs and forms
  // ------------------------------------------------------------------
  function openDialog({ title, body, buttons }) {
    const dlg = h('dialog', {});
    const close = () => dlg.close();
    append(dlg, [
      h('div', { class: 'dlg-head' }, h('h2', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'dlg-body' }, body),
      buttons ? h('div', { class: 'dlg-foot' }, buttons(close)) : null
    ]);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return { close };
  }

  // Generic form dialog. Field types: text (default), textarea, select, checkbox,
  // number, date, time, tel, email, password, photo, weekdays, posts.
  // A field may have visible(values) to show/hide it as other fields change.
  function openForm({ title, fields, values = {}, submitLabel = 'Save', onSubmit, onDelete, deleteLabel = 'Delete', deleteConfirm, intro }) {
    const dlg = h('dialog', {});
    const getters = {};
    const wraps = {};
    const photo = { file: null, remove: false };
    const body = h('div', { class: 'dlg-body' }, intro || null);

    for (const f of fields) {
      const id = 'f_' + f.name;
      let wrap;
      if (f.type === 'checkbox') {
        const input = h('input', { type: 'checkbox', id });
        input.checked = values[f.name] != null ? !!values[f.name] : !!f.default;
        getters[f.name] = () => input.checked;
        wrap = h('div', { class: 'field check' }, h('label', { for: id }, input, f.label), f.hint && h('div', { class: 'hint' }, f.hint));
      } else if (f.type === 'photo') {
        const preview = h('img', { class: 'preview' + (f.currentUrl ? '' : ' hidden'), alt: '' });
        if (f.currentUrl) preview.src = f.currentUrl;
        const file = h('input', { type: 'file', accept: 'image/*', id });
        const removeBtn = h('button', { type: 'button', class: 'btn small danger' + (f.currentUrl ? '' : ' hidden') }, 'Remove photo');
        file.addEventListener('change', () => {
          if (!file.files || !file.files[0]) return;
          photo.file = file.files[0];
          photo.remove = false;
          preview.src = URL.createObjectURL(photo.file);
          preview.classList.remove('hidden');
          removeBtn.classList.remove('hidden');
        });
        removeBtn.addEventListener('click', () => {
          photo.file = null;
          photo.remove = true;
          file.value = '';
          preview.classList.add('hidden');
          removeBtn.classList.add('hidden');
        });
        wrap = h('div', { class: 'field photo-field' }, h('label', { for: id }, f.label), preview, file,
          h('div', { class: 'actions' }, removeBtn), f.hint && h('div', { class: 'hint' }, f.hint));
      } else if (f.type === 'weekdays') {
        const sel = new Set(values[f.name] || f.default || []);
        const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const row = h('div', { class: 'weekday-row', role: 'group', 'aria-label': f.label });
        names.forEach((n, i) => {
          const b = h('button', { type: 'button', class: 'wd' + (sel.has(i) ? ' on' : ''), 'aria-pressed': sel.has(i) ? 'true' : 'false', title: full[i] }, n);
          b.addEventListener('click', () => {
            if (sel.has(i)) sel.delete(i); else sel.add(i);
            b.classList.toggle('on', sel.has(i));
            b.setAttribute('aria-pressed', sel.has(i) ? 'true' : 'false');
            refreshVisibility();
          });
          row.append(b);
        });
        getters[f.name] = () => [...sel].sort();
        wrap = h('div', { class: 'field' }, h('label', {}, f.label), row, f.hint && h('div', { class: 'hint' }, f.hint));
      } else if (f.type === 'posts') {
        const editor = postsEditor(values[f.name] || [], f);
        getters[f.name] = editor.get;
        wrap = h('div', { class: 'field' }, h('label', {}, f.label), f.hint && h('div', { class: 'hint' }, f.hint), editor.el);
      } else {
        let input;
        if (f.type === 'textarea') input = h('textarea', { id, rows: f.rows || 8 });
        else if (f.type === 'select') input = h('select', { id }, f.options.map(([v, l]) => h('option', { value: v }, l)));
        else input = h('input', { type: f.type || 'text', id, autocomplete: f.autocomplete || 'off', inputmode: f.inputmode, placeholder: f.placeholder, list: f.list ? id + '_list' : null });
        const v = values[f.name];
        input.value = v != null ? v : (f.default != null ? f.default : (f.type === 'select' ? f.options[0][0] : ''));
        getters[f.name] = () => f.type === 'number' ? Number(input.value || 0)
          : f.type === 'password' ? input.value : input.value.trim();
        getters[f.name].el = input;
        wrap = h('div', { class: 'field' },
          h('label', { for: id }, f.label + (f.required ? ' *' : '')), input,
          f.list ? h('datalist', { id: id + '_list' }, f.list.map((o) => h('option', { value: o }))) : null,
          f.hint && h('div', { class: 'hint' }, typeof f.hint === 'function' ? '' : f.hint));
      }
      wraps[f.name] = wrap;
      body.append(wrap);
    }

    const collect = () => { const out = {}; for (const f of fields) if (getters[f.name]) out[f.name] = getters[f.name](); return out; };
    function refreshVisibility() {
      const vals = collect();
      for (const f of fields) if (f.visible) wraps[f.name].classList.toggle('hidden', !f.visible(vals));
    }
    body.addEventListener('input', refreshVisibility);
    body.addEventListener('change', refreshVisibility);
    refreshVisibility();

    const err = h('div', { class: 'error-text hidden' });
    body.append(err);
    const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); };

    const foot = h('div', { class: 'dlg-foot' },
      onDelete ? h('button', {
        type: 'button', class: 'btn danger', onclick: async (e) => {
          if (deleteConfirm !== false && !confirm(deleteConfirm || 'Delete this? This cannot be undone.')) return;
          const btn = e.currentTarget;
          btn.disabled = true;
          try { await onDelete(); dlg.close(); } catch (ex) { showErr(friendlyError(ex)); btn.disabled = false; }
        }
      }, deleteLabel) : null,
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      saveBtn);

    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.classList.add('hidden');
        const out = collect();
        for (const f of fields) {
          if (f.visible && !f.visible(out)) continue;
          if (f.required && !out[f.name]) {
            showErr(`${f.label} is required.`);
            if (getters[f.name].el) getters[f.name].el.focus();
            return;
          }
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await onSubmit(out, photo);
          dlg.close();
        } catch (ex) {
          showErr(friendlyError(ex));
          saveBtn.disabled = false;
          saveBtn.textContent = submitLabel;
        }
      }
    },
    h('div', { class: 'dlg-head' }, h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    body, foot);

    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // Rows of: post name · CCW required · default person · remove
  function postsEditor(initial, f) {
    const el = h('div', { class: 'posts-editor' });
    const list = h('div', {});
    const rows = [];
    const people = state.data.roster.filter((r) => r.active);
    const listId = 'posts_' + Math.random().toString(36).slice(2);
    const addRow = (p = {}) => {
      const name = h('input', { type: 'text', class: 'pe-name', placeholder: 'Post (e.g. Parking lot)', list: listId, 'aria-label': 'Post name' });
      name.value = p.post || '';
      const ccw = h('input', { type: 'checkbox', 'aria-label': 'CCW required' });
      ccw.checked = !!p.requires_ccw;
      const who = h('select', { class: 'pe-who', 'aria-label': f.personLabel || 'Default person' },
        h('option', { value: '' }, f.openLabel || 'Open'),
        people.map((r) => h('option', { value: r.id }, r.name + (r.ccw_qualified && (!r.ccw_expires_on || daysUntil(r.ccw_expires_on) >= 0) ? ' · CCW' : ''))));
      who.value = p.roster_id || '';
      const warn = h('div', { class: 'pe-warn hidden' });
      const check = () => {
        const r = people.find((x) => x.id === who.value);
        const bad = ccw.checked && r && !(r.ccw_qualified && (!r.ccw_expires_on || daysUntil(r.ccw_expires_on) >= 0));
        warn.textContent = bad ? `${r.name} isn't CCW-qualified (or it has expired).` : '';
        warn.classList.toggle('hidden', !bad);
      };
      ccw.addEventListener('change', check);
      who.addEventListener('change', check);
      const row = { id: p.id || null, name, ccw, who };
      const rm = h('button', { type: 'button', class: 'icon-btn pe-rm', 'aria-label': 'Remove post', onclick: () => { rows.splice(rows.indexOf(row), 1); rowEl.remove(); } }, icon('x'));
      const rowEl = h('div', { class: 'pe-row' },
        h('div', { class: 'pe-line' }, name, rm),
        h('div', { class: 'pe-line' }, h('label', { class: 'pe-ccw' }, ccw, 'CCW required'), who),
        warn);
      rows.push(row);
      list.append(rowEl);
      check();
    };
    (initial.length ? initial : []).forEach(addRow);
    el.append(list,
      h('datalist', { id: listId }, knownPosts().map((o) => h('option', { value: o }))),
      h('button', { type: 'button', class: 'btn small', onclick: () => { addRow(); list.lastChild.querySelector('input').focus(); } }, '+ Add post'));
    return {
      el,
      get: () => rows.map((r) => ({ id: r.id, post: r.name.value.trim(), requires_ccw: r.ccw.checked, roster_id: r.who.value || null }))
        .filter((r) => r.post)
    };
  }

  async function saveRow(table, id, row) {
    const { error } = id
      ? await sb.from(table).update(row).eq('id', id)
      : await sb.from(table).insert(row);
    if (error) throw error;
  }
  async function deleteRow(table, id) {
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) throw error;
  }
  async function afterSave(table, msg) {
    await refreshTable(table);
    await resolvePhotos();
    render();
    if (msg) toast(msg);
  }

  // ------------------------------------------------------------------
  // Auth screens
  // ------------------------------------------------------------------
  function authCard(...content) {
    return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      h('div', { class: 'auth-logo' }, h('img', { src: '/icons/icon-192.png', alt: '' }),
        h('div', {}, h('h1', {}, 'Koinos Security'), h('p', {}, 'Security team app'))),
      content));
  }

  const MIN_PASSWORD = 8;

  function signInView() {
    const a = state.auth;
    const signup = a.step === 'signup';
    const email = h('input', { type: 'email', id: 'email', class: 'input', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' });
    email.value = a.email;
    const pw = h('input', { type: 'password', id: 'password', class: 'input', autocomplete: signup ? 'new-password' : 'current-password' });
    const name = signup ? h('input', { type: 'text', id: 'fullname', class: 'input', autocomplete: 'name', placeholder: 'First and last name' }) : null;
    const pw2 = signup ? h('input', { type: 'password', id: 'password2', class: 'input', autocomplete: 'new-password' }) : null;
    const errEl = h('div', { class: 'error-text' + (a.error ? '' : ' hidden') }, a.error);
    const submitBtn = h('button', { class: 'btn primary block', type: 'submit' }, signup ? 'Create account' : 'Sign in');
    // Update the form in place so typed values are never wiped.
    a.showError = (m) => { a.error = m || ''; errEl.textContent = a.error; errEl.classList.toggle('hidden', !a.error); };
    a.setBusy = (b) => { a.busy = b; submitBtn.disabled = b; submitBtn.textContent = b ? 'Please wait…' : (signup ? 'Create account' : 'Sign in'); };
    const fail = (m) => a.showError(m);

    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        a.email = email.value.trim().toLowerCase();
        if (!validEmail(a.email)) return fail('Enter a valid email address.');
        if (signup) {
          if (!name.value.trim()) return fail('Enter your name.');
          if (pw.value.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters.`);
          if (pw.value !== pw2.value) return fail("Passwords don't match.");
          doSignUp(a.email, pw.value, name.value.trim());
        } else {
          if (!pw.value) return fail('Enter your password.');
          doSignIn(a.email, pw.value);
        }
      }
    },
    h('p', { class: 'lead' }, signup ? 'Create your account. A team admin will approve it before you can see team information.' : 'Sign in to continue.'),
    signup ? h('div', { class: 'field' }, h('label', { for: 'fullname' }, 'Your name'), name) : null,
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), pw,
      signup ? h('div', { class: 'hint' }, `At least ${MIN_PASSWORD} characters.`) : null),
    signup ? h('div', { class: 'field' }, h('label', { for: 'password2' }, 'Confirm password'), pw2) : null,
    submitBtn,
    errEl,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { a.step = signup ? 'signin' : 'signup'; a.error = ''; a.email = email.value.trim(); render(); } },
        signup ? 'I already have an account' : 'Create an account')),
    signup ? null : h('p', { class: 'muted small' }, 'Forgot your password? Contact your team leader.'));
    return authCard(form);
  }

  async function doSignIn(email, password) {
    const a = state.auth;
    a.showError(''); a.setBusy(true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    a.setBusy(false);
    if (error) {
      a.showError(/invalid login credentials/i.test(error.message) ? 'Wrong email or password.' : friendlyError(error));
      return;
    }
    state.auth = { step: 'signin', email: '', busy: false, error: '' };
    // onAuthStateChange picks up the new session.
  }

  async function doSignUp(email, password, fullName) {
    const a = state.auth;
    a.showError(''); a.setBusy(true);
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
    a.setBusy(false);
    if (error) {
      a.showError(/already registered|already exists/i.test(error.message)
        ? 'An account with that email already exists. Sign in instead.'
        : friendlyError(error));
      return;
    }
    if (!data.session) {
      a.step = 'signin';
      a.error = 'Account created, but email confirmation is still turned on in Supabase. Ask your admin to turn it off, then sign in.';
      render();
      return;
    }
    state.auth = { step: 'signin', email: '', busy: false, error: '' };
  }

  function nameView() {
    const input = h('input', { type: 'text', id: 'fullname', class: 'input', autocomplete: 'name', placeholder: 'First and last name' });
    const err = h('div', { class: 'error-text hidden' });
    return authCard(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) { err.textContent = 'Please enter your name.'; err.classList.remove('hidden'); return; }
        const { error } = await sb.rpc('update_my_name', { new_name: name });
        if (error) { err.textContent = friendlyError(error); err.classList.remove('hidden'); return; }
        state.profile.full_name = name;
        cacheSet('profile', state.profile);
        await enterApp();
      }
    },
    h('p', { class: 'lead' }, 'Welcome! What name should the team see?'),
    h('div', { class: 'field' }, h('label', { for: 'fullname' }, 'Your name'), input),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Continue'), err));
  }

  function pendingView() {
    return authCard(
      h('p', { class: 'lead' }, `Thanks, ${state.profile.full_name}. Your account is waiting for approval from a team admin.`),
      h('p', { class: 'muted small' }, `Signed in as ${state.profile.email}. Let your team leader know you've signed up.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => { await loadProfile(); await enterApp(); if (!isMember()) toast('Still waiting for approval'); } }, 'Check again'),
        h('button', { class: 'btn', onclick: signOut }, 'Sign out')));
  }

  function errorView() {
    return authCard(
      h('p', { class: 'lead' }, state.profileError),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => { await loadProfile(); await enterApp(); } }, 'Try again'),
        h('button', { class: 'btn', onclick: signOut }, 'Sign out')));
  }

  async function loadProfile() {
    const uid = state.session && state.session.user.id;
    if (!uid) return;
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) {
      const cached = cacheGet('profile');
      if (cached && cached.id === uid) { state.profile = cached; state.profileError = null; return; }
      state.profile = null;
      state.profileError = /does not exist|PGRST20|schema cache/i.test(error.message || '')
        ? 'The app database has not been set up yet. Run supabase/schema.sql in the Supabase SQL editor, then try again.'
        : friendlyError(error);
      return;
    }
    if (!data) {
      state.profile = null;
      state.profileError = 'Your account profile was not found. If the database was set up after you signed up, sign out and sign in again.';
      return;
    }
    state.profile = data;
    state.profileError = null;
    cacheSet('profile', data);
  }

  async function enterApp() {
    if (isMember() && state.profile.full_name) {
      loadCachedData();
      render();
      await refreshAll();
      subscribe();
    } else {
      render();
    }
  }

  async function signOut() {
    unsubscribe();
    try { await sb.auth.signOut(); } catch { /* offline — local session is still cleared below */ }
    cacheClear();
    state.session = null;
    state.profile = null;
    state.profileError = null;
    state.data = emptyData();
    state.photoUrls = {};
    history.replaceState(null, '', '/');
    render();
  }

  // ------------------------------------------------------------------
  // Routing and main layout
  // ------------------------------------------------------------------
  const TABS = [
    ['alerts', 'Alerts', 'bell'],
    ['schedule', 'Schedule', 'calendar'],
    ['sops', 'SOPs', 'book'],
    ['contacts', 'Contacts', 'phone'],
    ['team', 'Team', 'users'],
    ['more', 'More', 'menu']
  ];
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return [parts[0] || 'alerts', parts[1] ? decodeURIComponent(parts[1]) : null];
  }
  const topAction = (label, fn) => h('button', { class: 'top-action', onclick: fn }, label);
  function empty(text, ic) { return h('div', { class: 'empty' }, ic ? icon(ic) : null, h('div', {}, text)); }
  const isLive = (b) => b.active && (!b.expires_at || new Date(b.expires_at).getTime() > Date.now());
  const unseenAlerts = () => state.data.bulletins.filter((b) => isLive(b) && new Date(b.created_at).getTime() > state.lastSeenAlerts).length;
  const pendingCount = () => state.data.profiles.filter((p) => p.role === 'pending').length;

  function mainView() {
    let [tab, id] = route();
    if (tab === 'users' && !isAdmin()) tab = 'more';
    const views = { alerts: alertsView, schedule: scheduleView, sops: sopsView, contacts: contactsView, team: teamView, more: moreView, users: usersView };
    const v = (views[tab] || alertsView)(id);
    const activeTab = tab === 'users' ? 'more' : (views[tab] ? tab : 'alerts');

    if (activeTab === 'alerts') {
      state.lastSeenAlerts = Date.now();
      cacheSet('lastSeenAlerts', state.lastSeenAlerts);
    }
    const alertCount = activeTab === 'alerts' ? 0 : unseenAlerts();
    const moreCount = isAdmin() ? pendingCount() : 0;

    return h('div', { class: 'shell' },
      h('header', { class: 'topbar' },
        v.back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { location.hash = v.back; } }, icon('back')) : null,
        h('h1', {}, v.title),
        v.action || null),
      navigator.onLine ? null : h('div', { class: 'offline-bar' }, 'Offline — showing saved information'),
      h('main', {}, v.content),
      h('nav', { class: 'tabbar', 'aria-label': 'Main' }, TABS.map(([key, label, ic]) => {
        const count = key === 'alerts' ? alertCount : key === 'more' ? moreCount : key === 'schedule' ? coverCount() : 0;
        return h('a', { href: '#/' + key, class: activeTab === key ? 'active' : null, 'aria-current': activeTab === key ? 'page' : null },
          icon(ic), label, count ? h('span', { class: 'dot' }, count > 9 ? '9+' : count) : null);
      })));
  }

  // ------------------------------------------------------------------
  // Alerts (bulletins / BOLO)
  // ------------------------------------------------------------------
  const PRIORITY_RANK = { urgent: 0, caution: 1, info: 2 };
  function alertsView() {
    const live = state.data.bulletins.filter(isLive);
    const archived = state.data.bulletins.filter((b) => !isLive(b));
    const showing = (state.showArchived ? archived : live).slice().sort((a, b) =>
      state.showArchived
        ? new Date(b.created_at) - new Date(a.created_at)
        : (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (new Date(b.created_at) - new Date(a.created_at)));

    const content = [];
    content.push(h('div', { class: 'chips' },
      h('button', { class: 'chip' + (state.showArchived ? '' : ' on'), onclick: () => { state.showArchived = false; render(); } }, `Current (${live.length})`),
      h('button', { class: 'chip' + (state.showArchived ? ' on' : ''), onclick: () => { state.showArchived = true; render(); } }, `Past (${archived.length})`)));
    if (!showing.length) content.push(empty(state.showArchived ? 'No past bulletins' : 'No active bulletins right now', 'bell'));
    for (const b of showing) content.push(bulletinCard(b));

    return { title: 'Alerts', action: isAdmin() ? topAction('+ New', () => editBulletin()) : null, content };
  }

  function bulletinCard(b) {
    const url = b.photo_path && state.photoUrls[b.photo_path];
    const live = isLive(b);
    return h('article', { class: `card bulletin p-${b.priority}` + (live ? '' : ' inactive') },
      h('div', { class: 'head' },
        h('span', { class: 'badge' + (b.kind === 'bolo' ? ' bolo' : '') }, b.kind === 'bolo' ? 'BOLO' : 'Bulletin'),
        b.priority !== 'info' ? h('span', { class: 'badge ' + b.priority }, b.priority) : null,
        !live ? h('span', { class: 'badge muted-badge' }, b.active ? 'Expired' : 'Archived') : null,
        h('time', { datetime: b.created_at, title: fmtDateTime(b.created_at) }, relTime(b.created_at))),
      url ? h('img', { class: 'bulletin-photo', src: url, alt: 'Bulletin photo', loading: 'lazy', onclick: () => viewPhoto(url) })
        : (b.photo_path ? h('div', { class: 'muted small' }, 'Photo available when online') : null),
      h('h3', {}, b.title),
      b.body ? h('p', { class: 'body-text' }, b.body) : null,
      h('div', { class: 'meta' },
        [nameOf(b.created_by) && `Posted by ${nameOf(b.created_by)}`, b.expires_at && `${live ? 'Expires' : 'Expired'} ${fmtDateTime(b.expires_at)}`].filter(Boolean).join(' · ')),
      isAdmin() ? h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => editBulletin(b) }, 'Edit'),
        h('button', { class: 'btn small', onclick: () => setBulletinActive(b, !b.active) }, b.active ? 'Archive' : 'Restore')) : null);
  }

  async function setBulletinActive(b, active) {
    try {
      await saveRow('bulletins', b.id, { active });
      await afterSave('bulletins', active ? 'Bulletin restored' : 'Bulletin archived');
    } catch (e) { toast(friendlyError(e)); }
  }

  function editBulletin(b) {
    const isNew = !b;
    b = b || {};
    openForm({
      title: isNew ? 'New bulletin' : 'Edit bulletin',
      values: { ...b, expires_at: toLocalInput(b.expires_at) },
      fields: [
        { name: 'kind', label: 'Type', type: 'select', options: [['bulletin', 'Safety bulletin'], ['bolo', 'BOLO (be on the lookout)']] },
        { name: 'priority', label: 'Priority', type: 'select', options: [['info', 'Info'], ['caution', 'Caution'], ['urgent', 'Urgent']] },
        { name: 'title', label: 'Title', required: true, placeholder: 'e.g. Grey sedan seen circling lot' },
        { name: 'body', label: 'Details', type: 'textarea', rows: 6, placeholder: 'Description, what to do, who to notify…' },
        { name: 'photo', label: 'Photo', type: 'photo', currentUrl: b.photo_path ? state.photoUrls[b.photo_path] : null },
        { name: 'expires_at', label: 'Expires (optional)', type: 'datetime-local', hint: 'Leave blank to keep it up until you archive it.' },
        ...(isNew ? [] : [{ name: 'active', label: 'Active', type: 'checkbox' }])
      ],
      submitLabel: isNew ? 'Post' : 'Save',
      onSubmit: async (v, photo) => {
        const ph = await applyPhoto('bulletins', b.photo_path, photo);
        const row = {
          kind: v.kind, priority: v.priority, title: v.title, body: v.body,
          photo_path: ph.path,
          expires_at: v.expires_at ? new Date(v.expires_at).toISOString() : null
        };
        if (!isNew) row.active = v.active;
        try { await saveRow('bulletins', b.id, row); } catch (e) { if (ph.path && ph.path !== b.photo_path) removePhoto(ph.path); throw e; }
        removePhoto(ph.oldToRemove);
        await afterSave('bulletins', isNew ? 'Bulletin posted' : 'Saved');
      },
      onDelete: isNew ? null : async () => {
        await deleteRow('bulletins', b.id);
        removePhoto(b.photo_path);
        await afterSave('bulletins', 'Bulletin deleted');
      },
      deleteConfirm: 'Delete this bulletin permanently? (Use Archive instead to keep a record.)'
    });
  }

  // ------------------------------------------------------------------
  // SOPs
  // ------------------------------------------------------------------
  function groupBy(rows, key) {
    const groups = new Map();
    for (const r of rows) {
      const k = r[key] || 'General';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return groups;
  }
  const categoriesOf = (rows) => [...new Set(rows.map((r) => r.category).filter(Boolean))];

  function sopsView(id) {
    if (id) return sopDetailView(id);
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search SOPs', 'aria-label': 'Search SOPs' });
    search.value = state.sopQuery;
    const listWrap = h('div', {});
    const draw = () => listWrap.replaceChildren(...sopList(state.sopQuery));
    search.addEventListener('input', () => { state.sopQuery = search.value; draw(); });
    draw();
    return { title: 'SOPs', action: isAdmin() ? topAction('+ New', () => editSop()) : null, content: [search, listWrap] };
  }

  function sopList(q) {
    const ql = q.trim().toLowerCase();
    const rows = state.data.sops.filter((s) => !ql || `${s.title} ${s.category} ${s.body}`.toLowerCase().includes(ql));
    if (!rows.length) return [empty(state.data.sops.length ? 'No SOPs match your search' : 'No SOPs yet', 'book')];
    const out = [];
    for (const [cat, items] of groupBy(rows, 'category')) {
      out.push(h('div', { class: 'section-title' }, cat));
      out.push(h('div', { class: 'list' }, items.map((s) =>
        h('a', { class: 'list-item', href: '#/sops/' + encodeURIComponent(s.id) },
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, s.title),
            h('div', { class: 'sub' }, (s.body || '').split('\n').find((l) => l.trim()) || '')),
          icon('chev')))));
    }
    return out;
  }

  function sopDetailView(id) {
    const s = state.data.sops.find((x) => x.id === id);
    if (!s) return { title: 'SOP', back: '#/sops', content: empty('This SOP was not found.', 'book') };
    const who = nameOf(s.updated_by);
    return {
      title: s.category || 'SOP',
      back: '#/sops',
      action: isAdmin() ? topAction('Edit', () => editSop(s)) : null,
      content: h('article', { class: 'card sop-detail' },
        h('h2', {}, s.title),
        h('div', { class: 'meta' }, `Updated ${fmtDateTime(s.updated_at)}${who ? ' by ' + who : ''}`),
        h('div', { class: 'body-text' }, s.body || ''),
        isAdmin() && s.prev_body != null ? h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => revertSop(s) }, 'Revert to previous version')) : null)
    };
  }

  function revertSop(s) {
    const who = nameOf(s.prev_updated_by);
    openDialog({
      title: 'Previous version',
      body: [
        h('div', { class: 'notice' }, 'Reverting replaces the current text with this version. The current text becomes the new "previous version", so you can switch back if needed.'),
        h('div', { class: 'meta' }, `Saved ${fmtDateTime(s.prev_updated_at)}${who ? ' by ' + who : ''}`),
        h('h3', {}, s.prev_title),
        s.prev_category !== s.category ? h('div', { class: 'muted small' }, 'Category: ' + s.prev_category) : null,
        h('div', { class: 'body-text' }, s.prev_body)
      ],
      buttons: (close) => [
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await saveRow('sops', s.id, { title: s.prev_title, category: s.prev_category, body: s.prev_body });
              close();
              await afterSave('sops', 'Reverted to previous version');
            } catch (ex) { toast(friendlyError(ex)); e.currentTarget.disabled = false; }
          }
        }, 'Revert')
      ]
    });
  }

  function editSop(s) {
    const isNew = !s;
    s = s || {};
    openForm({
      title: isNew ? 'New SOP' : 'Edit SOP',
      values: s,
      fields: [
        { name: 'title', label: 'Title', required: true, placeholder: 'e.g. Medical emergency response' },
        { name: 'category', label: 'Category', required: true, default: 'General', list: categoriesOf(state.data.sops), hint: 'Pick an existing category or type a new one.' },
        { name: 'body', label: 'Procedure', type: 'textarea', rows: 14, placeholder: '1. First step\n2. Second step\n…' },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0, inputmode: 'numeric', hint: 'Lower numbers appear first within the category.' }
      ],
      onSubmit: async (v) => {
        await saveRow('sops', s.id, v);
        await afterSave('sops', isNew ? 'SOP added' : 'SOP saved');
      },
      onDelete: isNew ? null : async () => {
        await deleteRow('sops', s.id);
        location.hash = '#/sops';
        await afterSave('sops', 'SOP deleted');
      },
      deleteConfirm: 'Delete this SOP permanently? This cannot be undone.'
    });
  }

  // ------------------------------------------------------------------
  // Contacts
  // ------------------------------------------------------------------
  const callBtn = (phone, alt) => h('a', { class: 'call-btn' + (alt ? ' alt' : ''), href: telHref(phone) }, icon('phone'), alt ? 'Alt' : 'Call');

  function contactsView() {
    const content = [h('a', { class: 'emergency-911', href: 'tel:911' }, icon('phone'), 'Call 911')];
    const rows = state.data.contacts;
    if (!rows.length) content.push(empty('No contacts yet', 'phone'));
    for (const [cat, items] of groupBy(rows, 'category')) {
      content.push(h('div', { class: 'section-title' }, cat));
      content.push(h('div', { class: 'list' }, items.map((c) =>
        h('div', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, c.name),
            c.organization ? h('div', { class: 'sub' }, c.organization) : null,
            c.phone ? h('div', { class: 'sub' }, c.phone + (c.alt_phone ? ' · ' + c.alt_phone : '')) : null,
            c.notes ? h('div', { class: 'sub body-text' }, c.notes) : null,
            isAdmin() ? h('button', { class: 'btn small', onclick: () => editContact(c) }, 'Edit') : null),
          h('div', { class: 'phones' },
            c.phone ? callBtn(c.phone) : null,
            c.alt_phone ? callBtn(c.alt_phone, true) : null)))));
    }
    return { title: 'Contacts', action: isAdmin() ? topAction('+ New', () => editContact()) : null, content };
  }

  function editContact(c) {
    const isNew = !c;
    c = c || {};
    openForm({
      title: isNew ? 'New contact' : 'Edit contact',
      values: c,
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Police (non-emergency)' },
        { name: 'organization', label: 'Organization / role' },
        { name: 'category', label: 'Category', required: true, default: 'General', list: categoriesOf(state.data.contacts), hint: 'e.g. Emergency services, Church staff, Utilities' },
        { name: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel' },
        { name: 'alt_phone', label: 'Alternate phone', type: 'tel', inputmode: 'tel' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 3 },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0, inputmode: 'numeric' }
      ],
      onSubmit: async (v) => { await saveRow('contacts', c.id, v); await afterSave('contacts', 'Contact saved'); },
      onDelete: isNew ? null : async () => { await deleteRow('contacts', c.id); await afterSave('contacts', 'Contact deleted'); }
    });
  }

  // ------------------------------------------------------------------
  // Team roster (with CCW qualification tracking)
  // ------------------------------------------------------------------
  const CCW_WARN_DAYS = 30;
  function dateOnly(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function daysUntil(s) {
    const d = dateOnly(s);
    if (!d) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  }
  const fmtDay = (s) => dateOnly(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  function ccwStatus(p) {
    if (!p.ccw_qualified) return null;
    const d = daysUntil(p.ccw_expires_on);
    if (d == null) return { cls: 'ccw', label: 'CCW', detail: 'No expiry date on file', problem: true };
    if (d < 0) return { cls: 'urgent', label: 'CCW expired', detail: `Expired ${fmtDay(p.ccw_expires_on)}`, problem: true };
    if (d <= CCW_WARN_DAYS) return { cls: 'caution', label: d === 0 ? 'CCW expires today' : `CCW expires in ${d}d`, detail: `Expires ${fmtDay(p.ccw_expires_on)}`, problem: true };
    return { cls: 'ccw', label: 'CCW', detail: `Qualified through ${fmtDay(p.ccw_expires_on)}` };
  }

  function teamView() {
    const all = state.data.roster.filter((p) => p.active || isAdmin());
    const medical = all.filter((p) => p.is_medical);
    const ccw = all.filter((p) => p.ccw_qualified)
      .sort((a, b) => (a.ccw_expires_on || '0000') < (b.ccw_expires_on || '0000') ? -1 : 1);
    const showing = state.teamFilter === 'medical' ? medical : state.teamFilter === 'ccw' ? ccw : all;
    const chip = (key, label) => h('button', { class: 'chip' + (state.teamFilter === key ? ' on' : ''), onclick: () => { state.teamFilter = key; render(); } }, label);
    const content = [h('div', { class: 'chips' },
      chip('all', `Everyone (${all.length})`), chip('medical', `Medical (${medical.length})`), chip('ccw', `CCW (${ccw.length})`))];

    const problems = ccw.filter((p) => p.active && ccwStatus(p).problem);
    if (isAdmin() && problems.length) {
      content.push(h('button', { class: 'notice block-btn', onclick: () => { state.teamFilter = 'ccw'; render(); } },
        `${problems.length} CCW qualification${problems.length > 1 ? 's' : ''} expired, expiring within ${CCW_WARN_DAYS} days, or missing a date: `,
        problems.map((p) => p.name).join(', ')));
    }
    if (!showing.length) content.push(empty(
      state.teamFilter === 'medical' ? 'No medical points of contact listed'
        : state.teamFilter === 'ccw' ? 'No CCW-qualified team members listed' : 'No team members listed yet', 'users'));
    else content.push(h('div', { class: 'roster-grid' }, showing.map(personCard)));
    return { title: 'Team', action: isAdmin() ? topAction('+ New', () => editPerson()) : null, content };
  }

  function personPhoto(p, cls) {
    const url = p.photo_path && state.photoUrls[p.photo_path];
    return url ? h('img', { class: cls || 'photo', src: url, alt: p.name, loading: 'lazy' }) : h('div', { class: 'initials' }, initials(p.name));
  }

  function personCard(p) {
    const c = ccwStatus(p);
    return h('button', { class: 'person' + (p.active ? '' : ' inactive'), onclick: () => openPerson(p) },
      personPhoto(p),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, p.name),
        p.position ? h('div', { class: 'pos' }, p.position) : null,
        h('div', { class: 'badges' },
          p.is_medical ? h('span', { class: 'badge medical' }, 'Medical') : null,
          c ? h('span', { class: 'badge ' + c.cls }, c.label) : null,
          !p.active ? h('span', { class: 'badge muted-badge' }, 'Inactive') : null)));
  }

  function openPerson(p) {
    const url = p.photo_path && state.photoUrls[p.photo_path];
    const c = ccwStatus(p);
    openDialog({
      title: p.name,
      body: [
        url ? h('img', { class: 'profile-photo', src: url, alt: p.name, onclick: () => viewPhoto(url) }) : null,
        p.position ? h('div', { class: 'muted' }, p.position) : null,
        p.is_medical ? h('div', { class: 'card' },
          h('span', { class: 'badge medical' }, 'Medical point of contact'),
          p.medical_notes ? h('div', { class: 'body-text' }, p.medical_notes) : null) : null,
        c ? h('div', { class: 'card' },
          h('span', { class: 'badge ' + c.cls }, c.label === 'CCW' ? 'CCW qualified' : c.label),
          h('div', { class: 'body-text' }, c.detail)) : null,
        p.phone ? h('div', { class: 'meta' }, p.phone) : null,
        p.email ? h('div', { class: 'meta' }, p.email) : null,
        h('div', { class: 'actions' },
          p.phone ? h('a', { class: 'call-btn', href: telHref(p.phone) }, icon('phone'), 'Call') : null,
          p.phone ? h('a', { class: 'call-btn alt', href: smsHref(p.phone) }, icon('msg'), 'Text') : null,
          validEmail(p.email) ? h('a', { class: 'call-btn alt', href: 'mailto:' + p.email }, icon('mail'), 'Email') : null)
      ],
      buttons: isAdmin() ? (close) => [h('button', { class: 'btn', onclick: () => { close(); editPerson(p); } }, 'Edit')] : null
    });
  }

  function editPerson(p) {
    const isNew = !p;
    p = p || {};
    const accounts = state.data.profiles.filter((a) => a.role !== 'pending');
    openForm({
      title: isNew ? 'Add team member' : 'Edit team member',
      values: { ...p, profile_id: p.profile_id || '', ccw_expires_on: p.ccw_expires_on || '' },
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'position', label: 'Position / usual post', placeholder: 'e.g. Team lead, Parking lot, Sanctuary' },
        { name: 'phone', label: 'Phone', type: 'tel', inputmode: 'tel' },
        { name: 'email', label: 'Email', type: 'email', inputmode: 'email' },
        { name: 'profile_id', label: 'App account', type: 'select',
          options: [['', 'Not linked'], ...accounts.map((a) => [a.id, `${a.full_name || '(no name)'} — ${a.email}`])],
          hint: 'Link the person\'s sign-in so they can see "My assignments" and volunteer or swap. Left blank, it links automatically when the email matches.' },
        { name: 'photo', label: 'Photo', type: 'photo', currentUrl: p.photo_path ? state.photoUrls[p.photo_path] : null },
        { name: 'is_medical', label: 'Medical point of contact', type: 'checkbox' },
        { name: 'medical_notes', label: 'Medical qualifications', placeholder: 'e.g. RN, EMT, CPR/AED certified' },
        { name: 'ccw_qualified', label: 'CCW qualified', type: 'checkbox' },
        { name: 'ccw_expires_on', label: 'CCW qualification expires', type: 'date', hint: `Admins are warned ${CCW_WARN_DAYS} days before it expires.` },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0, inputmode: 'numeric' },
        { name: 'active', label: 'Active on the team', type: 'checkbox', default: true }
      ],
      onSubmit: async (v, photo) => {
        if (!v.profile_id && v.email) {
          const match = accounts.find((a) => a.email && a.email.toLowerCase() === v.email.toLowerCase());
          const taken = match && state.data.roster.some((r) => r.profile_id === match.id && r.id !== p.id);
          if (match && !taken) v.profile_id = match.id;
        }
        if (v.ccw_qualified && !v.ccw_expires_on && !confirm('CCW is checked but there is no expiry date. Save anyway?')) throw new Error('Add the CCW expiry date, then save.');
        const ph = await applyPhoto('roster', p.photo_path, photo);
        const row = { ...v, profile_id: v.profile_id || null, ccw_expires_on: v.ccw_expires_on || null, photo_path: ph.path };
        try {
          await saveRow('roster', p.id, row);
        } catch (e) {
          if (ph.path && ph.path !== p.photo_path) removePhoto(ph.path);
          if (/roster_profile_id_key|duplicate key/i.test(e.message || '')) throw new Error('That app account is already linked to another roster entry.');
          throw e;
        }
        removePhoto(ph.oldToRemove);
        await afterSave('roster', isNew ? 'Team member added' : 'Saved');
      },
      onDelete: isNew ? null : async () => {
        await deleteRow('roster', p.id);
        removePhoto(p.photo_path);
        await afterSave('roster', 'Removed from roster');
      },
      deleteConfirm: 'Remove this person from the roster permanently? Their scheduled posts become open. (Unchecking "Active" hides them instead.)'
    });
  }

  // ------------------------------------------------------------------
  // Schedule
  // ------------------------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function timeRange(a, b) {
    const s = fmtTime(a), e = fmtTime(b);
    const ap = (x) => x.slice(-2);
    return /[AP]M$/.test(s) && ap(s) === ap(e) ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
  }
  // Combine a date ("2026-09-27") and time ("08:15") in local time; end before start = next day.
  function localIso(date, time) { return new Date(`${date}T${time}`).toISOString(); }
  function endIso(date, start, end) {
    const s = new Date(`${date}T${start}`), e = new Date(`${date}T${end}`);
    if (e <= s) e.setDate(e.getDate() + 1);
    return e.toISOString();
  }

  const myRoster = () => state.profile && state.data.roster.find((r) => r.profile_id === state.profile.id && r.active);
  const rosterName = (id) => { const r = state.data.roster.find((x) => x.id === id); return r ? r.name : 'Unknown'; };
  const eventOf = (s) => state.data.events.find((e) => e.id === s.event_id);
  const shiftStart = (s, e) => new Date(s.starts_at || e.starts_at);
  const shiftEnd = (s, e) => new Date(s.ends_at || e.ends_at);
  const isUpcoming = (e) => new Date(e.ends_at).getTime() > Date.now();
  const shiftsOf = (e) => state.data.shifts.filter((s) => s.event_id === e.id)
    .sort((a, b) => (a.sort_order - b.sort_order) || (shiftStart(a, e) - shiftStart(b, e)) || (a.post || '').localeCompare(b.post || ''));
  const needsHelp = (s) => !s.roster_id || s.cover_requested;

  function coverCount() {
    const me = myRoster();
    const soon = Date.now() + 14 * 864e5;
    return state.data.shifts.filter((s) => {
      const e = eventOf(s);
      return e && isUpcoming(e) && new Date(e.starts_at).getTime() < soon && needsHelp(s) && (!me || s.roster_id !== me.id);
    }).length;
  }

  // Returns [{ event, shifts }] after applying the current filters.
  function scheduleRows() {
    const f = state.sched;
    const me = myRoster();
    const person = f.filter === 'mine' ? (me && me.id) : f.person;
    // The month grid is a calendar: it shows past days too (except on the Past filter, which is past-only anyway).
    const monthAll = f.view === 'month' && f.filter !== 'cover';
    let events = state.data.events.filter((e) => monthAll ? true : f.filter === 'past' ? !isUpcoming(e) : isUpcoming(e));
    events.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    if (f.filter === 'past') events.reverse();
    const rows = [];
    for (const e of events) {
      let shifts = shiftsOf(e);
      if (f.filter === 'mine' && !person) shifts = [];
      if (person) shifts = shifts.filter((s) => s.roster_id === person);
      if (f.filter === 'cover') shifts = shifts.filter(needsHelp);
      const filtered = person || f.filter === 'cover' || f.filter === 'mine';
      if (filtered && !shifts.length) continue;
      rows.push({ event: e, shifts });
    }
    return rows;
  }

  function scheduleView() {
    const f = state.sched;
    const me = myRoster();
    const chip = (key, label) => h('button', { class: 'chip' + (f.filter === key ? ' on' : ''), onclick: () => { f.filter = key; render(); } }, label);
    const cc = coverCount();
    const content = [h('div', { class: 'chips' },
      chip('upcoming', 'Upcoming'), chip('mine', 'Mine'), chip('cover', cc ? `Needs cover (${cc})` : 'Needs cover'), chip('past', 'Past'))];

    const personSel = h('select', { class: 'input small-select', 'aria-label': 'Show schedule for' },
      h('option', { value: '' }, 'Everyone'),
      state.data.roster.filter((r) => r.active).map((r) => h('option', { value: r.id }, r.name)));
    personSel.value = f.person;
    personSel.addEventListener('change', () => { f.person = personSel.value; render(); });
    content.push(h('div', { class: 'sched-tools' },
      f.filter === 'mine' ? h('div', { class: 'grow muted small' }, me ? `Showing posts for ${me.name}` : '') : personSel,
      h('div', { class: 'seg' },
        h('button', { class: f.view === 'list' ? 'on' : '', onclick: () => { f.view = 'list'; render(); } }, 'List'),
        h('button', { class: f.view === 'month' ? 'on' : '', onclick: () => { f.view = 'month'; render(); } }, 'Month')),
      h('button', { class: 'btn small', onclick: openFeeds }, icon('calendar'), 'Subscribe')));

    if (f.filter === 'mine' && !me) {
      content.push(h('div', { class: 'notice' }, 'Your sign-in is not linked to your name on the team roster yet, so the app can\'t show "My assignments". Ask an admin to open Team → your name → Edit and choose your account under "App account".'));
    }

    const rows = scheduleRows();
    if (f.view === 'month') content.push(monthView(rows));
    else if (!rows.length) {
      content.push(empty(f.filter === 'past' ? 'No past events in the last 90 days'
        : f.filter === 'cover' ? 'Every upcoming post is covered'
          : f.filter === 'mine' ? 'You have no upcoming assignments' : 'Nothing scheduled yet', 'calendar'));
    } else {
      let lastDay = '';
      for (const r of rows) {
        const day = ymd(new Date(r.event.starts_at));
        if (day !== lastDay) {
          content.push(h('div', { class: 'section-title' }, new Date(r.event.starts_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })));
          lastDay = day;
        }
        content.push(eventCard(r.event, r.shifts));
      }
    }
    return { title: 'Schedule', action: isAdmin() ? topAction('+ New', () => editEvent()) : null, content };
  }

  function monthView(rows) {
    const f = state.sched;
    const first = new Date(f.month.getFullYear(), f.month.getMonth(), 1);
    const byDay = new Map();
    for (const r of rows) {
      const k = ymd(new Date(r.event.starts_at));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }
    const me = myRoster();
    const today = ymd(new Date());
    if (!f.day) f.day = today;
    const grid = h('div', { class: 'month-grid' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => h('div', { class: 'dow' }, d)));
    for (let i = 0; i < first.getDay(); i++) grid.append(h('div', {}));
    const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= daysIn; d++) {
      const k = ymd(new Date(first.getFullYear(), first.getMonth(), d));
      const dayRows = byDay.get(k) || [];
      const mine = me && dayRows.some((r) => r.shifts.some((s) => s.roster_id === me.id));
      const help = dayRows.some((r) => isUpcoming(r.event) && r.shifts.some(needsHelp));
      grid.append(h('button', {
        class: 'day' + (k === today ? ' today' : '') + (k === f.day ? ' sel' : '') + (dayRows.length ? ' has' : ''),
        onclick: () => { f.day = k; render(); }
      }, String(d), dayRows.length ? h('span', { class: 'dots' },
        h('span', { class: 'dot-ev' + (mine ? ' mine' : '') }), help ? h('span', { class: 'dot-ev help' }) : null) : null));
    }
    const dayRows = byDay.get(f.day) || [];
    return [
      h('div', { class: 'month-head' },
        h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { f.month = new Date(first.getFullYear(), first.getMonth() - 1, 1); render(); } }, icon('back')),
        h('div', { class: 'grow center-text' }, first.toLocaleDateString([], { month: 'long', year: 'numeric' })),
        h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { f.month = new Date(first.getFullYear(), first.getMonth() + 1, 1); render(); } }, icon('chev'))),
      grid,
      h('div', { class: 'legend muted small' }, h('span', { class: 'dot-ev mine' }), ' my post ', h('span', { class: 'dot-ev' }), ' event ', h('span', { class: 'dot-ev help' }), ' needs cover'),
      h('div', { class: 'section-title' }, dateOnly(f.day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })),
      dayRows.length ? dayRows.map((r) => eventCard(r.event, r.shifts)) : h('div', { class: 'card muted small' }, 'Nothing scheduled this day' + (state.sched.filter !== 'upcoming' ? ' (with the current filter)' : '') + '.')
    ];
  }

  // CCW valid on the date of an event (local date string).
  function ccwOkOn(r, iso) {
    if (!r || !r.ccw_qualified) return false;
    if (!r.ccw_expires_on) return true;
    return r.ccw_expires_on >= ymd(new Date(iso));
  }
  const seriesOf = (e) => e.series_id && state.data.event_series.find((s) => s.id === e.series_id);

  function repeatLabel(s) {
    if (!s) return '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const start = dateOnly(s.starts_on);
    let t;
    if (s.freq === 'daily') t = s.interval_n > 1 ? `Every ${s.interval_n} days` : 'Daily';
    else if (s.freq === 'weekly') {
      const wd = (s.by_weekday && s.by_weekday.length ? s.by_weekday : [start.getDay()]).map((d) => days[d]).join(', ');
      t = (s.interval_n === 2 ? 'Every 2 weeks on ' : s.interval_n > 1 ? `Every ${s.interval_n} weeks on ` : 'Weekly on ') + wd;
    } else {
      const nth = ['1st', '2nd', '3rd', '4th', '5th'][Math.ceil(start.getDate() / 7) - 1];
      t = s.monthly_mode === 'nth' ? `Monthly on the ${nth} ${days[start.getDay()]}`
        : s.monthly_mode === 'last' ? `Monthly on the last ${days[start.getDay()]}`
          : `Monthly on day ${start.getDate()}`;
    }
    return t + (s.until ? ` until ${fmtDay(s.until)}` : '');
  }

  function eventCard(e, shifts) {
    const me = myRoster();
    const start = new Date(e.starts_at), end = new Date(e.ends_at);
    const upcoming = isUpcoming(e);
    const allShifts = shiftsOf(e);
    const open = allShifts.filter((s) => !s.roster_id).length;
    const series = seriesOf(e);
    return h('article', { class: 'card event-card' + (upcoming ? '' : ' inactive') },
      h('div', { class: 'row' },
        h('div', { class: 'date-pill' },
          h('div', { class: 'dp-dow' }, start.toLocaleDateString([], { weekday: 'short' })),
          h('div', { class: 'dp-day' }, String(start.getDate()))),
        h('div', { class: 'grow' },
          h('h3', {}, e.title),
          h('div', { class: 'muted small' }, timeRange(start, end) + (e.location ? ' · ' + e.location : '')),
          series ? h('div', { class: 'muted tiny repeat-line' }, '↻ ' + repeatLabel(series) + (e.is_exception ? ' · changed for this date' : '')) : null,
          open && upcoming ? h('span', { class: 'badge caution' }, `${open} open post${open > 1 ? 's' : ''}`) : null)),
      e.notes ? h('p', { class: 'body-text small' }, e.notes) : null,
      h('div', { class: 'shift-list' },
        shifts.length ? shifts.map((s) => shiftRow(s, e, me, upcoming))
          : h('div', { class: 'muted small shift-empty' }, isAdmin() ? 'No posts yet — add one below.' : 'No posts assigned yet.')),
      isAdmin() ? h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => editShift(null, e) }, '+ Post'),
        h('button', { class: 'btn small', onclick: () => editEvent(e) }, 'Edit event'),
        series ? null : h('button', { class: 'btn small', onclick: () => duplicateEvent(e) }, 'Duplicate')) : null);
  }

  // Small round photo (or initials) that opens the person's team card.
  function avatar(r) {
    const url = r.photo_path && state.photoUrls[r.photo_path];
    return h('button', { type: 'button', class: 'avatar', 'aria-label': `View ${r.name}`, title: r.name, onclick: () => openPerson(r) },
      url ? h('img', { src: url, alt: '', loading: 'lazy' }) : initials(r.name));
  }

  function shiftRow(s, e, me, upcoming) {
    const mine = me && s.roster_id === me.id;
    const st = shiftStart(s, e), en = shiftEnd(s, e);
    const customTime = s.starts_at || s.ends_at;
    const assigned = s.roster_id && state.data.roster.find((r) => r.id === s.roster_id);
    const notCcw = s.requires_ccw && s.roster_id && !ccwOkOn(assigned, e.starts_at);
    const iCanCcw = !s.requires_ccw || ccwOkOn(me, e.starts_at);
    const actions = [];
    if (upcoming && me) {
      if (!s.roster_id) {
        actions.push(iCanCcw
          ? h('button', { class: 'btn small primary', onclick: () => shiftAction('volunteer_shift', { p_shift: s.id }, `Volunteer for ${s.post || 'this post'} at ${e.title}?`, "You're on the schedule — thanks!") }, 'Volunteer')
          : h('span', { class: 'muted tiny' }, 'CCW required'));
      } else if (mine && !s.cover_requested) actions.push(h('button', { class: 'btn small', onclick: () => shiftAction('request_cover', { p_shift: s.id, p_on: true }, 'Ask the team to cover this post? You stay assigned until someone takes it.', 'Cover requested — the team can see it now') }, 'Need cover'));
      else if (mine && s.cover_requested) actions.push(h('button', { class: 'btn small', onclick: () => shiftAction('request_cover', { p_shift: s.id, p_on: false }, null, 'Cover request withdrawn') }, 'Cancel request'));
      else if (s.cover_requested) {
        actions.push(iCanCcw
          ? h('button', { class: 'btn small primary', onclick: () => shiftAction('cover_shift', { p_shift: s.id }, `Cover ${rosterName(s.roster_id)}'s ${s.post || 'post'} at ${e.title}?`, "You're covering — thanks!") }, "I'll cover")
          : h('span', { class: 'muted tiny' }, 'CCW required'));
      }
    }
    if (isAdmin()) actions.push(h('button', { class: 'btn small', onclick: () => editShift(s, e) }, 'Edit'));
    return h('div', { class: 'shift' + (mine ? ' mine' : '') },
      h('div', { class: 'grow' },
        h('div', { class: 'shift-post' }, s.post || 'Post',
          s.requires_ccw ? h('span', { class: 'badge ccw inline' }, 'CCW') : null,
          customTime ? h('span', { class: 'muted small' }, ' · ' + timeRange(st, en)) : null),
        h('div', { class: 'shift-person' },
          assigned ? avatar(assigned) : h('span', { class: 'avatar open', 'aria-hidden': 'true' }, '?'),
          s.roster_id ? h('span', { class: 'person-name' }, rosterName(s.roster_id) + (mine ? ' (you)' : '')) : h('span', { class: 'badge caution' }, 'Open'),
          notCcw ? h('span', { class: 'badge urgent' }, 'Not CCW') : null,
          s.cover_requested ? h('span', { class: 'badge urgent' }, 'Needs cover') : null),
        s.note ? h('div', { class: 'muted small' }, s.note) : null,
        s.last_change ? h('div', { class: 'muted tiny' }, `${s.last_change} · ${relTime(s.updated_at)}`) : null),
      actions.length ? h('div', { class: 'shift-actions' }, actions) : null);
  }

  async function shiftAction(fn, args, confirmText, doneText) {
    if (confirmText && !confirm(confirmText)) return;
    const { error } = await sb.rpc(fn, args);
    if (error) { toast(friendlyError(error), 5000); await refreshTable('shifts'); render(); return; }
    await refreshTable('shifts');
    render();
    toast(doneText);
  }

  function knownPosts() {
    return [...new Set([...state.data.shifts, ...state.data.series_posts].map((s) => s.post).filter(Boolean))].sort();
  }
  // Suggest the posts from a typical recent event (the fullest of the last 10).
  function lastEventPosts() {
    const recent = state.data.events.slice().sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at)).slice(0, 10);
    let best = [];
    for (const e of recent) {
      const p = shiftsOf(e).filter((s) => s.post).map((s) => ({ post: s.post, requires_ccw: !!s.requires_ccw }));
      if (p.length > best.length) best = p;
    }
    return best;
  }

  // ---- Event create / edit (one-off or repeating, like a phone calendar) ----
  const REPEAT_OPTIONS = [
    ['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'],
    ['monthly_day', 'Every month (same date)'], ['monthly_nth', 'Every month (same weekday, e.g. 2nd Sunday)'],
    ['monthly_last', 'Every month (last weekday, e.g. last Sunday)']
  ];
  function repeatValue(s) {
    if (!s) return 'none';
    if (s.freq === 'daily') return 'daily';
    if (s.freq === 'weekly') return s.interval_n === 2 ? 'biweekly' : 'weekly';
    return 'monthly_' + s.monthly_mode;
  }
  function repeatPayload(v, date) {
    const map = {
      none: { freq: 'none' }, daily: { freq: 'daily', interval_n: 1 }, weekly: { freq: 'weekly', interval_n: 1 },
      biweekly: { freq: 'weekly', interval_n: 2 }, monthly_day: { freq: 'monthly', monthly_mode: 'day' },
      monthly_nth: { freq: 'monthly', monthly_mode: 'nth' }, monthly_last: { freq: 'monthly', monthly_mode: 'last' }
    };
    const out = { ...map[v.repeat] };
    if (out.freq === 'weekly') out.by_weekday = v.weekdays && v.weekdays.length ? v.weekdays : [dateOnly(date).getDay()];
    return out;
  }

  function editEvent(e) {
    if (!e) return eventForm({ mode: 'new' });
    if (!e.series_id) return eventForm({ mode: 'oneoff', event: e });
    chooseScope('Edit repeating event', 'Which events do you want to change?', (scope) => {
      if (scope === 'one') eventForm({ mode: 'one', event: e });
      else eventForm({ mode: scope, event: e, series: seriesOf(e) });
    });
  }

  function chooseScope(title, question, cb) {
    openDialog({
      title,
      body: [h('p', {}, question)],
      buttons: (close) => [
        h('button', { class: 'btn', onclick: () => { close(); cb('one'); } }, 'This event only'),
        h('button', { class: 'btn', onclick: () => { close(); cb('future'); } }, 'This and following'),
        h('button', { class: 'btn', onclick: () => { close(); cb('all'); } }, 'All events')
      ]
    });
  }

  function eventForm({ mode, event: e, series: s }) {
    const isSeriesEdit = mode === 'future' || mode === 'all';
    const start = e ? new Date(e.starts_at) : null, end = e ? new Date(e.ends_at) : null;
    const nextSunday = new Date(); nextSunday.setDate(nextSunday.getDate() + ((7 - nextSunday.getDay()) % 7 || 7));
    const seriesPosts = s ? state.data.series_posts.filter((p) => p.series_id === s.id).sort((a, b) => a.sort_order - b.sort_order) : [];

    let values;
    if (mode === 'new') values = { date: ymd(nextSunday), start: '08:30', end: '10:30', repeat: 'none', weekdays: [0], posts: lastEventPosts() };
    else if (isSeriesEdit) values = {
      title: s.title, date: e.occurrence_date || ymd(start), start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5),
      location: s.location, notes: s.notes, repeat: repeatValue(s), weekdays: s.by_weekday && s.by_weekday.length ? s.by_weekday : [dateOnly(s.starts_on).getDay()],
      until: s.until || '', posts: seriesPosts.map((p) => ({ id: p.id, post: p.post, requires_ccw: p.requires_ccw, roster_id: p.roster_id }))
    };
    else values = { title: e.title, date: ymd(start), start: hm(start), end: hm(end), location: e.location, notes: e.notes, repeat: 'none', weekdays: [start.getDay()] };

    const showRepeat = mode !== 'one';
    const showPosts = mode === 'new' || isSeriesEdit;
    const repeats = (v) => v.repeat && v.repeat !== 'none';
    const fields = [
      { name: 'title', label: 'Service / event', required: true, placeholder: 'e.g. Sunday Worship', list: [...new Set(state.data.events.map((x) => x.title))] },
      ...(mode === 'all' ? [] : [{ name: 'date', label: mode === 'future' ? 'Date (changes start from here)' : 'Date', type: 'date', required: true }]),
      { name: 'start', label: 'Security starts', type: 'time', required: true },
      { name: 'end', label: 'Security ends', type: 'time', required: true, hint: 'An end time earlier than the start is treated as the next day.' },
      { name: 'location', label: 'Location', placeholder: 'Campus or building' },
      { name: 'notes', label: 'Notes for the team', type: 'textarea', rows: 3 },
      ...(showRepeat ? [
        { name: 'repeat', label: 'Repeat', type: 'select', options: isSeriesEdit ? REPEAT_OPTIONS.slice(1) : REPEAT_OPTIONS },
        { name: 'weekdays', label: 'On these days', type: 'weekdays', visible: (v) => v.repeat === 'weekly' || v.repeat === 'biweekly' },
        { name: 'until', label: 'End repeat (optional)', type: 'date', hint: 'Leave blank to keep repeating. Dates are filled in about 6 months ahead.', visible: repeats }
      ] : []),
      ...(showPosts ? [{
        name: 'posts', label: 'Posts', type: 'posts',
        hint: mode === 'new'
          ? 'Each post can require a CCW-qualified person and have a default person. Repeating events copy these to every date.'
          : 'Changes here apply to the dates you chose. Swaps and one-off changes on specific dates are kept.'
      }] : [])
    ];

    const titles = { new: 'New event', oneoff: 'Edit event', one: 'Edit this event only', future: 'Edit this and following', all: 'Edit all events' };
    const intro = mode === 'one' ? h('div', { class: 'notice' }, 'Changes apply only to this date. Future changes to the repeating event won\'t overwrite it.')
      : mode === 'oneoff' ? h('p', { class: 'muted small' }, 'To edit posts, use the Edit buttons on the event card. Choose a Repeat option to turn this into a repeating event (its current posts become the template).')
        : null;

    openForm({
      title: titles[mode],
      intro,
      values,
      fields,
      submitLabel: mode === 'new' ? 'Create' : 'Save',
      onSubmit: async (v) => {
        if (showPosts) {
          const posts = v.posts;
          const bad = posts.filter((p) => p.requires_ccw && p.roster_id).map((p) => state.data.roster.find((r) => r.id === p.roster_id))
            .filter((r) => r && !(r.ccw_qualified && (!r.ccw_expires_on || daysUntil(r.ccw_expires_on) >= 0)));
          if (bad.length && !confirm(`${bad.map((r) => r.name).join(', ')} ${bad.length > 1 ? 'are' : 'is'} set as default for a CCW post but not CCW-qualified. Save anyway?`)) throw new Error('Change the default person for the CCW post, then save.');
        }
        // One date of a series, or a plain event staying plain
        if (mode === 'one' || (mode === 'oneoff' && v.repeat === 'none')) {
          const row = { title: v.title, starts_at: localIso(v.date, v.start), ends_at: endIso(v.date, v.start, v.end), location: v.location, notes: v.notes };
          if (mode === 'one') row.is_exception = true;
          await saveRow('events', e.id, row);
          await afterSaveSchedule('Event saved', row.ends_at);
          return;
        }
        const date = mode === 'all' ? s.starts_on : v.date;
        const p = {
          title: v.title, location: v.location, notes: v.notes, start_time: v.start, end_time: v.end,
          starts_on: date, until: v.until || null, ...repeatPayload(v, date)
        };
        if (mode === 'new') p.posts = v.posts;
        if (mode === 'oneoff') {
          p.convert_event_id = e.id;
          p.posts = shiftsOf(e).map((x) => ({ post: x.post, requires_ccw: !!x.requires_ccw, roster_id: x.roster_id }));
        }
        if (isSeriesEdit) { p.series_id = s.id; p.scope = mode; p.from_date = e.occurrence_date; p.posts = v.posts; }
        if (p.until && p.until < date) throw new Error('The end-repeat date is before the start date.');
        const { error } = await sb.rpc('save_event_series', { p });
        if (error) throw error;
        await afterSaveSchedule(mode === 'new' ? (p.freq === 'none' ? 'Event created' : 'Repeating event created') : 'Saved',
          p.freq === 'none' ? endIso(v.date, v.start, v.end) : null);
      },
      onDelete: mode === 'new' ? null : async () => {
        const scope = mode === 'oneoff' ? 'one' : mode;
        const { error } = await sb.rpc('delete_series_event', { p_event: e.id, p_scope: scope });
        if (error) throw error;
        await afterSaveSchedule('Deleted');
      },
      deleteConfirm: mode === 'one' ? 'Delete just this date? The rest of the repeating event stays.'
        : mode === 'future' ? 'Delete this date and every later one? Earlier dates stay.'
          : mode === 'all' ? 'Delete this repeating event? All upcoming dates are removed; past ones stay on record.'
            : 'Delete this event and all of its posts? It will disappear from everyone\'s calendars.'
    });
  }

  function duplicateEvent(e) {
    const s = new Date(e.starts_at);
    const next = new Date(s); next.setDate(next.getDate() + 7);
    openForm({
      title: 'Duplicate event',
      values: { date: ymd(next), keep: true },
      fields: [
        { name: 'date', label: 'New date', type: 'date', required: true },
        { name: 'keep', label: 'Keep the same people assigned', type: 'checkbox' }
      ],
      intro: h('p', { class: 'muted small' }, 'Tip: for services that happen regularly, use Edit event → Repeat instead.'),
      submitLabel: 'Duplicate',
      onSubmit: async (v) => {
        const delta = new Date(`${v.date}T${hm(s)}`) - s;
        const move = (iso) => iso ? new Date(new Date(iso).getTime() + delta).toISOString() : null;
        const { data, error } = await sb.from('events').insert({ title: e.title, starts_at: move(e.starts_at), ends_at: move(e.ends_at), location: e.location, notes: e.notes }).select('id').single();
        if (error) throw error;
        const rows = shiftsOf(e).map((x) => ({ event_id: data.id, post: x.post, requires_ccw: !!x.requires_ccw, starts_at: move(x.starts_at), ends_at: move(x.ends_at), roster_id: v.keep ? x.roster_id : null, note: x.note, sort_order: x.sort_order }));
        if (rows.length) { const { error: e2 } = await sb.from('shifts').insert(rows); if (e2) throw e2; }
        await afterSaveSchedule('Event duplicated');
      }
    });
  }

  function editShift(s, e) {
    const isNew = !s;
    s = s || {};
    const st = s.starts_at ? new Date(s.starts_at) : null, en = s.ends_at ? new Date(s.ends_at) : null;
    const people = state.data.roster.filter((r) => r.active || r.id === s.roster_id);
    openForm({
      title: isNew ? `Add post — ${e.title}` : `Edit post — ${e.title}`,
      intro: e.series_id ? h('p', { class: 'muted small' }, 'This changes the post for this date only. To change it on every date, use Edit event → This and following / All events.') : null,
      values: { post: s.post || '', requires_ccw: !!s.requires_ccw, roster_id: s.roster_id || '', start: st ? hm(st) : '', end: en ? hm(en) : '', note: s.note || '', cover_requested: !!s.cover_requested, sort_order: s.sort_order || 0 },
      fields: [
        { name: 'post', label: 'Post', required: true, placeholder: 'e.g. Parking lot', list: knownPosts() },
        { name: 'requires_ccw', label: 'CCW-qualified team member required', type: 'checkbox' },
        { name: 'roster_id', label: 'Assigned to', type: 'select', options: [['', 'Open — needs a volunteer'], ...people.map((r) => [r.id, r.name + (ccwOkOn(r, e.starts_at) ? ' · CCW' : '')])] },
        { name: 'start', label: 'Start (optional)', type: 'time', hint: `Leave both times blank to use the event time (${timeRange(new Date(e.starts_at), new Date(e.ends_at))}).` },
        { name: 'end', label: 'End (optional)', type: 'time' },
        { name: 'note', label: 'Note', placeholder: 'e.g. Bring radio, meet at east door' },
        ...(isNew ? [] : [{ name: 'cover_requested', label: 'Needs cover', type: 'checkbox' }]),
        { name: 'sort_order', label: 'Sort order', type: 'number', inputmode: 'numeric' }
      ],
      onSubmit: async (v) => {
        if (!!v.start !== !!v.end) throw new Error('Enter both a start and end time, or leave both blank.');
        if (v.requires_ccw && v.roster_id) {
          const r = state.data.roster.find((x) => x.id === v.roster_id);
          if (!ccwOkOn(r, e.starts_at) && !confirm(`${r.name} isn't CCW-qualified on this date (missing or expired). Assign anyway?`)) throw new Error('Pick a CCW-qualified person or leave the post open.');
        }
        const day = ymd(new Date(e.starts_at));
        const row = {
          post: v.post, requires_ccw: v.requires_ccw, roster_id: v.roster_id || null, note: v.note, sort_order: v.sort_order,
          starts_at: v.start ? localIso(day, v.start) : null,
          ends_at: v.start ? endIso(day, v.start, v.end) : null
        };
        if (!isNew) row.cover_requested = v.cover_requested;
        if (isNew) row.event_id = e.id;
        await saveRow('shifts', s.id, row);
        await afterSaveSchedule('Post saved');
      },
      onDelete: isNew ? null : async () => { await deleteRow('shifts', s.id); await afterSaveSchedule('Post removed'); },
      deleteConfirm: e.series_id ? 'Remove this post from this date only?' : undefined
    });
  }

  async function afterSaveSchedule(msg, endsAt) {
    await Promise.all(['events', 'shifts', 'event_series', 'series_posts'].map(refreshTable));
    render();
    if (endsAt && new Date(endsAt).getTime() < Date.now() && state.sched.filter !== 'past' && state.sched.view !== 'month') {
      toast(`${msg || 'Saved'} — it has already ended, so it's under Past`, 6000);
    } else if (msg) toast(msg);
  }

  // ------------------------------------------------------------------
  // Calendar subscription links
  // ------------------------------------------------------------------
  const feedUrl = (f) => `${location.origin}/cal/${f.token}.ics`;
  const webcalUrl = (f) => feedUrl(f).replace(/^https?:/, 'webcal:');

  function openFeeds() {
    const me = myRoster();
    const feeds = state.data.calendar_feeds;
    const body = [
      h('p', { class: 'small' }, 'Subscribe once and your security posts appear in your phone\'s calendar. When you volunteer, swap or cover, it updates on its own.'),
      h('p', { class: 'muted small' }, 'Calendar apps check for changes on their own schedule: iPhone every 15 minutes to an hour (Settings → Calendar → Accounts → Fetch), Google every few hours.')
    ];
    if (!feeds.length) body.push(h('div', { class: 'card muted small' }, 'You have no calendar links yet.'));
    for (const f of feeds) {
      const who = f.roster_id ? rosterName(f.roster_id) : 'Whole team';
      const input = h('input', { class: 'input small-input', readonly: true, value: feedUrl(f), 'aria-label': 'Calendar link' });
      body.push(h('div', { class: 'card feed' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', {}, f.name), h('div', { class: 'muted small' }, 'Shows: ' + who))),
        h('div', { class: 'actions' },
          h('a', { class: 'btn small primary', href: webcalUrl(f) }, 'iPhone / Mac'),
          h('a', { class: 'btn small', href: 'https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(webcalUrl(f)), target: '_blank', rel: 'noopener' }, 'Google'),
          h('a', { class: 'btn small', href: 'https://outlook.live.com/calendar/0/addfromweb?url=' + encodeURIComponent(feedUrl(f)) + '&name=' + encodeURIComponent(f.name), target: '_blank', rel: 'noopener' }, 'Outlook')),
        input,
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn small', onclick: async () => {
              try { await navigator.clipboard.writeText(feedUrl(f)); toast('Link copied'); } catch { input.select(); toast('Select and copy the link'); }
            }
          }, 'Copy link'),
          h('button', {
            class: 'btn small danger', onclick: async () => {
              if (!confirm(`Turn off "${f.name}"? Calendars subscribed to it will stop updating.`)) return;
              const { error } = await sb.from('calendar_feeds').delete().eq('id', f.id);
              if (error) { toast(friendlyError(error)); return; }
              await refreshTable('calendar_feeds'); dlg.close(); openFeeds();
            }
          }, 'Turn off'))));
    }
    body.push(h('p', { class: 'muted small' }, 'Family calendar: open the link on the family calendar\'s account, or send it to family members to subscribe. Anyone with the link can see those assignments, so share it only with people you trust. "Turn off" stops a link at any time.'));
    const dlg = openDialog({
      title: 'Calendar subscriptions',
      body,
      buttons: (close) => [
        h('button', { class: 'btn', onclick: close }, 'Close'),
        h('button', { class: 'btn primary', onclick: () => { close(); newFeed(me); } }, '+ New calendar link')
      ]
    });
  }

  function newFeed(me) {
    const people = state.data.roster.filter((r) => r.active);
    openForm({
      title: 'New calendar link',
      values: { roster_id: me ? me.id : '', name: me ? 'Security – My assignments' : 'Security – Team schedule' },
      fields: [
        { name: 'roster_id', label: 'Whose posts?', type: 'select', options: [...(me ? [[me.id, `Mine (${me.name})`]] : []), ...people.filter((r) => !me || r.id !== me.id).map((r) => [r.id, r.name]), ['', 'Whole team (every post)']] },
        { name: 'name', label: 'Calendar name', required: true, hint: 'This is what the calendar is called in your calendar app.' }
      ],
      submitLabel: 'Create link',
      onSubmit: async (v) => {
        const { error } = await sb.from('calendar_feeds').insert({ name: v.name, roster_id: v.roster_id || null });
        if (error) throw error;
        await refreshTable('calendar_feeds');
        setTimeout(openFeeds, 0);
      }
    });
  }

  // ------------------------------------------------------------------
  // More / account / users
  // ------------------------------------------------------------------
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function moreView() {
    const p = state.profile;
    const content = [
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, h('strong', {}, p.full_name)),
            h('div', { class: 'muted small' }, p.email),
            h('span', { class: 'badge' + (isAdmin() ? ' bolo' : '') }, ROLE_LABELS[p.role])),
          h('button', { class: 'btn small', onclick: editMyName }, 'Edit name')))
    ];

    if (isAdmin()) {
      const n = pendingCount();
      content.push(h('div', { class: 'list' },
        h('a', { class: 'list-item', href: '#/users' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Manage users'),
            h('div', { class: 'sub' }, n ? `${n} waiting for approval` : 'Approve sign-ups and manage access')),
          n ? h('span', { class: 'badge urgent' }, n) : null,
          icon('chev'))));
    }

    if (!isStandalone()) {
      content.push(h('div', { class: 'section-title' }, 'Install on your phone'));
      content.push(h('div', { class: 'card' },
        state.installPrompt
          ? h('button', { class: 'btn primary block', onclick: async () => { const pr = state.installPrompt; state.installPrompt = null; pr.prompt(); await pr.userChoice; render(); } }, 'Install app')
          : isIOS()
            ? h('p', { class: 'body-text' }, 'In Safari, tap the Share button, then "Add to Home Screen".')
            : h('p', { class: 'body-text' }, 'Open your browser menu (⋮) and choose "Install app" or "Add to Home screen".')));
    }

    content.push(h('div', { class: 'section-title' }, 'App'));
    content.push(h('div', { class: 'list' },
      h('button', { class: 'list-item', onclick: changeMyPassword }, h('div', { class: 'grow title' }, 'Change password')),
      h('button', { class: 'list-item', onclick: () => refreshAll(true) }, h('div', { class: 'grow title' }, 'Refresh data')),
      h('button', { class: 'list-item', onclick: () => { if (confirm('Sign out of Koinos Security on this device?')) signOut(); } }, h('div', { class: 'grow title' }, 'Sign out'))));
    content.push(h('p', { class: 'muted small center' }, `Koinos Security v${cfg.appVersion}`));
    return { title: 'More', content };
  }

  function changeMyPassword() {
    openForm({
      title: 'Change password',
      fields: [
        { name: 'pw', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD} characters.` },
        { name: 'pw2', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' }
      ],
      onSubmit: async (v) => {
        if (v.pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
        if (v.pw !== v.pw2) throw new Error("Passwords don't match.");
        const { error } = await sb.auth.updateUser({ password: v.pw });
        if (error) throw error;
        toast('Password changed');
      }
    });
  }

  function editMyName() {
    openForm({
      title: 'Your name',
      values: { full_name: state.profile.full_name },
      fields: [{ name: 'full_name', label: 'Name', required: true, autocomplete: 'name' }],
      onSubmit: async (v) => {
        const { error } = await sb.rpc('update_my_name', { new_name: v.full_name });
        if (error) throw error;
        state.profile.full_name = v.full_name;
        cacheSet('profile', state.profile);
        await afterSave('profiles', 'Name updated');
      }
    });
  }

  function usersView() {
    const me = state.profile.id;
    const groups = [
      ['pending', 'Waiting for approval'],
      ['member', 'Members'],
      ['admin', 'Admins'],
      ['superuser', 'Superusers']
    ];
    const content = [h('p', { class: 'muted small' },
      isSuper()
        ? 'As a superuser you can approve members and grant or remove admin access.'
        : 'As an admin you can approve new sign-ups and remove member access. Only a superuser can grant admin.')];

    for (const [r, label] of groups) {
      const people = state.data.profiles.filter((p) => p.role === r);
      if (!people.length && r !== 'pending') continue;
      content.push(h('div', { class: 'section-title' }, `${label} (${people.length})`));
      if (!people.length) { content.push(h('div', { class: 'card muted small' }, 'Nobody waiting.')); continue; }
      content.push(h('div', { class: 'list' }, people.map((p) => {
        const actions = [];
        if (p.id !== me && p.role !== 'superuser') {
          if (p.role === 'pending') actions.push(roleBtn(p, 'member', 'Approve', 'primary'));
          if (p.role === 'member') {
            if (isSuper()) actions.push(roleBtn(p, 'admin', 'Make admin'));
            actions.push(roleBtn(p, 'pending', 'Remove access', 'danger', `Remove ${p.full_name || p.email}'s access? They will no longer see any team information.`));
          }
          if (p.role === 'admin' && isSuper()) actions.push(roleBtn(p, 'member', 'Remove admin', 'danger', `Remove admin from ${p.full_name || p.email}? They will stay a member.`));
        }
        return h('div', { class: 'user-row' },
          h('div', { class: 'who' },
            h('div', { class: 'title' }, h('strong', {}, p.full_name || '(no name yet)'), p.id === me ? ' (you)' : ''),
            h('div', { class: 'muted small' }, p.email),
            h('div', { class: 'muted small' }, 'Joined ' + relTime(p.created_at))),
          actions);
      })));
    }
    return { title: 'Manage users', back: '#/more', content };
  }

  function roleBtn(p, newRole, label, kind, confirmText) {
    return h('button', {
      class: 'btn small' + (kind ? ' ' + kind : ''),
      onclick: async (e) => {
        if (confirmText && !confirm(confirmText)) return;
        e.currentTarget.disabled = true;
        const { error } = await sb.rpc('set_user_role', { target: p.id, new_role: newRole });
        if (error) { toast(friendlyError(error)); e.currentTarget.disabled = false; return; }
        await afterSave('profiles', `${p.full_name || p.email}: ${ROLE_LABELS[newRole]}`);
      }
    }, label);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render() {
    const app = document.getElementById('app');
    let view;
    if (state.booting) return;
    if (!state.session) view = signInView();
    else if (state.profileError) view = errorView();
    else if (!state.profile) view = h('div', { class: 'splash' }, h('div', { class: 'spinner' }));
    else if (!state.profile.full_name) view = nameView();
    else if (!isMember()) view = pendingView();
    else view = mainView();
    app.replaceChildren(view);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function onSignedIn(session) {
    state.session = session;
    state.profile = null;
    state.profileError = null;
    render();
    await loadProfile();
    await enterApp();
  }

  async function boot() {
    state.lastSeenAlerts = Number(cacheGet('lastSeenAlerts')) || 0;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
    window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
    window.addEventListener('online', () => { render(); if (isMember()) refreshAll(); });
    window.addEventListener('offline', render);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isMember()) refreshAll();
    });

    const { data } = await sb.auth.getSession();
    state.booting = false;

    sb.auth.onAuthStateChange((event, session) => {
      // Defer: calling Supabase inside this callback can deadlock the client.
      setTimeout(() => {
        if (event === 'SIGNED_OUT') {
          if (state.session) signOut();
        } else if (session && (!state.session || state.session.user.id !== session.user.id)) {
          onSignedIn(session);
        } else if (session) {
          state.session = session;
        }
      }, 0);
    });

    if (data && data.session) await onSignedIn(data.session);
    else render();
  }

  boot();
})();
