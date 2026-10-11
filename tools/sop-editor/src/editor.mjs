// Koinos Security: the admin SOP editor (built into public/vendor/sop-editor.js).
// A Word-like editor: headings, bold/italic/underline/highlight, bulleted and
// numbered lists (Tab / Shift-Tab to indent), tables, links, undo/redo, and
// pasting from Word or Google Docs with lists and tables kept.
//
//   const ed = KoinosEditor.create(container, { html, placeholder });
//   ed.getHTML(); ed.isEmpty(); ed.focus(); ed.destroy();
import { Editor } from '@tiptap/core';
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

const safeUrl = (u) => /^(https?:\/\/|mailto:|tel:)/i.test(String(u || '').trim());

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

export function create(container, { html = '', placeholder = '' } = {}) {
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
      Placeholder.configure({ placeholder })
    ],
    editorProps: {
      attributes: { class: 'sop-ed rt rt-doc', 'aria-label': 'Procedure', 'aria-multiline': 'true' },
      transformPastedHTML: fixWordLists
    }
  });

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

  bar.append(
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
    btn('Link', 'Add or change a link', promptLink, () => editor.isActive('link')),
    btn('―', 'Divider line', () => chain().setHorizontalRule().run()),
    btn('Quote', 'Note / quote block', () => chain().toggleBlockquote().run(), () => editor.isActive('blockquote')),
    sep(),
    btn('↶', 'Undo (Ctrl/⌘+Z)', () => chain().undo().run(), null, () => editor.can().undo()),
    btn('↷', 'Redo (Ctrl/⌘+Shift+Z)', () => chain().redo().run(), null, () => editor.can().redo())
  );
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
    focus: () => editor.commands.focus('end'),
    destroy: () => editor.destroy()
  };
}
