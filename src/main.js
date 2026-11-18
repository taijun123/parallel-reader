import * as pdfjs from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './style.css';
import { pagePosition, topForPosition, clamp } from './sync.js';
import { setupLibrary } from './library.js';
import { setupMarks } from './marks.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const $ = (s, root = document) => root.querySelector(s);
const icons = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M3 8V5h7l2 3h9v12H3Z"/><path d="M3 10h18"/></svg>',
};
let active = 0, altDown = false, offset = 0, toastTimer;
const panes = [];
function notify(message) {
  const toast = $('#toast'); toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.hidden = true, 3000);
}
function updateStatus() {
  const count = panes.filter(p => p.doc).length;
  $('#status').textContent = count === 2 ? ($('#sync-scroll').checked ? '滚动联动已开启' : '左右独立滚动') + ' · ' + ($('#sync-zoom').checked ? '缩放联动已开启' : '左右独立缩放') : count === 1 ? '已打开一份文档，可继续打开另一份' : '打开原文和译文，开始对照阅读';
  $('#align').disabled = count !== 2;
}

function geometry(p) {
  const first = p.viewer.getPageView(0)?.div;
  const origin = first?.offsetTop ?? 0;
  return Array.from({ length: p.doc.numPages }, (_, i) => {
    const el = p.viewer.getPageView(i).div;
    return { top: el.offsetTop - origin, height: el.offsetHeight };
  });
}
function position(p) {
  if (!p.doc) return 0;
  if ($('#sync-mode').value === 'progress') return p.container.scrollTop / Math.max(1, p.container.scrollHeight - p.container.clientHeight);
  return pagePosition(geometry(p), p.container.scrollTop);
}
function captureAlignment() {
  offset = panes.every(p => p.doc) ? position(panes[1]) - position(panes[0]) : 0;
}
function setScroll(p, top, left = p.container.scrollLeft) {
  const c = p.container;
  c.scrollTop = clamp(top, 0, c.scrollHeight - c.clientHeight);
  c.scrollLeft = clamp(left, 0, c.scrollWidth - c.clientWidth);
  p.expected = { top: c.scrollTop, left: c.scrollLeft };
}
function syncFrom(source) {
  const target = panes[1 - source.id];
  if (!source.doc || !target.doc || !$('#sync-scroll').checked || altDown) return;
  const pos = position(source) + (source.id === 0 ? offset : -offset);
  const top = $('#sync-mode').value === 'progress'
    ? pos * (target.container.scrollHeight - target.container.clientHeight)
    : topForPosition(geometry(target), pos);
  const ratioX = source.container.scrollLeft / Math.max(1, source.container.scrollWidth - source.container.clientWidth);
  setScroll(target, top, ratioX * (target.container.scrollWidth - target.container.clientWidth));
}
function jumpToMark(p, mark) {
  const page = p.viewer.getPageView(mark.page - 1)?.div;
  if (!page) return;
  active = p.id;
  p.muteUntil = performance.now() + 300;
  p.viewer.scrollPageIntoView({ pageNumber: mark.page });
  if (mark.rects.length) {
    const box = page.getBoundingClientRect();
    const view = p.container.getBoundingClientRect();
    const rect = mark.rects[0];
    const pageTop = p.container.scrollTop + box.top - view.top;
    const top = pageTop + Math.max(-12, box.height * rect.y - Math.min(100, view.height * .25));
    const x = box.left + box.width * rect.x;
    const left = x < view.left || x >= view.right ? p.container.scrollLeft + x - view.left - 18 : p.container.scrollLeft;
    setScroll(p, top, left);
  } else {
    setScroll(p, p.container.scrollTop);
  }
  p.viewer.update();
  page.classList.remove('mark-flash');
  requestAnimationFrame(() => page.classList.add('mark-flash'));
}

