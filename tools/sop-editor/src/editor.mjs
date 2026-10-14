// Koinos Security: the admin SOP editor (built into public/vendor/sop-editor.js).
// A Word-like editor: headings, bold/italic/underline/highlight, bulleted and
// numbered lists (Tab / Shift-Tab to indent), tables, links, undo/redo, and
// pasting from Word or Google Docs with lists and tables kept, pictures
// (maps, annotated screenshots) and links to other SOPs.
//
//   const ed = KoinosEditor.create(container, { html, placeholder, uploadImage, imageUrl, pickSop });
//   ed.getHTML(); ed.isEmpty(); ed.isBusy(); ed.focus(); ed.destroy();
//
// Pictures are saved as <img data-photo="sops/<file>"> with no web address:
// the file lives in the app's private photo storage and the app looks up a
// fresh address (or its offline copy) whenever it shows the SOP.
//   uploadImage(file) → Promise<path>   stores a picture, returns its path
//   imageUrl(path)    → url | Promise<url>   something to show it with
//   pickSop({ current }) → Promise<{ id, title } | { remove: true } | null>
// Links to other SOPs are ordinary links to "#/sops/<id>".
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';

// ---------------------------------------------------------------------
// Word pastes lists as paragraphs with "mso-list" styles and the number
// typed in a hidden span. Turn those back into real (nested) lists.
// ---------------------------------------------------------------------
// Style attributes are renamed before the HTML is read, so the site's
// "no inline styles" security rule never has anything to refuse.
export const neutralizeStyles = (html) => String(html || '').replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' data-st=$1');

export function fixWordLists(html) {
  html = neutralizeStyles(html);
  if (!/mso-list|MsoListParagraph/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const isListPara = (el) => el && el.tagName === 'P' && (/mso-list\s*:\s*l\d+/i.test(el.getAttribute('data-st') || '') || /MsoListParagraph/i.test(el.className || ''));
  const levelOf = (el) => { const m = /level(\d+)/i.exec(el.getAttribute('data-st') || ''); return m ? Number(m[1]) : 1; };
  const markerOf = (el) => {
    // The bullet/number lives in a span styled mso-list:Ignore (inside <!--[if !supportLists]-->).
    const ign = [...el.querySelectorAll('span')].find((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute('data-st') || ''));
    let text = '';
    if (ign) { text = ign.textContent; ign.remove(); }
    // Drop Word's conditional comments.
    for (const n of [...el.childNodes]) if (n.nodeType === 8) n.remove();
    return text.replace(/ /g, ' ').trim();
  };
  const isOrdered = (marker) => /^\(?[0-9]{1,3}[.)]|^\(?[a-zA-Z]{1,2}[.)]|^\(?[ivxlcdmIVXLCDM]{1,5}[.)]/.test(marker);
  const roots = new Set([...doc.querySelectorAll('p')].filter(isListPara).map((p) => p.parentNode));
  for (const parent of roots) {
    let stack = [];   // { list, level }
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3 && !node.textContent.trim()) continue;
      if (!(node.nodeType === 1 && isListPara(node))) { stack = []; continue; }
      const level = levelOf(node);
      const ordered = isOrdered(markerOf(node));
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      let top = stack[stack.length - 1];
      if (top && top.level === level && (top.list.tagName === 'OL') !== ordered) { stack.pop(); top = stack[stack.length - 1]; }
      if (!top || top.level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        if (top && top.list.lastElementChild) top.list.lastElementChild.append(list);
        else node.before(list);
        top = { list, level };
        stack.push(top);
      }
      const li = doc.createElement('li');
      const p = doc.createElement('p');
      while (node.firstChild) p.append(node.firstChild);
      li.append(p);
      top.list.append(li);
      node.remove();
    }
  }
  return doc.body.innerHTML;
}

export const SOP_HREF = /^#\/sops\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const PHOTO_PATH = /^sops\/[A-Za-z0-9-]{1,64}\.(jpg|png|webp)$/;
const safeUrl = (u) => /^(https?:\/\/|mailto:|tel:)/i.test(String(u || '').trim()) || SOP_HREF.test(String(u || '').trim());

