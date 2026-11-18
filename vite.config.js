import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLibraryApi } from './library-api.mjs';

function copyPdfAssets(target) {
  for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
    const dest = resolve(target, 'pdf-assets', name);
    mkdirSync(dest, { recursive: true });
    cpSync(resolve('node_modules/pdfjs-dist', name), dest, { recursive: true });
  }
}
export default defineConfig({
  plugins: [{ name: 'local-pdf-assets', buildStart() { copyPdfAssets('public'); } }, {
    name: 'local-library',
    configureServer(server) {
      const api = createLibraryApi(resolve('library'));
      server.middlewares.use((req, res, next) => {
        api(req, res, new URL(req.url, `http://${req.headers.host}`)).then(handled => { if (!handled) next(); }).catch(next);
      });
    },
  }],
  server: { host: '127.0.0.1', port: 5173 },
});