function fitScale(p) {
  const page = p.viewer.getPageView(p.viewer.currentPageNumber - 1);
  return clamp((p.container.clientWidth - 40) / (page.viewport.width / page.scale), .25, 4);
}
function changeZoom(p, value, independent = false) {
  if (!p.doc) return;
  active = p.id;
  const targets = $('#sync-zoom').checked && !independent && !altDown ? panes.filter(x => x.doc) : [p];
  for (const t of targets) t.muteUntil = performance.now() + 250;
  p.viewer.currentScaleValue = value === 'page-width' ? fitScale(p) : value;
  for (const t of targets) if (t !== p) t.viewer.currentScale = p.viewer.currentScale;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Each viewer preserves its own reading location while changing scale.
    for (const t of targets) { t.viewer.update(); t.expected = { top: t.container.scrollTop, left: t.container.scrollLeft }; }
  }));
}

function createPane(id, title) {
  const root = document.createElement('section'); root.className = 'pane'; root.id = `pane-${id}`;
  root.setAttribute('aria-label', title);
  root.innerHTML = `<div class="pane-heading"><div class="pane-title"><b>${title}</b></div><button class="open-button quiet">${icons.open}<span>打开 PDF</span></button></div>
    <div class="file-row"><span class="filename">尚未打开文件</span><button class="close-file" title="关闭文档" aria-label="关闭${title}" hidden>×</button></div>
    <div class="pane-tools"><div class="page-controls"><button data-action="previous" aria-label="${title}上一页">‹</button><input class="page-input" type="number" min="1" value="1" aria-label="${title}页码" /><span class="page-count">/ 0</span><button data-action="next" aria-label="${title}下一页">›</button></div><div class="zoom-controls"><button data-action="minus" aria-label="缩小${title}">−</button><input class="zoom-input" aria-label="${title}缩放百分比" value="100%" inputmode="decimal" /><button data-action="plus" aria-label="放大${title}">+</button><span class="tool-divider"></span><button data-action="fit" class="fit-button" title="适应当前栏宽度">适应宽度</button></div></div>
    <div class="reading-surface"><div class="viewer-container" tabindex="0" aria-label="${title} PDF 阅读区"><div class="pdfViewer"></div></div><div class="empty-state"><div class="paper-icon">${icons.file}<span>${id === 0 ? 'Aa' : '译'}</span></div><h2>${id === 0 ? '从原文开始' : '把译文放在这里'}</h2><button class="primary choose-file">${icons.open}选择${title} PDF</button><span class="drop-hint">或将文件拖入此区域</span></div><div class="loading-state" hidden><span class="spinner"></span><span>正在打开文档…</span></div><div class="drop-overlay">松开以打开${title}</div></div><input class="file-input" type="file" accept="application/pdf,.pdf" hidden /><div class="pane-bottom"><span class="pane-state">等待打开文档</span><span>PDF</span></div>`;
  $('#workspace').append(root);
  const container = $('.viewer-container', root);
  const bus = new EventBus();
  const linkService = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
  const viewer = new PDFViewer({ container, viewer: $('.pdfViewer', root), eventBus: bus, linkService, textLayerMode: 1, annotationMode: 1, removePageBorders: true });
  linkService.setViewer(viewer);
  const p = { id, root, container, bus, viewer, linkService, doc: null, task: null, token: 0, expected: null, muteUntil: 0 };
  panes.push(p);
  const readyControls = enabled => root.querySelectorAll('.pane-tools button, .pane-tools input').forEach(el => el.disabled = !enabled);
  readyControls(false); p.readyControls = readyControls;
  const picker = $('.file-input', root);
  let importFolder = null;
  for (const el of root.querySelectorAll('.open-button,.choose-file')) el.onclick = async () => {
    const folder = await library.chooseFolder();
    if (folder !== null) { importFolder = folder; picker.click(); }
  };
  picker.onchange = () => { const file = picker.files[0], folder = importFolder; importFolder = null; picker.value = ''; if (file) library.importFiles([file], p.id, folder); };
  $('.close-file', root).onclick = () => { library.cancelOpen(id); closeFile(p); };
  root.addEventListener('pointerdown', () => { active = id; });
  container.addEventListener('wheel', e => {
    active = id; p.expected = null; p.muteUntil = 0;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); changeZoom(p, clamp(viewer.currentScale * (e.deltaY > 0 ? 0.9 : 1.1), .25, 4), e.altKey); }
  }, { passive: false });
  container.addEventListener('pointerdown', () => { p.expected = null; p.muteUntil = 0; });
  container.addEventListener('keydown', () => { active = id; p.expected = null; });
  container.addEventListener('scroll', () => {
    if (!p.doc || performance.now() < p.muteUntil) return;
    if (p.expected && Math.abs(container.scrollTop - p.expected.top) < 2 && Math.abs(container.scrollLeft - p.expected.left) < 2) return;
    p.expected = null;
    if (active === id) syncFrom(p);
  }, { passive: true });
  bus.on('pagechanging', ({ pageNumber }) => { $('.page-input', root).value = pageNumber; $('.pane-state', root).textContent = `第 ${pageNumber} 页 · 共 ${p.doc?.numPages || 0} 页`; });
  bus.on('scalechanging', ({ scale }) => $('.zoom-input', root).value = `${Math.round(scale * 100)}%`);
  bus.on('pagerendered', ({ error }) => { if (error) notify(`${title}中有页面未能渲染，请尝试重新打开文件`); });
  const go = page => { if (!p.doc) return; active = id; p.expected = null; viewer.currentPageNumber = clamp(page, 1, p.doc.numPages); requestAnimationFrame(() => syncFrom(p)); };
  $('.page-input', root).onchange = e => { go(Number.parseInt(e.target.value) || 1); e.target.value = viewer.currentPageNumber; };
  $('.zoom-input', root).onchange = e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) changeZoom(p, clamp(n / 100, .25, 4)); e.target.value = `${Math.round(viewer.currentScale * 100)}%`; };
  root.querySelectorAll('[data-action]').forEach(button => button.onclick = e => {
    const action = button.dataset.action;
    if (action === 'previous' || action === 'next') go(viewer.currentPageNumber + (action === 'next' ? 1 : -1));
    else changeZoom(p, action === 'fit' ? 'page-width' : clamp(viewer.currentScale + (action === 'plus' ? .1 : -.1), .25, 4), e.altKey);
  });
  let dragDepth = 0;
  root.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; root.classList.add('dragging'); });
  root.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  root.addEventListener('dragleave', () => { if (--dragDepth <= 0) root.classList.remove('dragging'); });
  root.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; root.classList.remove('dragging'); const file = e.dataTransfer.files[0]; if (file) library.importFiles([file], p.id); });
  return p;
}