// A picture on its own line. Click it to select it (then Delete removes it,
// or drag it somewhere else).
const SopImage = Node.create({
  name: 'sopImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() { return { imageUrl: () => null }; },
  addAttributes() {
    return {
      photo: { default: null, parseHTML: (e) => e.getAttribute('data-photo'), renderHTML: (a) => ({ 'data-photo': a.photo }) },
      alt: { default: '', parseHTML: (e) => e.getAttribute('alt') || '', renderHTML: (a) => (a.alt ? { alt: a.alt } : {}) }
    };
  },
  parseHTML() {
    return [{ tag: 'img[data-photo]', getAttrs: (e) => (PHOTO_PATH.test(e.getAttribute('data-photo') || '') ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) { return ['img', HTMLAttributes]; },
  addNodeView() {
    const imageUrl = this.options.imageUrl;
    return ({ node }) => {
      const dom = el('div', { class: 'sop-ed-img', contenteditable: 'false' });
      const show = (n) => {
        dom.replaceChildren();
        const note = el('div', { class: 'sop-ed-img-note' }, 'Loading picture…');
        dom.append(note);
        Promise.resolve(imageUrl(n.attrs.photo)).then((url) => {
          if (!url) { note.textContent = 'Picture not available right now (it is still saved).'; return; }
          const img = el('img', { src: url, alt: n.attrs.alt || '', draggable: 'false' });
          img.addEventListener('load', () => note.remove());
          img.addEventListener('error', () => { note.textContent = 'Picture not available right now (it is still saved).'; img.remove(); });
          dom.append(img);
        }, () => { note.textContent = 'Picture not available right now (it is still saved).'; });
      };
      show(node);
      let cur = node;
      return {
        dom,
        update: (n) => {
          if (n.type !== cur.type) return false;
          if (n.attrs.photo !== cur.attrs.photo) show(n);
          cur = n;
          return true;
        }
      };
    };
  }
});

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

const isImage = (f) => f && /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(f.type || '');

export function create(container, { html = '', placeholder = '', uploadImage = null, imageUrl = null, pickSop = null } = {}) {
  const surface = el('div', { class: 'sop-ed-surface' });
  const bar = el('div', { class: 'sop-ed-bar', role: 'toolbar', 'aria-label': 'Formatting' });
  const tableBar = el('div', { class: 'sop-ed-bar table-bar hidden', role: 'toolbar', 'aria-label': 'Table' });
  container.append(bar, tableBar, surface);

  const editor = new Editor({
    element: surface,
    injectCSS: false,   // the app's stylesheet has the editor styles (no inline styles allowed)
    content: html,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['mailto', 'tel'], isAllowedUri: (url) => safeUrl(url), HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } }
      }),
      Highlight,
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder }),
      SopImage.configure({ imageUrl: imageUrl || (() => null) })
    ],
    editorProps: {
      attributes: { class: 'sop-ed rt rt-doc', 'aria-label': 'Procedure', 'aria-multiline': 'true' },
      transformPastedHTML: fixWordLists,
      // A screenshot on the clipboard (e.g. Mac: Control+Shift+Command+4) pastes as a picture.
      // (Pastes from Word/Docs that also carry a picture of the text are left as text.)
      handlePaste: (view, event) => {
        const cd = event.clipboardData;
        if (!uploadImage || !cd) return false;
        const files = [...(cd.files || [])].filter(isImage);
        if (!files.length || cd.getData('text/html') || cd.getData('text/plain')) return false;
        event.preventDefault();
        addPictures(files, null);
        return true;
      },
      handleDrop: (view, event, slice, moved) => {
        if (moved || !uploadImage || !event.dataTransfer) return false;
        const files = [...(event.dataTransfer.files || [])].filter(isImage);
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        addPictures(files, at ? at.pos : null);
        return true;
      }
    }
  });

  // Pictures: upload, then put each one in at the cursor (or where it was dropped).
  let busy = 0;
  const picBtnLabel = 'Picture';
  async function addPictures(files, pos) {
    busy++;
    refresh();
    try {
      for (const f of files) {
        let path;
        try { path = await uploadImage(f); } catch { continue; }   // the app shows the reason
        if (!path || editor.isDestroyed) continue;
        const node = { type: 'sopImage', attrs: { photo: path, alt: '' } };
        if (pos != null) {
          const at = Math.min(pos, editor.state.doc.content.size);
          editor.chain().focus().insertContentAt(at, node).run();
          pos = null;
        } else {
          editor.chain().focus().insertContent(node).run();
        }
      }
    } finally {
      busy--;
      if (!editor.isDestroyed) refresh();
    }
  }
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])].filter((f) => isImage(f) || /^image\//.test(f.type || ''));
    fileInput.value = '';
    if (files.length) addPictures(files, null);
  });
  container.append(fileInput);

  // Links to other SOPs: pick one from the list. With text selected, that
  // text becomes the link; otherwise the SOP's title is put in as the link.
  async function linkSop() {
    const curHref = editor.getAttributes('link').href || '';
    const m = SOP_HREF.exec(curHref);
    const { from, to, empty } = editor.state.selection;
    const pick = await pickSop({ current: m ? m[1] : null });
    if (!pick || editor.isDestroyed) return;
    const c = editor.chain().focus().setTextSelection({ from, to });
    if (pick.remove) { c.extendMarkRange('link').unsetLink().run(); return; }
    const href = '#/sops/' + pick.id;
    if (m) c.extendMarkRange('link').setLink({ href }).run();
    else if (empty) c.insertContent([{ type: 'text', text: pick.title, marks: [{ type: 'link', attrs: { href } }] }, { type: 'text', text: ' ' }]).run();
    else c.setLink({ href }).run();
  }

  const buttons = [];
  const btn = (label, title, run, isOn, can) => {
    const b = el('button', { type: 'button', class: 'sop-ed-btn', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: () => { run(); refresh(); } }, label);
    buttons.push({ b, isOn, can });
    return b;
  };
  const chain = () => editor.chain().focus();
  const sep = () => el('span', { class: 'sop-ed-sep', 'aria-hidden': 'true' });

  const style = el('select', { class: 'sop-ed-style', 'aria-label': 'Text style', onchange: () => {
    const v = style.value;
    if (v === 'p') chain().setParagraph().run();
    else chain().toggleHeading({ level: Number(v) }).run();
    refresh();
  } },
  el('option', { value: 'p' }, 'Normal text'), el('option', { value: '2' }, 'Heading'), el('option', { value: '3' }, 'Subheading'));

  const promptLink = () => {
    const cur = editor.getAttributes('link').href || '';
    const url = window.prompt('Link address (https://…, mailto:… or tel:…). Leave empty to remove the link.', cur);
    if (url === null) return;
    if (!url.trim()) { chain().extendMarkRange('link').unsetLink().run(); return; }
    const href = /^[a-z]+:/i.test(url.trim()) ? url.trim() : 'https://' + url.trim();
    if (!safeUrl(href)) { window.alert('Links must start with https://, mailto: or tel:'); return; }
    if (editor.state.selection.empty && !editor.isActive('link')) chain().insertContent({ type: 'text', text: url.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    else chain().extendMarkRange('link').setLink({ href }).run();
  };

  bar.append(...[
    style, sep(),
    btn(el('b', {}, 'B'), 'Bold (Ctrl/⌘+B)', () => chain().toggleBold().run(), () => editor.isActive('bold')),
    btn(el('i', {}, 'I'), 'Italic (Ctrl/⌘+I)', () => chain().toggleItalic().run(), () => editor.isActive('italic')),
    btn(el('u', {}, 'U'), 'Underline (Ctrl/⌘+U)', () => chain().toggleUnderline().run(), () => editor.isActive('underline')),
    btn(el('mark', {}, 'Highlight'), 'Highlight', () => chain().toggleHighlight().run(), () => editor.isActive('highlight')),
    sep(),
    btn('• List', 'Bulleted list', () => chain().toggleBulletList().run(), () => editor.isActive('bulletList')),
    btn('1. List', 'Numbered list', () => chain().toggleOrderedList().run(), () => editor.isActive('orderedList')),
    btn('⇥', 'Indent (Tab)', () => chain().sinkListItem('listItem').run(), null, () => editor.can().sinkListItem('listItem')),
    btn('⇤', 'Outdent (Shift+Tab)', () => chain().liftListItem('listItem').run(), null, () => editor.can().liftListItem('listItem')),
    sep(),
    btn('Table', 'Insert a table', () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), null, () => !editor.isActive('table')),
    btn('Link', 'Add or change a web link', promptLink, () => editor.isActive('link') && !SOP_HREF.test(editor.getAttributes('link').href || '')),
    pickSop ? btn('SOP link', 'Link to another SOP', linkSop, () => SOP_HREF.test(editor.getAttributes('link').href || '')) : null,
    uploadImage ? btn(picBtnLabel, 'Add a picture or map (you can also paste or drag one in)', () => fileInput.click(), null, () => !busy) : null,
    btn('―', 'Divider line', () => chain().setHorizontalRule().run()),
    btn('Quote', 'Note / quote block', () => chain().toggleBlockquote().run(), () => editor.isActive('blockquote')),
    sep(),
    btn('↶', 'Undo (Ctrl/⌘+Z)', () => chain().undo().run(), null, () => editor.can().undo()),
    btn('↷', 'Redo (Ctrl/⌘+Shift+Z)', () => chain().redo().run(), null, () => editor.can().redo())
  ].filter(Boolean));
  tableBar.append(
    el('span', { class: 'sop-ed-label' }, 'Table:'),
    btn('+ Row', 'Add a row below', () => chain().addRowAfter().run()),
    btn('+ Column', 'Add a column to the right', () => chain().addColumnAfter().run()),
    btn('− Row', 'Delete this row', () => chain().deleteRow().run()),
    btn('− Column', 'Delete this column', () => chain().deleteColumn().run()),
    btn('Header row', 'Turn the header row on or off', () => chain().toggleHeaderRow().run()),
    btn('Delete table', 'Delete the whole table', () => chain().deleteTable().run())
  );

  function refresh() {
    for (const { b, isOn, can } of buttons) {
      if (isOn) { const on = !!isOn(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
      if (can) b.disabled = !can();
    }
    for (const { b } of buttons) if (b.textContent === picBtnLabel || b.textContent === 'Uploading…') b.textContent = busy ? 'Uploading…' : picBtnLabel;
    style.value = editor.isActive('heading', { level: 2 }) ? '2' : editor.isActive('heading', { level: 3 }) ? '3' : 'p';
    tableBar.classList.toggle('hidden', !editor.isActive('table'));
  }
  editor.on('selectionUpdate', refresh);
  editor.on('transaction', refresh);
  refresh();

  return {
    editor,
    // Saved without the table sizing styles the editor adds while editing.
    getHTML: () => editor.getHTML().replace(/<colgroup>[\s\S]*?<\/colgroup>/g, '').replace(/\sstyle="[^"]*"/g, ''),
    isEmpty: () => editor.isEmpty,
    isBusy: () => busy > 0,
    focus: () => editor.commands.focus('end'),
    destroy: () => editor.destroy()
  };
}
