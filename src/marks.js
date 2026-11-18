import './marks.css';

const colors = { yellow: '黄色', mint: '薄荷绿', purple: '浅紫色', pink: '粉色' };
const types = { highlight: '高亮', underline: '划线', note: '批注', bookmark: '书签', area: '区域标注' };

function relativeRect(rect, bounds) {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: (left - bounds.left) / bounds.width,
    y: (top - bounds.top) / bounds.height,
    w: (right - left) / bounds.width,
    h: (bottom - top) / bounds.height,
  };
}

function unionLine(rects, rect) {
  const prev = rects.at(-1);
  // PDF.js emits separate spans for words, fonts and marked content.
  if (prev && Math.abs(prev.y - rect.y) < Math.min(prev.h, rect.h) * .25 &&
      Math.abs(prev.h - rect.h) < Math.min(prev.h, rect.h) * .3 &&
      prev.x + prev.w + .004 >= rect.x && rect.x + rect.w + .004 >= prev.x) {
    const x = Math.min(prev.x, rect.x);
    prev.w = Math.max(prev.x + prev.w, rect.x + rect.w) - x;
    prev.x = x;
  } else {
    rects.push(rect);
  }
}

function readSelection(selection, pane) {
  const range = selection.getRangeAt(0);
  const entries = [];
  for (const layer of pane.container.querySelectorAll('.textLayer')) {
    if (!range.intersectsNode(layer)) continue;
    const page = layer.closest('.page');
    const bounds = page.getBoundingClientRect();
    const nodes = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const rects = [];
    const fragment = document.createRange();
    let node;
    while ((node = nodes.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      fragment.setStart(node, range.startContainer === node ? range.startOffset : 0);
      fragment.setEnd(node, range.endContainer === node ? range.endOffset : node.length);
      if (fragment.collapsed) continue;
      for (const box of fragment.getClientRects()) {
        const rect = relativeRect(box, bounds);
        if (rect) unionLine(rects, rect);
      }
    }
    if (!rects.length) continue;
    fragment.selectNodeContents(layer);
    if (layer.contains(range.startContainer)) fragment.setStart(range.startContainer, range.startOffset);
    if (layer.contains(range.endContainer)) fragment.setEnd(range.endContainer, range.endOffset);
    const quote = fragment.cloneContents();
    for (const lineBreak of quote.querySelectorAll('br')) lineBreak.replaceWith('\n');
    const text = quote.textContent.trim();
    entries.push({ page: Number(page.dataset.pageNumber), rects, text });
  }
  if (entries.length === 1) entries[0].text = selection.toString().trim();
  return entries;
}

function styleRect(element, rect) {
  const { x, y, w, h } = rect;
  Object.assign(element.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
}

async function marksRequest(body) {
  const response = await fetch('/api/marks', body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : { cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return response.json();
}

export function setupMarks({ panes, notify, jump }) {
  let marks = [], revision = -1, color = 'yellow', selected = null, linkSource = null;
  let ready = false, busy = false, areaPane = null, drag = null;
  let selectionFrame = 0, pointerSelecting = false;
  const undoStack = [];
  const supportsClipboard = navigator.clipboard?.writeText;
  const toolbar = document.createElement('div');
  toolbar.className = 'mark-selection-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '文本标注');
  toolbar.hidden = true;
  toolbar.innerHTML = `
    <button type="button" data-mark-action="highlight">高亮</button>
    <button type="button" data-mark-action="underline">划线</button>
    <button type="button" data-mark-action="note">批注</button>
    <span class="mark-swatches">${Object.entries(colors).map(([id, label]) => `
      <button type="button" class="mark-swatch" data-mark-color="${id}" title="${label}" aria-label="${label}" aria-pressed="${id === color}"></button>`).join('')}</span>
    <button type="button" data-mark-action="copy">复制</button>`;
  // Keep the browser selection alive when pointing at the toolbar.
  toolbar.addEventListener('pointerdown', event => event.preventDefault());
  document.body.append(toolbar);

  const dialog = document.createElement('dialog');
  dialog.className = 'mark-editor';
  dialog.innerHTML = `<form>
    <h2 id="mark-editor-title"></h2>
    <p class="mark-editor-text" hidden></p>
    <label>颜色<select name="markColor">${Object.entries(colors).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
    <label>备注<textarea name="markNote" rows="4" maxlength="10000"></textarea></label>
    <div class="mark-editor-actions">
      <button type="button" data-mark-edit="delete">删除</button>
      <button type="button" data-mark-edit="link">关联另一栏标注</button>
      <button type="button" data-mark-edit="follow">跳到关联标注</button>
      <button type="button" data-mark-edit="unlink">解除关联</button>
      <button type="button" data-mark-edit="cancel">取消</button>
      <button type="submit" class="primary">保存</button>
    </div>
  </form>`;
  dialog.setAttribute('aria-labelledby', 'mark-editor-title');
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  let editing = null;

  const linkBanner = document.createElement('div');
  linkBanner.className = 'mark-link-banner';
  linkBanner.hidden = true;
  linkBanner.innerHTML = '<span>请在另一栏创建或点击一条标注</span><button type="button">取消关联选择</button>';
  linkBanner.querySelector('button').onclick = () => setLinkSource(null);
  document.body.append(linkBanner);

  function setLinkSource(value) {
    linkSource = value;
    linkBanner.hidden = !value;
  }

  const paneDoc = pane => pane.markDoc?.id;
  function publish() {
    window.readerMarkState = { marks, docs: panes.map(pane => pane.markDoc || null) };
    for (const pane of panes) {
      paintPane(pane);
      refreshControls(pane);
    }
    window.dispatchEvent(new CustomEvent('reader-marks-change'));
  }

  function receive(state) {
    if (state.revision < revision) return;
    revision = state.revision;
    marks = state.marks;
  }

  async function change(upsert, remove = [], recordUndo = true) {
    if (!ready || busy) return false;
    const touched = new Set([...upsert.map(mark => mark.id), ...remove]);
    const previous = marks.filter(mark => touched.has(mark.id));
    const added = upsert.filter(mark => !previous.some(before => before.id === mark.id));
    busy = true;
    for (const pane of panes) refreshControls(pane);
    try {
      receive(await marksRequest({ upsert, remove, revision }));
      if (recordUndo) undoStack.push({ upsert: previous, remove: added.map(mark => mark.id) });
      else undoStack.pop();
      return true;
    } catch (error) {
      if (error.status === 409) {
        try {
          receive(await marksRequest());
          undoStack.length = 0;
          setLinkSource(null);
          if (dialog.open) dialog.close();
          notify('其他窗口已更新标注，请重新选择后再操作');
          return false;
        } catch {
          notify('无法刷新本地标注，请重新加载阅读器');
          return false;
        }
      }
      notify('标注保存失败，请重试');
      return false;
    } finally {
      busy = false;
      publish();
    }
  }

  function paintPane(pane) {
    for (const page of pane.container.querySelectorAll('.page:has(.canvasWrapper), .page:has(.mark-layer)')) paintPage(pane, page);
  }

  function paintPage(pane, page) {
    page.querySelector('.mark-layer')?.remove();
    const visible = marks.filter(mark => mark.docId === paneDoc(pane) && mark.page === Number(page.dataset.pageNumber));
    if (!visible.length) return;
    const layer = document.createElement('div');
    layer.className = 'mark-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (const mark of visible) {
      for (const rect of mark.rects) {
        const element = document.createElement('div');
        element.className = 'mark-shape';
        element.dataset.markId = mark.id;
        element.dataset.markType = mark.type;
        element.dataset.markColor = mark.color;
        styleRect(element, rect);
        layer.append(element);
      }
      if (mark.type === 'bookmark') {
        const flag = document.createElement('div');
        flag.className = 'mark-bookmark-flag';
        flag.dataset.markId = mark.id;
        flag.dataset.markColor = mark.color;
        layer.append(flag);
      }
    }
    page.append(layer);
  }

  function refreshControls(pane) {
    const available = ready && Boolean(paneDoc(pane));
    pane.markTools.hidden = !pane.doc;
    const hasBookmark = marks.some(mark => mark.docId === paneDoc(pane) && mark.page === pane.viewer.currentPageNumber && mark.type === 'bookmark');
    const [bookmark, area, undo] = pane.markTools.querySelectorAll('button');
    bookmark.disabled = area.disabled = !available || busy;
    bookmark.setAttribute('aria-pressed', String(hasBookmark));
    bookmark.title = hasBookmark ? '移除本页书签' : '添加本页书签';
    bookmark.setAttribute('aria-label', bookmark.title);
    area.setAttribute('aria-pressed', String(areaPane === pane));
    undo.disabled = !ready || busy || !undoStack.length;
  }

  function makeMark(pane, data) {
    return { id: crypto.randomUUID(), docId: paneDoc(pane), type: 'note', color, page: pane.viewer.currentPageNumber, rects: [], text: '', note: '', ...data };
  }

  async function linkTo(pane, mark, additions = [mark]) {
    const source = marks.find(candidate => candidate.id === linkSource?.id);
    if (!source || linkSource.pane === pane || source.docId === mark.docId || source.id === mark.id) return false;
    const oldPeers = marks.filter(candidate => [source.linkedId, mark.linkedId].includes(candidate.id) && candidate.id !== source.id && candidate.id !== mark.id);
    const linked = [
      ...oldPeers.map(candidate => ({ ...candidate, linkedId: undefined })),
      ...additions.filter(candidate => candidate.id !== mark.id),
      { ...source, linkedId: mark.id },
      { ...mark, linkedId: source.id },
    ];
    if (await change(linked)) {
      setLinkSource(null);
      notify('已关联两栏标注');
    }
    return true;
  }

  async function saveNew(pane, additions) {
    if (linkSource && await linkTo(pane, additions[0], additions)) return !linkSource;
    return change(additions);
  }

  function openEditor(pane, entries, existing = null) {
    if (!entries.length || !paneDoc(pane) || !ready || busy) return;
    dismissSelection(true);
    const mark = entries[0];
    editing = { pane, entries, existing };
    dialog.querySelector('h2').textContent = existing ? `编辑${types[mark.type]}` : `添加${types[mark.type]}`;
    const quote = dialog.querySelector('.mark-editor-text');
    quote.textContent = entries.map(entry => entry.text).join('\n');
    quote.hidden = !quote.textContent;
    form.elements.markColor.value = mark.color;
    form.elements.markNote.value = mark.note || '';
    const other = panes[1 - pane.id];
    const peer = marks.find(candidate => candidate.id === mark.linkedId);
    const edit = action => dialog.querySelector(`[data-mark-edit="${action}"]`);
    edit('delete').hidden = !existing;
    edit('link').hidden = !existing || !paneDoc(other) || paneDoc(other) === paneDoc(pane);
    edit('unlink').hidden = !peer;
    edit('follow').hidden = !peer || paneDoc(other) !== peer.docId;
    if (!dialog.open) dialog.showModal();
  }

  async function removeMark(mark) {
    const peers = marks.filter(candidate => candidate.linkedId === mark.id);
    const removed = await change(peers.map(candidate => ({ ...candidate, linkedId: undefined })), [mark.id]);
    if (removed && linkSource?.id === mark.id) setLinkSource(null);
    return removed;
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (!editing || busy) return;
    const { pane, entries, existing } = editing;
    const replacements = entries.map(mark => ({ ...mark, color: form.elements.markColor.value, note: form.elements.markNote.value.trim() }));
    if (existing ? await change(replacements) : await saveNew(pane, replacements)) dialog.close();
  };
  dialog.addEventListener('click', async event => {
    const action = event.target.dataset.markEdit;
    if (!editing || !action || busy) return;
    const { pane, entries: [mark] } = editing;
    if (action === 'cancel') dialog.close();
    if (action === 'delete' && await removeMark(mark)) dialog.close();
    if (action === 'link') {
      setLinkSource({ id: mark.id, pane });
      dialog.close();
    }
    if (action === 'follow') {
      const peer = marks.find(candidate => candidate.id === mark.linkedId);
      const other = panes[1 - pane.id];
      if (peer && paneDoc(other) === peer.docId) jump(other, peer);
      dialog.close();
    }
    if (action === 'unlink') {
      const peers = marks.filter(candidate => candidate.linkedId === mark.id);
      if (await change([{ ...mark, linkedId: undefined }, ...peers.map(peer => ({ ...peer, linkedId: undefined }))])) dialog.close();
    }
  });

  function dismissSelection(clear = false) {
    toolbar.hidden = true;
    selected = null;
    if (clear) window.getSelection()?.removeAllRanges();
  }

  function updateSelection() {
    selectionFrame = 0;
    if (pointerSelecting || drag || areaPane || dialog.open || !ready) return;
    const selection = window.getSelection();
    const pane = selection && !selection.isCollapsed && selection.rangeCount &&
      panes.find(candidate => paneDoc(candidate) && candidate.container.contains(selection.anchorNode) && candidate.container.contains(selection.focusNode));
    const text = pane && selection.toString().trim();
    if (!text) { dismissSelection(); return; }
    const entries = readSelection(selection, pane);
    if (!entries.length) { dismissSelection(); return; }
    const range = selection.getRangeAt(0);
    const focus = document.createRange();
    focus.setStart(selection.focusNode, selection.focusOffset);
    focus.collapse(true);
    const boundary = focus.getBoundingClientRect();
    const box = boundary.height ? boundary : range.getBoundingClientRect();
    const viewport = pane.container.getBoundingClientRect();
    selected = { pane, entries, text };
    toolbar.hidden = false;
    const x = Math.max(6, Math.min(innerWidth - toolbar.offsetWidth - 6, box.left - toolbar.offsetWidth / 2));
    const above = box.top - toolbar.offsetHeight - 8;
    const top = above >= viewport.top ? above : box.bottom + 8;
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${Math.max(6, Math.min(innerHeight - toolbar.offsetHeight - 6, top))}px`;
  }

  function scheduleSelection() {
    if (!selectionFrame) selectionFrame = requestAnimationFrame(updateSelection);
  }

  document.addEventListener('selectionchange', scheduleSelection);
  document.addEventListener('pointerup', () => {
    if (!pointerSelecting) return;
    pointerSelecting = false;
    scheduleSelection();
  });
  document.addEventListener('pointercancel', () => { pointerSelecting = false; });
  window.addEventListener('resize', () => dismissSelection());
  toolbar.onclick = async event => {
    const newColor = event.target.dataset.markColor;
    const action = event.target.dataset.markAction;
    if (newColor) {
      color = newColor;
      for (const swatch of toolbar.querySelectorAll('[data-mark-color]')) swatch.setAttribute('aria-pressed', String(swatch.dataset.markColor === color));
    }
    if (!selected || !action || busy) return;
    const { pane, entries, text } = selected;
    if (action === 'copy') {
      try {
        if (supportsClipboard) await navigator.clipboard.writeText(text);
        else if (!document.execCommand('copy')) throw new Error('clipboard unavailable');
        dismissSelection(true);
        notify('已复制选中文字');
      } catch {
        notify('复制失败，可按 Ctrl+C 复制选中文字');
      }
      return;
    }
    const additions = entries.map(entry => makeMark(pane, { ...entry, type: action }));
    if (action === 'note') openEditor(pane, additions);
    else if (await saveNew(pane, additions)) dismissSelection(true);
  };

  function setAreaPane(pane) {
    if (drag) {
      drag.preview.remove();
      drag = null;
    }
    areaPane = pane;
    for (const candidate of panes) {
      candidate.container.classList.toggle('mark-area-mode', candidate === pane);
      refreshControls(candidate);
    }
  }

  function dragRect(event) {
    const { page, x, y } = drag;
    const bounds = page.getBoundingClientRect();
    const startX = bounds.left + x * bounds.width;
    const startY = bounds.top + y * bounds.height;
    return relativeRect({
      left: Math.min(startX, event.clientX), top: Math.min(startY, event.clientY),
      right: Math.max(startX, event.clientX), bottom: Math.max(startY, event.clientY),
    }, bounds);
  }

  async function useMark(pane, mark) {
    if (linkSource) {
      if (await linkTo(pane, mark)) return;
      if (linkSource.id === mark.id) { setLinkSource(null); return; }
    }
    openEditor(pane, [mark], mark);
  }

  async function undo() {
    const operation = undoStack.at(-1);
    if (operation && await change(operation.upsert, operation.remove, false)) {
      if (linkSource && !marks.some(mark => mark.id === linkSource.id)) setLinkSource(null);
      notify('已撤销最近一次标注操作');
    }
  }

  for (const pane of panes) {
    pane.markTools = document.createElement('div');
    pane.markTools.className = 'pane-mark-tools';
    pane.markTools.hidden = true;
    pane.markTools.innerHTML = `
      <button type="button" data-mark-pane="bookmark" aria-label="添加本页书签" title="添加本页书签" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4-6 4z"/></svg></button>
      <button type="button" data-mark-pane="area" aria-label="区域标注" title="区域标注" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="M9 4H4v5m11-5h5v5m0 6v5h-5M4 15v5h5"/><path d="M9 9h6v6H9z"/></svg></button>
      <button type="button" data-mark-pane="undo" aria-label="撤销标注" title="撤销标注"><svg viewBox="0 0 24 24"><path d="m8 5-5 5 5 5m-5-5h12a5 5 0 0 1 0 10h-4"/></svg></button>`;
    pane.root.querySelector('.file-row').querySelector('.close-file').before(pane.markTools);
    pane.markTools.onclick = async event => {
      const action = event.target.closest('button')?.dataset.markPane;
      if (action === 'bookmark') {
        const bookmark = marks.find(mark => mark.docId === paneDoc(pane) && mark.page === pane.viewer.currentPageNumber && mark.type === 'bookmark');
        if (bookmark) await removeMark(bookmark);
        else await saveNew(pane, [makeMark(pane, { type: 'bookmark' })]);
      } else if (action === 'area') {
        dismissSelection(true);
        setAreaPane(areaPane === pane ? null : pane);
        if (areaPane) notify('在 PDF 页面上拖出要标注的区域');
      } else if (action === 'undo') {
        await undo();
      }
    };

    pane.bus.on('pagerendered', ({ source }) => {
      if (source.div) paintPage(pane, source.div);
    });
    pane.bus.on('pagechanging', () => refreshControls(pane));
    pane.container.addEventListener('scroll', () => {
      if (selected?.pane === pane) dismissSelection();
    }, { passive: true });

    let pointerDown;
    pane.container.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      pointerDown = { x: event.clientX, y: event.clientY };
      if (areaPane !== pane) {
        pointerSelecting = true;
        dismissSelection();
        return;
      }
      const page = event.target.closest('.page');
      if (!page) return;
      event.preventDefault();
      const bounds = page.getBoundingClientRect();
      const preview = document.createElement('div');
      preview.className = 'mark-area-preview';
      preview.dataset.markColor = color;
      preview.hidden = true;
      page.append(preview);
      drag = {
        pane, page, preview, pointer: event.pointerId,
        x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height,
      };
      pane.container.setPointerCapture(event.pointerId);
    });
    pane.container.addEventListener('pointermove', event => {
      if (drag?.pane !== pane || drag.pointer !== event.pointerId) return;
      const rect = dragRect(event);
      drag.preview.hidden = !rect;
      if (rect) styleRect(drag.preview, rect);
    });
    pane.container.addEventListener('pointerup', async event => {
      if (drag?.pane !== pane || drag.pointer !== event.pointerId) return;
      const rect = dragRect(event);
      const page = Number(drag.page.dataset.pageNumber);
      const bounds = drag.page.getBoundingClientRect();
      if (!rect || rect.w * bounds.width < 5 || rect.h * bounds.height < 5) {
        drag.preview.remove();
        drag = null;
        return;
      }
      setAreaPane(null);
      await saveNew(pane, [makeMark(pane, { type: 'area', page, rects: [rect] })]);
    });
    pane.container.addEventListener('lostpointercapture', () => {
      if (drag?.pane === pane) {
        drag.preview.remove();
        drag = null;
      }
    });
    pane.container.addEventListener('click', event => {
      if (!pointerDown || areaPane || !window.getSelection().isCollapsed || event.target.closest('a,button,input') ||
          Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) return;
      const page = event.target.closest('.page');
      if (!page) return;
      const targets = Array.from(page.querySelectorAll('[data-mark-id]')).reverse();
      const target = targets.find(element => {
        const box = element.getBoundingClientRect();
        return event.clientX >= box.left && event.clientX <= box.right &&
               event.clientY >= box.top && event.clientY <= box.bottom;
      });
      const mark = marks.find(candidate => candidate.id === target?.dataset.markId);
      if (mark) useMark(pane, mark);
    });
  }

  window.addEventListener('reader-mark-jump', event => {
    const mark = marks.find(candidate => candidate.id === event.detail?.id);
    const pane = panes[event.detail?.pane];
    if (!mark || !pane || paneDoc(pane) !== mark.docId) return;
    const other = panes[1 - pane.id];
    const peer = marks.find(candidate => candidate.id === mark.linkedId);
    if (peer && paneDoc(other) === peer.docId) jump(other, peer);
    jump(pane, mark);
  });
  window.addEventListener('reader-mark-edit', event => {
    const mark = marks.find(candidate => candidate.id === event.detail?.id);
    const pane = panes[event.detail?.pane];
    if (mark && pane && paneDoc(pane) === mark.docId) useMark(pane, mark);
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' &&
        !document.querySelector('dialog[open]') && !event.target.closest?.('input,textarea,select,[contenteditable]') && undoStack.length) {
      event.preventDefault();
      undo();
      return;
    }
    if (event.key !== 'Escape' || dialog.open || !(areaPane || linkSource || selected)) return;
    event.preventDefault();
    dismissSelection(true);
    setAreaPane(null);
    setLinkSource(null);
  });

  publish();
  marksRequest().then(state => { ready = true; receive(state); publish(); }).catch(() => notify('无法读取本地标注'));
  return {
    documentChanged(pane) {
      dismissSelection();
      if (areaPane === pane) setAreaPane(null);
      if (linkSource && !pane.doc) setLinkSource(null);
      if (editing?.pane === pane && dialog.open) dialog.close();
      publish();
    },
  };
}