async function closeFile(p) {
  p.token++;
  const old = p.task; p.task = null; p.doc = null; p.markDoc = null;
  p.viewer.setDocument(null); p.linkService.setDocument(null); p.readyControls(false);
  $('.empty-state', p.root).hidden = false; $('.loading-state', p.root).hidden = true;
  $('.close-file', p.root).hidden = true; $('.filename', p.root).textContent = '尚未打开文件';
  $('.pane-state', p.root).textContent = '等待打开文档'; $('.page-count', p.root).textContent = '/ 0';
  $('.page-input', p.root).value = 1; offset = 0; updateStatus();
  marking.documentChanged(p);
  if (old) await old.destroy().catch(() => {});
}
async function loadFile(p, file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { notify('请选择 PDF 格式的文件'); return; }
  const closing = closeFile(p);
  const token = p.token;
  await closing;
  if (token !== p.token) return;
  $('.empty-state', p.root).hidden = true; $('.loading-state', p.root).hidden = false;
  $('.filename', p.root).textContent = file.name; $('.filename', p.root).title = file.name;
  $('.close-file', p.root).hidden = false;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const hash = await crypto.subtle.digest('SHA-256', data);
    const docId = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
    if (token !== p.token) return;
    const task = pdfjs.getDocument({ data, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/', isEvalSupported: false });
    p.task = task;
    task.onPassword = (updatePassword, reason) => {
      const password = window.prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入 PDF 密码' : '这份 PDF 需要密码，请输入');
      if (password === null) closeFile(p); else updatePassword(password);
    };
    const doc = await task.promise;
    if (token !== p.token) { await task.destroy(); return; }
    p.doc = doc; p.muteUntil = performance.now() + 400;
    const initialized = new Promise(resolve => { const handler = () => { p.bus.off('pagesinit', handler); resolve(); }; p.bus.on('pagesinit', handler); });
    p.viewer.setDocument(doc); p.linkService.setDocument(doc);
    await initialized;
    if (token !== p.token) return;
    const other = panes[1 - p.id];
    p.viewer.currentScaleValue = $('#sync-zoom').checked && other.doc ? other.viewer.currentScale : fitScale(p);
    $('.page-count', p.root).textContent = `/ ${doc.numPages}`; $('.page-input', p.root).max = doc.numPages;
    $('.pane-state', p.root).textContent = `第 1 页 · 共 ${doc.numPages} 页`;
    $('.loading-state', p.root).hidden = true; p.readyControls(true);
    p.markDoc = { id: docId, name: file.name, path: file.libraryPath, getBytes: async () => new Uint8Array(await file.arrayBuffer()) };
    marking.documentChanged(p);
    updateStatus();
    requestAnimationFrame(() => { p.viewer.update(); captureAlignment(); });
  } catch (error) {
    if (token !== p.token) return;
    await closeFile(p);
    notify(error.name === 'InvalidPDFException' ? '文件无法解析，请检查 PDF 是否完整' : '打开失败，请检查文件或重新选择');
  }
}

createPane(0, '原文'); createPane(1, '译文');
const marking = setupMarks({ panes, notify, jump: jumpToMark });
const library = setupLibrary({ load: (id, file) => loadFile(panes[id], file), notify });
$('#sync-scroll').onchange = () => { captureAlignment(); updateStatus(); };
$('#sync-zoom').onchange = () => { if ($('#sync-zoom').checked) { const p = panes[active].doc ? panes[active] : panes[1-active]; if (p.doc) changeZoom(p, p.viewer.currentScale); } updateStatus(); };
$('#sync-mode').onchange = () => { captureAlignment(); notify('已按当前位置切换同步方式'); };
$('#align').onclick = () => { captureAlignment(); notify('已将左右当前位置设为同步起点'); };
let readingLayoutToken = 0;
function setReadingMode(enabled) {
  const token = ++readingLayoutToken;
  const positions = panes.map(p => ({ top: p.container.scrollTop, left: p.container.scrollLeft }));
  for (const p of panes) p.muteUntil = performance.now() + 250;
  document.body.classList.toggle('reading-mode', enabled);
  $('#reading-mode').setAttribute('aria-pressed', String(enabled));
  $('#exit-reading-mode').hidden = !enabled;
  (enabled ? $('#exit-reading-mode') : $('#reading-mode')).focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token !== readingLayoutToken) return;
    for (const p of panes) {
      if (!p.doc) continue;
      setScroll(p, positions[p.id].top, positions[p.id].left);
      p.viewer.update();
    }
    // Changing viewport height changes progress coordinates; retain the current pair.
    captureAlignment();
  }));
}
$('#reading-mode').onclick = () => setReadingMode(true);
$('#exit-reading-mode').onclick = () => setReadingMode(false);
document.addEventListener('keydown', e => {
  if (!e.defaultPrevented && e.key === 'Escape' && document.body.classList.contains('reading-mode') && !document.querySelector('dialog[open]')) {
    e.preventDefault(); setReadingMode(false);
  }
});
document.addEventListener('keydown', e => { altDown = e.altKey; });
document.addEventListener('keyup', e => { altDown = e.altKey; });
window.addEventListener('blur', () => altDown = false);
$('#help').onclick = () => $('#help-dialog').showModal();
$('#help-done').onclick = () => $('#help-dialog').close();
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
updateStatus();
