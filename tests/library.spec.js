import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('folders, import, reopen after refresh, move and conflict preserve PDFs', async ({ page, request }) => {
  const name = `资料-${Date.now()}`;
  await page.goto('/');
  await page.locator('#library-import').click();
  await expect(page.locator('#folder-dialog')).toBeVisible();
  await page.locator('#folder-name').fill(name);
  await page.locator('#folder-create').click();
  await expect(page.locator('#folder-target')).toHaveValue(name);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#folder-confirm').click();
  const pdf = await PDFDocument.create(); pdf.addPage(); const buffer = Buffer.from(await pdf.save());
  await (await chooser).setFiles({ name: '论文.pdf', mimeType: 'application/pdf', buffer });
  let row = page.locator('.library-file').filter({ hasText: '论文.pdf' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '左栏' }).click();
  await expect(page.locator('#pane-0 .page-count')).toHaveText('/ 1');
  await page.reload();
  await row.getByRole('button', { name: '右栏' }).click();
  await expect(page.locator('#pane-1 .page-count')).toHaveText('/ 1');
  await row.getByRole('button', { name: '移动' }).click();
  await page.locator('#folder-name').fill('译文');
  await page.locator('#folder-create').click();
  await expect(page.locator('#folder-target')).toHaveValue(`${name}/译文`);
  await page.locator('#folder-confirm').click();
  await expect(row).toHaveAttribute('data-path', `${name}/译文/论文.pdf`);
  const moved = await request.get(`/api/pdf?path=${encodeURIComponent(`${name}/译文/论文.pdf`)}`);
  expect(Buffer.from(await moved.body())).toEqual(buffer);
  expect((await request.get(`/api/pdf?path=${encodeURIComponent(`${name}/论文.pdf`)}`)).status()).toBe(404);
  const duplicate = await request.post(`/api/import?folder=${encodeURIComponent(`${name}/译文`)}&name=${encodeURIComponent('论文.pdf')}`, { data: buffer });
  expect(duplicate.status()).toBe(409);
  expect(Buffer.from(await (await request.get(`/api/pdf?path=${encodeURIComponent(`${name}/译文/论文.pdf`)}`)).body())).toEqual(buffer);
  // A conflicting move must leave the source intact too.
  expect((await request.post(`/api/import?folder=${encodeURIComponent(name)}&name=${encodeURIComponent('论文.pdf')}`, { data: buffer })).ok()).toBeTruthy();
  expect((await request.post('/api/move', { data: { path: `${name}/论文.pdf`, folder: `${name}/译文` } })).status()).toBe(409);
  expect((await request.get(`/api/pdf?path=${encodeURIComponent(`${name}/论文.pdf`)}`)).ok()).toBeTruthy();
});

test('cancel, invalid PDFs, traversal and foreign origins do not write to library', async ({ page, request }) => {
  const before = await (await request.get('/api/library')).json();
  await page.goto('/');
  await page.locator('#pane-0 .open-button').click();
  await page.locator('#folder-cancel').click();
  await expect(page.locator('#pane-0 .empty-state')).toBeVisible();
  expect((await request.post('/api/folders', { data: { parent: '../outside', name: 'escape' } })).status()).toBe(400);
  expect((await request.post('/api/folders', { data: { name: 'CON' } })).status()).toBe(400);
  expect((await request.post('/api/import?name=invalid.pdf', { data: Buffer.from('invalid') })).status()).toBe(400);
  expect((await request.post('/api/folders', { headers: { Origin: 'https://example.com' }, data: { name: 'foreign' } })).status()).toBe(403);
  expect((await request.get('/api/pdf?path=..%2Fsecret.pdf')).status()).toBe(400);
  expect(await (await request.get('/api/library')).json()).toEqual(before);
});

test('dot names remain visible and a late fetch cannot replace the latest choice', async ({ page, request }) => {
  const folder = `.资料-${Date.now()}`;
  expect((await request.post('/api/folders', { data: { name: folder } })).ok()).toBeTruthy();
  for (const name of ['.slow.pdf', 'latest.pdf']) {
    const pdf = await PDFDocument.create(); pdf.addPage();
    expect((await request.post(`/api/import?folder=${encodeURIComponent(folder)}&name=${name}`, { data: Buffer.from(await pdf.save()) })).ok()).toBeTruthy();
  }
  await page.goto('/');
  const slow = page.locator('.library-file').filter({ hasText: '.slow.pdf' });
  await expect(slow).toBeVisible();
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/api/pdf?**', async route => {
    if (decodeURIComponent(route.request().url()).includes('.slow.pdf')) await gate;
    await route.continue();
  });
  const waiting = page.waitForRequest(req => decodeURIComponent(req.url()).includes('.slow.pdf'));
  await slow.getByRole('button', { name: '左栏' }).click(); await waiting;
  await page.locator('.library-file').filter({ hasText: 'latest.pdf' }).getByRole('button', { name: '左栏' }).click();
  await expect(page.locator('#pane-0 .filename')).toHaveText('latest.pdf');
  const late = page.waitForResponse(res => decodeURIComponent(res.url()).includes('.slow.pdf'));
  release(); await late;
  await page.waitForTimeout(150);
  await expect(page.locator('#pane-0 .filename')).toHaveText('latest.pdf');
});
