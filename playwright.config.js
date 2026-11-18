import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = Number(process.env.READER_TEST_PORT || 4174);
export default defineConfig({
  testDir: './tests', timeout: 30000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', viewport: { width: 1440, height: 1000 } },
  webServer: { command: 'node server.mjs', port, env: { PORT: String(port), LIBRARY_DIR: mkdtempSync(join(tmpdir(), 'parallel-reader-test-')) }, reuseExistingServer: false },
});
