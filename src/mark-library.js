const types = { highlight: '高亮', underline: '划线', note: '批注', bookmark: '书签', area: '区域' };
const colors = { yellow: '黄色', mint: '薄荷绿', purple: '紫色', pink: '粉色' };
const panes = ['原文', '译文'];

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function escapeMarkdown(text) {
  return text.replace(/[&<>]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[match])
    .replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&');
}

function markLabel(entry) {
  return `${panes[entry.pane]} · ${entry.doc.name} · 第 ${entry.mark.page} 页 · ${types[entry.mark.type]}`;
}

function exportMarkdown(entries) {
  const byId = new Map(entries.map(entry => [entry.mark.id, entry]));
  const exported = new Set();
  const sections = ['# 对读标注'];
  function describe(entry, heading) {
    const { mark } = entry;
    const lines = [`${heading} ${escapeMarkdown(markLabel(entry))}`];
    if (mark.text) lines.push(escapeMarkdown(mark.text).split(/\r?\n/).map(line => `> ${line}`).join('\n'));
    if (mark.note) lines.push(escapeMarkdown(mark.note).split(/\r?\n/).map((line, i) => i === 0 ? `**备注：** ${line}` : line).join('  \n'));
    exported.add(mark.id);
    return lines.join('\n\n');
  }
  let pair = 0;
  for (const entry of entries) {
    if (exported.has(entry.mark.id)) continue;
    const partner = byId.get(entry.mark.linkedId);
    if (partner && !exported.has(partner.mark.id)) {
      sections.push(`## 原译关联 ${++pair}`);
      for (const member of [entry, partner].sort((a, b) => a.pane - b.pane)) sections.push(describe(member, '###'));
    } else {
      sections.push(describe(entry, '##'));
    }
  }
  download(new Blob([sections.join('\n\n') + '\n'], { type: 'text/markdown;charset=utf-8' }), '对读标注.md');
}

function selectOptions(select, options, value) {
  select.replaceChildren(...options.map(([label, key]) => new Option(label, key)));
  if (options.some(([, key]) => key === value)) select.value = value;
}

