import { createMarksStore } from './marks-api.mjs';
import { mkdir, readdir, lstat, link, unlink, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const send = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function parts(value = '') {
  if (typeof value !== 'string' || value.length > 2000) throw fail('路径无效');
  const segments = value ? value.split('/') : [];
  for (const s of segments) if (!s || s === '.' || s === '..' || /[<>:"\\|?*\x00-\x1f]/.test(s) || /[ .]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) throw fail('文件夹或文件名称无效');
  return segments;
}
async function jsonBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 8192) throw fail('请求过大', 413); }
  try { return JSON.parse(data); } catch { throw fail('请求格式无效'); }
}

export function createLibraryApi(directory) {
  const root = resolve(directory);
  const marks = createMarksStore(root);
  let queue = Promise.resolve();
  async function checked(value = '', directoryOnly = false) {
    const segments = parts(value);
    let path = root;
    for (const s of ['', ...segments]) {
      if (s) path = join(path, s);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw fail('不支持链接目录或文件', 403);
      if ((path !== join(root, ...segments) || directoryOnly) && !info.isDirectory()) throw fail('文件夹不存在', 404);
    }
    return path;
  }
  async function tree(relative = '') {
    const path = await checked(relative, true), result = [];
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      try { parts(item.name); } catch { continue; }
      const p = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) result.push({ name: item.name, path: p, type: 'folder', children: await tree(p) });
      else if (item.isFile() && /\.pdf$/i.test(item.name)) result.push({ name: item.name, path: p, type: 'pdf' });
    }
    return result.sort((a,b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }
  return async function libraryApi(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      // Only our loopback page may use the library, including read endpoints.
      const expected = `http://${req.headers.host}`;
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || (req.headers.origin && req.headers.origin !== expected) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) throw fail('请求来源无效', 403);
      await mkdir(root, { recursive: true });
      if (url.pathname === '/api/marks') { send(res, await marks(req)); }
      else if (req.method === 'GET' && url.pathname === '/api/library') {
        await queue;
        send(res, { entries: await tree() });
      } else if (req.method === 'GET' && url.pathname === '/api/pdf') {
        const value = url.searchParams.get('path');
        if (!value || !/\.pdf$/i.test(value)) throw fail('请选择 PDF');
        const path = await checked(value), info = await lstat(path);
        if (!info.isFile()) throw fail('文件不存在', 404);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        createReadStream(path).on('error', () => res.destroy()).pipe(res);
      } else if (req.method === 'POST') {
        const operation = async () => {
          if (url.pathname === '/api/folders') {
            const { parent = '', name } = await jsonBody(req);
            if (parts(name).length !== 1) throw fail('请输入文件夹名称');
            const parentPath = await checked(parent, true);
            await mkdir(join(parentPath, name));
            return { path: parent ? `${parent}/${name}` : name };
          }
          if (url.pathname === '/api/move') {
            const { path, folder = '' } = await jsonBody(req);
            if (typeof path !== 'string' || !/\.pdf$/i.test(path)) throw fail('请选择 PDF');
            const source = await checked(path), targetDir = await checked(folder, true);
            if (!(await lstat(source)).isFile()) throw fail('文件不存在', 404);
            const name = parts(path).at(-1), target = join(targetDir, name);
            if (source !== target) { await link(source, target); await unlink(source); }
            return { path: folder ? `${folder}/${name}` : name };
          }
          if (url.pathname === '/api/import') {
            const folder = url.searchParams.get('folder') || '', name = url.searchParams.get('name');
            if (!name || parts(name).length !== 1 || !/\.pdf$/i.test(name)) throw fail('请选择 PDF 文件');
            const targetDir = await checked(folder, true), temp = join(targetDir, `.import-${randomUUID()}`);
            let size = 0;
            const limit = new Transform({ transform(chunk, _, cb) { size += chunk.length; cb(size > 500 * 1024 * 1024 ? fail('单个 PDF 最大支持 500 MB', 413) : null, chunk); } });
            try {
              await pipeline(req, limit, createWriteStream(temp, { flags: 'wx' }));
              const file = await open(temp, 'r');
              const header = Buffer.alloc(1024);
              let bytesRead;
              try { ({ bytesRead } = await file.read(header, 0, 1024, 0)); } finally { await file.close(); }
              if (!header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) throw fail('文件无法识别为 PDF');
              // Hard link publishes a complete file without ever overwriting a name.
              await link(temp, join(targetDir, name));
              return { path: folder ? `${folder}/${name}` : name };
            } finally { await unlink(temp).catch(() => {}); }
          }
          throw fail('接口不存在', 404);
        };
        const pending = queue.then(operation);
        queue = pending.catch(() => {});
        send(res, await pending, 201);
      } else throw fail('接口不存在', 404);
    } catch (error) {
      if (res.headersSent || res.destroyed) return true;
      const code = error.code === 'EEXIST' ? 409 : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error.status || 500;
      send(res, { error: error.code === 'EEXIST' ? '目标文件夹中已有同名文件或文件夹，请更换名称或位置' : code === 404 ? '文件或文件夹不存在，请刷新目录' : code === 500 ? '本地文件操作失败，请检查目录权限和磁盘空间' : error.message }, code);
    }
    return true;
  };
}
