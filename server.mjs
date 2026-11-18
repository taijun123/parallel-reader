import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createLibraryApi } from './library-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const url = `http://127.0.0.1:${port}`;
const libraryApi = createLibraryApi(process.env.LIBRARY_DIR || resolve(root, '..', 'library'));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.json': 'application/json' };
if (!existsSync(resolve(root, 'index.html'))) { console.error('Build missing. Run npm install and npm run build first.'); process.exit(1); }
function openBrowser() { if (process.platform === 'win32') spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore' }).unref(); }
const server = http.createServer(async (req, res) => {
  if (await libraryApi(req, res, new URL(req.url, url))) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, url).pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(path)).isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else createReadStream(path).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(url); const html = await response.text();
      if (html.includes('对读 · 双栏 PDF 阅读器')) { if (process.argv.includes('--open')) openBrowser(); console.log(`Already running at ${url}`); process.exit(0); }
    } catch {}
  }
  console.error(`Cannot start on port ${port}: ${error.message}`); process.exit(1);
});
server.listen(port, '127.0.0.1', () => { console.log(`Parallel Reader is ready: ${url}\nClose this window or press Ctrl+C to stop.`); if (process.argv.includes('--open')) openBrowser(); });
