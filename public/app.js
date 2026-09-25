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
  const state = {
    session: null,
    profile: null,
    profileError: null,
    booting: true,
    auth: { step: 'email', email: '', busy: false, error: '' },
    data: { bulletins: [], sops: [], contacts: [], roster: [], profiles: [] },
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
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']
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
  const QUERIES = {
    bulletins: (q) => q.order('created_at', { ascending: false }),
    sops: (q) => q.order('category').order('sort_order').order('title'),
    contacts: (q) => q.order('category').order('sort_order').order('name'),
    roster: (q) => q.order('sort_order').order('name'),
    profiles: (q) => q.order('full_name')
  };

  function loadCachedData() {
    for (const t of Object.keys(QUERIES)) {
      const rows = cacheGet('data:' + t);
      if (Array.isArray(rows)) state.data[t] = rows;
    }
  }

  async function refreshTable(t) {
    const { data, error } = await QUERIES[t](sb.from(t).select('*'));
    if (error) return error;
    state.data[t] = data;
    cacheSet('data:' + t, data);
    return null;
  }

  async function refreshAll(showToast) {
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
    state.channel = sb.channel('bulletins-live')
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
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h2', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'dlg-body' }, body),
      buttons && buttons.length ? h('div', { class: 'dlg-foot' }, buttons(close)) : null
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return { close };
  }

  function openForm({ title, fields, values = {}, submitLabel = 'Save', onSubmit, onDelete, deleteLabel = 'Delete', deleteConfirm }) {
    const dlg = h('dialog', {});
    const inputs = {};
    const photo = { file: null, remove: false };
    const body = h('div', { class: 'dlg-body' });

    for (const f of fields) {
      const id = 'f_' + f.name;
      let input;
      if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', id });
        input.checked = values[f.name] != null ? !!values[f.name] : !!f.default;
        inputs[f.name] = input;
        body.append(h('div', { class: 'field check' }, h('label', { for: id }, input, f.label), f.hint && h('div', { class: 'hint' }, f.hint)));
        continue;
      }
      if (f.type === 'photo') {
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
        body.append(h('div', { class: 'field photo-field' }, h('label', { for: id }, f.label), preview, file,
          h('div', { class: 'actions' }, removeBtn), f.hint && h('div', { class: 'hint' }, f.hint)));
        continue;
      }
      if (f.type === 'textarea') {
        input = h('textarea', { id, rows: f.rows || 8 });
      } else if (f.type === 'select') {
        input = h('select', { id }, f.options.map(([v, l]) => h('option', { value: v }, l)));
      } else {
        input = h('input', { type: f.type || 'text', id, autocomplete: f.autocomplete || 'off', inputmode: f.inputmode, placeholder: f.placeholder, list: f.list ? id + '_list' : null });
      }
      const v = values[f.name];
      input.value = v != null ? v : (f.default != null ? f.default : (f.type === 'select' ? f.options[0][0] : ''));
      inputs[f.name] = input;
      body.append(h('div', { class: 'field' },
        h('label', { for: id }, f.label + (f.required ? ' *' : '')), input,
        f.list ? h('datalist', { id: id + '_list' }, f.list.map((o) => h('option', { value: o }))) : null,
        f.hint && h('div', { class: 'hint' }, f.hint)));
    }

    const err = h('div', { class: 'error-text hidden' });
    body.append(err);
    const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };

    const foot = h('div', { class: 'dlg-foot' },
      onDelete ? h('button', {
        type: 'button', class: 'btn danger', onclick: async (e) => {
          if (!confirm(deleteConfirm || 'Delete this? This cannot be undone.')) return;
          e.currentTarget.disabled = true;
          try { await onDelete(); dlg.close(); } catch (ex) { showErr(friendlyError(ex)); e.currentTarget.disabled = false; }
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
        const out = {};
        for (const f of fields) {
          if (f.type === 'photo') continue;
          const el = inputs[f.name];
          if (f.type === 'checkbox') out[f.name] = el.checked;
          else if (f.type === 'number') out[f.name] = Number(el.value || 0);
          else out[f.name] = el.value.trim();
          if (f.required && !out[f.name]) { showErr(`${f.label} is required.`); el.focus(); return; }
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

  function signInView() {
    const a = state.auth;
    if (a.step === 'email') {
      const input = h('input', { type: 'email', id: 'email', class: 'input', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' });
      input.value = a.email;
      return authCard(h('form', {
        onsubmit: (e) => { e.preventDefault(); a.email = input.value.trim().toLowerCase(); if (validEmail(a.email)) sendCode(); else { a.error = 'Enter a valid email address.'; render(); } }
      },
      h('p', { class: 'lead' }, "Sign in with your email. We'll send you a one-time code."),
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), input),
      h('button', { class: 'btn primary block', type: 'submit', disabled: a.busy }, a.busy ? 'Sending…' : 'Send code'),
      a.error && h('div', { class: 'error-text' }, a.error)));
    }
    const code = h('input', { type: 'text', id: 'code', class: 'input code-input', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '10', placeholder: '••••••' });
    return authCard(h('form', {
      onsubmit: (e) => { e.preventDefault(); const t = code.value.replace(/\D/g, ''); if (t.length >= 6) verifyCode(t); else { a.error = 'Enter the code from the email.'; render(); } }
    },
    h('p', { class: 'lead' }, 'We sent a code to ', h('strong', {}, a.email), '. Enter it below.'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Code'), code),
    h('button', { class: 'btn primary block', type: 'submit', disabled: a.busy }, a.busy ? 'Checking…' : 'Sign in'),
    a.error && h('div', { class: 'error-text' }, a.error),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { a.step = 'email'; a.error = ''; render(); } }, 'Different email'),
      h('button', { type: 'button', class: 'btn small', disabled: a.busy, onclick: sendCode }, 'Resend code')),
    h('p', { class: 'muted small' }, "Don't see it? Check your spam folder. Codes expire after about an hour.")));
  }

  async function sendCode() {
    const a = state.auth;
    a.busy = true; a.error = ''; render();
    const { error } = await sb.auth.signInWithOtp({
      email: a.email,
      options: { shouldCreateUser: true, emailRedirectTo: location.origin + '/' }
    });
    a.busy = false;
    if (error) a.error = friendlyError(error);
    else { a.step = 'code'; toast('Code sent — check your email'); }
    render();
    const c = document.getElementById('code');
    if (c) c.focus();
  }

  async function verifyCode(token) {
    const a = state.auth;
    a.busy = true; a.error = ''; render();
    const { error } = await sb.auth.verifyOtp({ email: a.email, token, type: 'email' });
    a.busy = false;
    if (error) { a.error = friendlyError(error); render(); return; }
    state.auth = { step: 'email', email: '', busy: false, error: '' };
    // onAuthStateChange picks up the new session.
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
    state.data = { bulletins: [], sops: [], contacts: [], roster: [], profiles: [] };
    state.photoUrls = {};
    history.replaceState(null, '', '/');
    render();
  }

  // ------------------------------------------------------------------
  // Routing and main layout
  // ------------------------------------------------------------------
  const TABS = [
    ['alerts', 'Alerts', 'bell'],
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
    const views = { alerts: alertsView, sops: sopsView, contacts: contactsView, team: teamView, more: moreView, users: usersView };
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
        const count = key === 'alerts' ? alertCount : key === 'more' ? moreCount : 0;
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
  // Team roster
  // ------------------------------------------------------------------
  function teamView() {
    const all = state.data.roster.filter((p) => p.active || isAdmin());
    const medical = all.filter((p) => p.is_medical);
    const showing = state.teamFilter === 'medical' ? medical : all;
    const content = [h('div', { class: 'chips' },
      h('button', { class: 'chip' + (state.teamFilter === 'all' ? ' on' : ''), onclick: () => { state.teamFilter = 'all'; render(); } }, `Everyone (${all.length})`),
      h('button', { class: 'chip' + (state.teamFilter === 'medical' ? ' on' : ''), onclick: () => { state.teamFilter = 'medical'; render(); } }, `Medical (${medical.length})`))];
    if (!showing.length) content.push(empty(state.teamFilter === 'medical' ? 'No medical points of contact listed' : 'No team members listed yet', 'users'));
    else content.push(h('div', { class: 'roster-grid' }, showing.map(personCard)));
    return { title: 'Team', action: isAdmin() ? topAction('+ New', () => editPerson()) : null, content };
  }

  function personPhoto(p, cls) {
    const url = p.photo_path && state.photoUrls[p.photo_path];
    return url ? h('img', { class: cls || 'photo', src: url, alt: p.name, loading: 'lazy' }) : h('div', { class: 'initials' }, initials(p.name));
  }

  function personCard(p) {
    return h('button', { class: 'person' + (p.active ? '' : ' inactive'), onclick: () => openPerson(p) },
      personPhoto(p),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, p.name),
        p.position ? h('div', { class: 'pos' }, p.position) : null,
        p.is_medical ? h('span', { class: 'badge medical' }, 'Medical') : null,
        !p.active ? h('span', { class: 'badge muted-badge' }, 'Inactive') : null));
  }

  function openPerson(p) {
    const url = p.photo_path && state.photoUrls[p.photo_path];
    openDialog({
      title: p.name,
      body: [
        url ? h('img', { class: 'profile-photo', src: url, alt: p.name, onclick: () => viewPhoto(url) }) : null,
        p.position ? h('div', { class: 'muted' }, p.position) : null,
        p.is_medical ? h('div', { class: 'card' },
          h('span', { class: 'badge medical' }, 'Medical point of contact'),
          p.medical_notes ? h('div', { class: 'body-text' }, p.medical_notes) : null) : null,
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
    openForm({
      title: isNew ? 'Add team member' : 'Edit team member',
      values: p,
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'position', label: 'Position / post', placeholder: 'e.g. Team lead, Parking lot, Sanctuary' },
        { name: 'phone', label: 'Phone', type: 'tel', inputmode: 'tel' },
        { name: 'email', label: 'Email', type: 'email', inputmode: 'email' },
        { name: 'photo', label: 'Photo', type: 'photo', currentUrl: p.photo_path ? state.photoUrls[p.photo_path] : null },
        { name: 'is_medical', label: 'Medical point of contact', type: 'checkbox' },
        { name: 'medical_notes', label: 'Medical qualifications', placeholder: 'e.g. RN, EMT, CPR/AED certified' },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0, inputmode: 'numeric' },
        { name: 'active', label: 'Active on the team', type: 'checkbox', default: true }
      ],
      onSubmit: async (v, photo) => {
        const ph = await applyPhoto('roster', p.photo_path, photo);
        const row = { ...v, photo_path: ph.path };
        try { await saveRow('roster', p.id, row); } catch (e) { if (ph.path && ph.path !== p.photo_path) removePhoto(ph.path); throw e; }
        removePhoto(ph.oldToRemove);
        await afterSave('roster', isNew ? 'Team member added' : 'Saved');
      },
      onDelete: isNew ? null : async () => {
        await deleteRow('roster', p.id);
        removePhoto(p.photo_path);
        await afterSave('roster', 'Removed from roster');
      },
      deleteConfirm: 'Remove this person from the roster permanently? (Unchecking "Active" hides them instead.)'
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
      h('button', { class: 'list-item', onclick: () => refreshAll(true) }, h('div', { class: 'grow title' }, 'Refresh data')),
      h('button', { class: 'list-item', onclick: () => { if (confirm('Sign out of Koinos Security on this device?')) signOut(); } }, h('div', { class: 'grow title' }, 'Sign out'))));
    content.push(h('p', { class: 'muted small center' }, `Koinos Security v${cfg.appVersion}`));
    return { title: 'More', content };
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