export function setupMarkLibrary(sidebar, notify) {
  const panel = sidebar.querySelector('#marks-panel');
  panel.innerHTML = `<div class="mark-filters">
    <select id="mark-doc-filter" aria-label="筛选标注文档"><option value="">全部文档</option></select>
    <select id="mark-color-filter" aria-label="筛选标注颜色"><option value="">全部颜色</option></select>
    <select id="mark-type-filter" aria-label="筛选标注类型"><option value="">全部类型</option></select>
    </div><div id="mark-export-actions"><button id="mark-export-md" class="quiet" type="button">导出 Markdown</button>
    <button id="mark-export-pdf" class="quiet" type="button">导出标注 PDF</button></div>
    <label id="mark-pdf-target-label" hidden>PDF 副本<select id="mark-pdf-target" aria-label="选择导出的 PDF"></select></label>
    <div id="mark-library-list"></div>`;
  const $ = selector => panel.querySelector(selector);
  const docFilter = $('#mark-doc-filter');
  const colorFilter = $('#mark-color-filter');
  const typeFilter = $('#mark-type-filter');
  const pdfTarget = $('#mark-pdf-target');
  const markdownButton = $('#mark-export-md');
  const pdfButton = $('#mark-export-pdf');
  const list = $('#mark-library-list');
  let entries = [];
  let exportBusy = false;
  selectOptions(colorFilter, [['全部颜色', ''], ...Object.entries(colors).map(([key, label]) => [label, key])], '');
  selectOptions(typeFilter, [['全部类型', ''], ...Object.entries(types).map(([key, label]) => [label, key])], '');

  function dispatch(name, { mark, pane }) {
    window.dispatchEvent(new CustomEvent(name, { detail: { id: mark.id, pane } }));
  }

  function render() {
    const state = window.readerMarkState || { docs: [], marks: [] };
    const open = state.docs.flatMap((doc, pane) => doc ? [{ doc, pane }] : []);
    const labelFor = ({ doc, pane }) => `${panes[pane]} · ${doc.name}`;
    const docOptions = open.map(item => [labelFor(item), String(item.pane)]);
    selectOptions(docFilter, [['全部文档', ''], ...docOptions], docFilter.value);
    const now = new Map(open.map(item => [item.pane, item]));
    const included = state.marks.filter(mark => open.some(({ doc }) => doc.id === mark.docId));
    const unique = new Map(included.map(mark => [mark.id, mark]));
    const sorted = [...unique.values()].sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
    const fullEntries = sorted.map(mark => {
      const selected = docFilter.value ? now.get(Number(docFilter.value)) : null;
      const location = selected?.doc.id === mark.docId ? selected : open.find(({ doc }) => doc.id === mark.docId);
      return { ...location, mark };
    });
    entries = fullEntries.slice().sort((a, b) => a.pane - b.pane || a.mark.page - b.mark.page);
    const exportable = open.filter(({ doc }) => included.some(mark => mark.docId === doc.id));
    selectOptions(pdfTarget, exportable.map(item => [labelFor(item), String(item.pane)]),
      docFilter.value || pdfTarget.value);
    $('#mark-pdf-target-label').hidden = exportable.length < 2;
    markdownButton.disabled = !entries.length;
    pdfButton.disabled = !exportable.length || exportBusy;
    const visible = entries.filter(({ pane, mark }) =>
      (!docFilter.value || pane === Number(docFilter.value)) &&
      (!colorFilter.value || mark.color === colorFilter.value) &&
      (!typeFilter.value || mark.type === typeFilter.value));
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.focusMark : null;
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'library-hint';
      empty.textContent = entries.length ? '没有符合筛选条件的标注。' : '打开 PDF 后添加标注，标注会显示在这里。';
      list.append(empty);
      return;
    }
    for (const entry of visible) {
      const { mark, doc, pane } = entry;
      const row = document.createElement('article');
      row.className = 'mark-library-card';
      row.dataset.color = mark.color;
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'mark-library-jump';
      jump.dataset.focusMark = `jump-${mark.id}`;
      jump.onclick = () => dispatch('reader-mark-jump', entry);
      const where = document.createElement('span');
      where.className = 'mark-library-location';
      where.textContent = `${panes[pane]} · 第 ${mark.page} 页 · ${types[mark.type]}${mark.linkedId ? ' · 已关联' : ''}`;
      where.title = markLabel(entry);
      const title = document.createElement('span');
      title.className = 'mark-library-file';
      title.textContent = doc.name;
      title.title = doc.name;
      jump.append(where, title);
      if (mark.text) {
        const text = document.createElement('span');
        text.className = 'mark-library-excerpt';
        text.textContent = mark.text;
        text.title = mark.text;
        jump.append(text);
      }
      if (mark.note) {
        const note = document.createElement('span');
        note.className = 'mark-library-note';
        note.textContent = mark.note;
        note.title = mark.note;
        jump.append(note);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'quiet mark-library-edit';
      edit.textContent = '编辑';
      edit.dataset.focusMark = `edit-${mark.id}`;
      edit.setAttribute('aria-label', `编辑${panes[pane]}第 ${mark.page} 页标注`);
      edit.onclick = () => dispatch('reader-mark-edit', entry);
      row.append(jump, edit);
      list.append(row);
    }
    if (focused) [...list.querySelectorAll('[data-focus-mark]')]
      .find(button => button.dataset.focusMark === focused)?.focus({ preventScroll: true });
  }
  for (const filter of [docFilter, colorFilter, typeFilter]) filter.onchange = render;
  markdownButton.onclick = () => exportMarkdown(entries);
  pdfButton.onclick = async () => {
    const doc = window.readerMarkState?.docs[Number(pdfTarget.value)];
    if (!doc || !pdfTarget.value || exportBusy) return;
    const marks = entries.filter(entry => entry.mark.docId === doc.id).map(({ mark }) => mark);
    exportBusy = true;
    pdfButton.disabled = true;
    try {
      const { annotatedPdf } = await import('./pdf-mark-export.js');
      const blob = await annotatedPdf(doc, marks);
      download(blob, `${doc.name.replace(/\.pdf$/i, '')} - 标注.pdf`);
    } catch (error) {
      notify(error.message || '导出 PDF 失败');
    } finally {
      exportBusy = false;
      render();
    }
  };
  window.addEventListener('reader-marks-change', () => {
    if (!panel.hidden) render();
  });
  return render;
}

