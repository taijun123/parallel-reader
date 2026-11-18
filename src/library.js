import './studio.css';
import { setupMarkLibrary } from './mark-library.js';

export function setupLibrary({ load, notify }) {
  const $ = s => document.querySelector(s);
  let entries = [], currentFolder = '', selected = null;
  const openTokens = [0, 0];
  const sidebar = document.createElement('aside');
  sidebar.id = 'library'; sidebar.className = 'library'; sidebar.setAttribute('aria-label', '文档目录');
  sidebar.innerHTML = `<div class="library-heading"><b>文档库</b><button id="library-refresh" class="quiet" title="刷新目录">刷新</button></div>
    <div class="library-tabs" role="tablist" aria-label="侧栏内容"><button id="documents-tab" role="tab" aria-selected="true" aria-controls="documents-panel">文档</button><button id="marks-tab" role="tab" aria-selected="false" aria-controls="marks-panel" tabindex="-1">批注</button></div>
    <section id="documents-panel" role="tabpanel" aria-labelledby="documents-tab"><label class="library-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" id="library-search" aria-label="搜索文档" placeholder="搜索文档"></label><div class="library-actions"><button id="folder-new" class="quiet">＋ 新建文件夹</button><button id="library-import" class="quiet">导入 PDF</button></div><div id="library-tree"></div><input id="library-files" type="file" accept=".pdf,application/pdf" multiple hidden></section>
    <section id="marks-panel" role="tabpanel" aria-labelledby="marks-tab" hidden></section>
    <div class="library-local"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14h18m-4 2h1"/></svg>本地文档库</div>`;
  const layout = document.createElement('div');
  layout.className = 'reader-layout';
  const main = document.createElement('div');
  main.className = 'reader-main';
  main.innerHTML = '<div class="reader-head"><div class="reader-context"><p>文档库 <span id="reader-project"></span></p><h2 id="reader-title">双栏对读</h2></div></div>';
  const readingMode = $('#reading-mode');
  readingMode.prepend(document.createRange().createContextualFragment('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V4h5m8 0h5v5m0 6v5h-5M8 20H3v-5"/></svg>'));
  main.querySelector('.reader-head').append(readingMode);
  $('#workspace').before(layout);
  main.append($('.syncbar'), $('#workspace'), $('footer'));
  layout.append(sidebar, main);
  const updateMarkLibrary = setupMarkLibrary(sidebar, notify);
  const tabs = [$('#documents-tab'), $('#marks-tab')];
  const panels = [$('#documents-panel'), $('#marks-panel')];
  tabs.forEach((tab, index) => {
    tab.onclick = () => {
      tabs.forEach((item, i) => {
        item.setAttribute('aria-selected', String(i === index));
        item.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i !== index;
      });
      if (index === 1) updateMarkLibrary();
    };
    tab.onkeydown = event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index];
      next.focus();
      next.click();
    };
  });
  const openPaths = [null, null];
  window.addEventListener('reader-marks-change', () => {
    const docs = window.readerMarkState?.docs || [];
    const doc = docs[1] || docs[0];
    $('#reader-project').textContent = doc?.path?.includes('/') ? ' / ' + doc.path.split('/').slice(0, -1).join(' / ') : '';
    $('#reader-title').textContent = doc?.name?.replace(/\.pdf$/i, '') || '双栏对读';
    const paths = [docs[0]?.path, docs[1]?.path];
    if (paths.some((path, index) => path !== openPaths[index])) {
      openPaths.splice(0, 2, ...paths);
      render();
    }
  });
  $('#library-search').oninput = () => render();
  const closedFolders = new Set();
  const icon = direction => `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M${direction === 'left' ? '16 9l-3 3 3 3' : '13 9l3 3-3 3'}"/></svg>`;
  const hideButton = document.createElement('button');
  hideButton.id = 'library-collapse'; hideButton.className = 'library-icon'; hideButton.innerHTML = icon('left');
  hideButton.title = '收起目录'; hideButton.setAttribute('aria-label', '收起目录'); hideButton.setAttribute('aria-controls', 'library');
  $('.library-heading').append(hideButton);
  const rail = document.createElement('div'); rail.className = 'library-rail'; rail.hidden = true;
  const showButton = document.createElement('button');
  showButton.id = 'library-expand'; showButton.className = 'library-icon'; showButton.innerHTML = icon('right');
  showButton.title = '展开目录'; showButton.setAttribute('aria-label', '展开目录'); showButton.setAttribute('aria-controls', 'library');
  rail.append(showButton); layout.prepend(rail);
  const button = document.createElement('button'); button.id = 'library-toggle'; button.className = 'quiet'; button.textContent = '文档目录'; button.setAttribute('aria-expanded', 'true');
  $('.header-actions').prepend(button);
  function setVisible(visible) {
    sidebar.hidden = !visible; rail.hidden = visible;
    button.setAttribute('aria-expanded', String(visible));
  }
  hideButton.onclick = () => { setVisible(false); showButton.focus({ preventScroll: true }); };
  showButton.onclick = () => { setVisible(true); hideButton.focus({ preventScroll: true }); };
  const narrow = matchMedia('(max-width:700px)');
  const collapse = () => { if (narrow.matches) setVisible(false); };
  narrow.addEventListener('change', collapse); collapse();
  button.onclick = () => setVisible(sidebar.hidden);
  const dialog = document.createElement('dialog'); dialog.id = 'folder-dialog';
  dialog.innerHTML = `<h2 id="folder-dialog-title">选择存放文件夹</h2><p id="folder-dialog-hint">导入会复制到本地目录，原文件保留。</p><label class="folder-label">目标文件夹<select id="folder-target"></select></label><div class="folder-create"><input id="folder-name" aria-label="新文件夹名称" placeholder="新文件夹名称"><button id="folder-create" class="quiet">创建文件夹</button></div><p id="folder-error" role="alert"></p><div class="dialog-actions"><button id="folder-cancel" class="quiet">取消</button><button id="folder-confirm" class="primary">选择此文件夹</button></div>`;
  document.body.append(dialog);
  async function api(path, options) {
    const res = await fetch(path, options), data = await res.json();
    if (!res.ok) throw new Error(data.error || '操作失败');
    return data;
  }
  const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  function folders(nodes = entries, depth = 0, result = [{ path: '', label: '文档目录（根目录）' }]) {
    for (const item of nodes) if (item.type === 'folder') { result.push({ path: item.path, label: `${'　'.repeat(depth)}${item.path}` }); folders(item.children, depth + 1, result); }
    return result;
  }
  function fillFolders(value = currentFolder) {
    $('#folder-target').replaceChildren(...folders().map(f => new Option(f.label, f.path)));
    $('#folder-target').value = folders().some(f => f.path === value) ? value : '';
  }
  async function refresh() {
    ({ entries } = await api('/api/library'));
    render();
  }
  function render() {
    const tree = $('#library-tree'); tree.replaceChildren();
    const query = $('#library-search').value.trim().toLocaleLowerCase();
    const matches = item => item.path.toLocaleLowerCase().includes(query) ||
      item.type === 'folder' && item.children.some(matches);
    const root = document.createElement('button');
    root.textContent = '全部文档';
    root.className = 'folder-row';
    root.onclick = () => { currentFolder = ''; render(); };
    root.classList.toggle('selected', currentFolder === '');
    if (!query) tree.append(root);
    function add(nodes, parent) {
      for (const item of nodes.filter(matches)) {
        if (item.type === 'folder') {
          const details = document.createElement('details');
          details.open = Boolean(query) || !closedFolders.has(item.path);
          details.ontoggle = () => {
            if (query || !details.isConnected) return;
            if (details.open) closedFolders.delete(item.path);
            else closedFolders.add(item.path);
          };
          const summary = document.createElement('summary');
          summary.textContent = item.name;
          summary.classList.toggle('selected', currentFolder === item.path);
          summary.onclick = () => { currentFolder = item.path; tree.querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); summary.classList.add('selected'); };
          const children = document.createElement('div');
          children.className = 'library-folder-children';
          details.append(summary, children);
          add(item.children, children);
          parent.append(details);
        } else {
          const row = document.createElement('div'); row.className = 'library-file'; row.dataset.path = item.path; row.classList.toggle('opened', openPaths.includes(item.path));
          const title = document.createElement('span'); title.textContent = item.name; title.title = item.path;
          row.append(title);
          for (const [label, action] of [['左栏', () => open(item.path, 0)], ['右栏', () => open(item.path, 1)], ['移动', async () => {
            const folder = await chooseFolder('移动 PDF', item.path.slice(0, item.path.lastIndexOf('/') + 1).replace(/\/$/, ''), '选择目标文件夹，移动后可从新位置打开。');
            if (folder === null) return;
            try { await post('/api/move', { path: item.path, folder }); await refresh(); notify('文档已移动'); } catch (e) { notify(e.message); }
          }]]) { const b = document.createElement('button'); b.className = 'quiet'; b.textContent = label; b.onclick = action; row.append(b); }
          parent.append(row);
        }
      }
    }
    add(entries, tree);
    if (!entries.length || query && !tree.children.length) { const empty = document.createElement('p'); empty.className = 'library-hint'; empty.textContent = query ? '没有找到匹配的文档。' : '目录为空，先创建文件夹或导入 PDF。'; tree.append(empty); }
  }
  async function chooseFolder(title = '选择存放文件夹', folder = currentFolder, hint = '导入会复制到本地目录，原文件保留。') {
    if (dialog.open) return null;
    try { await refresh(); } catch (e) { notify(`目录服务不可用，请用 start.cmd 启动。${e.message}`); return null; }
    fillFolders(folder); $('#folder-dialog-title').textContent = title; $('#folder-dialog-hint').textContent = hint;
    $('#folder-error').textContent = ''; $('#folder-name').value = ''; dialog.returnValue = ''; dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm' ? $('#folder-target').value : null); }, { once: true });
    });
  }
  $('#folder-cancel').onclick = () => dialog.close('cancel');
  $('#folder-confirm').onclick = () => { currentFolder = $('#folder-target').value; dialog.close('confirm'); };
  $('#folder-create').onclick = async () => {
    const b = $('#folder-create'); b.disabled = true;
    try { const data = await post('/api/folders', { parent: $('#folder-target').value, name: $('#folder-name').value.trim() }); await refresh(); fillFolders(data.path); $('#folder-name').value = ''; $('#folder-error').textContent = ''; }
    catch (e) { $('#folder-error').textContent = e.message; } finally { b.disabled = false; }
  };
  $('#folder-new').onclick = () => chooseFolder('创建文件夹', currentFolder, '在所选文件夹下输入名称并创建，可连续创建多级文件夹。');
  $('#library-refresh').onclick = () => refresh().catch(e => notify(e.message));
  async function open(path, pane) {
    const token = ++openTokens[pane];
    try {
      const res = await fetch(`/api/pdf?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const blob = await res.blob();
      if (token !== openTokens[pane]) return;
      const file = new File([blob], path.split('/').at(-1), { type: 'application/pdf' });
      file.libraryPath = path;
      await load(pane, file);
      collapse();
    } catch (e) { if (token === openTokens[pane]) notify(e.message); }
  }
  async function importFiles(files, pane, folder = null) {
    if (!files.length) return;
    if (folder === null) folder = await chooseFolder();
    if (folder === null) return;
    for (const file of files) {
      try {
        notify(`正在导入 ${file.name}…`);
        const data = await api(`/api/import?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
        await refresh();
        if (pane !== null) await open(data.path, pane);
        notify(`已导入 ${file.name}`);
      } catch (e) { notify(`${file.name}：${e.message}`); }
    }
  }
  const input = $('#library-files');
  $('#library-import').onclick = async () => { const folder = await chooseFolder(); if (folder !== null) { selected = folder; input.click(); } };
  input.onchange = () => { const files = [...input.files], folder = selected; selected = null; input.value = ''; importFiles(files, null, folder); };
  refresh().catch(() => { $('#library-tree').textContent = '请通过 start.cmd 启动以使用文档目录。'; });
  return { chooseFolder, importFiles, cancelOpen: pane => ++openTokens[pane] };
}


