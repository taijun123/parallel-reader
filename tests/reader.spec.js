import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pagePosition, topForPosition } from '../src/sync.js';

async function fixture(pages = 8, tall = false) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([595, tall ? 950 : 842]);
    page.drawText(`Parallel reading / page ${i + 1}`, { x: 45, y: page.getHeight()-70, font, size: 23, color: rgb(.15,.3,.23) });
    for (let n = 0; n < 27; n++) page.drawText(`Line ${n + 1}. Research, evidence and careful reading.`, { x:45, y:page.getHeight()-120-n*22, font, size:12 });
  }
  return Buffer.from(await pdf.save());
}
async function importPdf(page, pane, file) {
  await page.locator(`#pane-${pane} .file-input`).setInputFiles(file);
  await expect(page.locator('#folder-dialog')).toBeVisible();
  await page.locator('#folder-name').fill('case-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  await page.locator('#folder-create').click();
  await expect(page.locator('#folder-name')).toHaveValue('');
  await page.locator('#folder-confirm').click();
}
async function openPair(page, unequal = false) {
  await page.goto('/');
  for (let i=0;i<2;i++) await importPdf(page, i, { name: `${i===0?'original':'translation'}.pdf`, mimeType:'application/pdf', buffer:await fixture(unequal && i ? 12 : 8, unequal && i === 1) });
  await expect(page.locator('#pane-0 .loading-state')).toBeHidden();
  await expect(page.locator('#pane-1 .loading-state')).toBeHidden();
  await expect(page.locator('#pane-0 canvas').first()).toBeVisible();
  await expect(page.locator('#pane-1 canvas').first()).toBeVisible();
  await page.waitForTimeout(450);
}
const top = (page,i) => page.locator(`#pane-${i} .viewer-container`).evaluate(e=>e.scrollTop);
async function wheel(page,i,delta=520) { await page.locator(`#pane-${i} .viewer-container`).hover(); await page.mouse.wheel(0,delta); await page.waitForTimeout(350); }

test('coordinate mapping supports page sizes, offsets and boundaries',()=>{
  const pages=[{top:0,height:800},{top:820,height:1000},{top:1840,height:600}];
  for(const y of [0,100,820,1300,1900]) expect(topForPosition(pages,pagePosition(pages,y))).toBeCloseTo(y,5);
  expect(topForPosition(pages,-2)).toBe(0);
  expect(topForPosition(pages,100)).toBe(2440);
});
test('loads selectable PDFs and synchronizes scrolling in both directions',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openPair(page);
  await expect(page.locator('#pane-0 .textLayer').first()).toContainText('Parallel reading');
  await wheel(page,0); expect(await top(page,0)).toBeGreaterThan(100); expect(Math.abs(await top(page,0)-await top(page,1))).toBeLessThan(3);
  await wheel(page,1); expect(Math.abs(await top(page,0)-await top(page,1))).toBeLessThan(3);
  const before=await top(page,0); await page.waitForTimeout(400); expect(await top(page,0)).toBe(before);
  expect(errors).toEqual([]);
});
test('zoom synchronizes and can be controlled independently',async({page})=>{
  await openPair(page);
  expect(await page.locator('#pane-0 .viewer-container').evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
  const left=page.getByRole('textbox',{name:'原文缩放百分比'}),right=page.getByRole('textbox',{name:'译文缩放百分比'});
  await left.fill('150%'); await left.press('Tab'); await expect(right).toHaveValue('150%');
  await page.getByRole('checkbox',{name:'同步缩放'}).uncheck();
  await right.fill('80%'); await right.press('Tab'); await expect(left).toHaveValue('150%'); await expect(right).toHaveValue('80%');
  await page.getByRole('checkbox',{name:'同步缩放'}).check(); await expect(left).toHaveValue('80%');
  await page.getByRole('button',{name:'放大原文'}).click(); await expect(right).toHaveValue('90%');
});
test('independent scrolling and alignment retain translation offset',async({page})=>{
  await openPair(page);
  await page.getByRole('checkbox',{name:'同步滚动'}).uncheck();
  const originalTop=await top(page,0);
  await wheel(page,1,700); expect(await top(page,0)).toBe(originalTop);
  await page.getByRole('button',{name:'对齐当前位置'}).click();
  await page.getByRole('checkbox',{name:'同步滚动'}).check();
  const offset=await top(page,1)-await top(page,0); await wheel(page,0,350);
  expect(Math.abs((await top(page,1)-await top(page,0))-offset)).toBeLessThan(3);
  const right=await top(page,1);await page.keyboard.down('Alt');await wheel(page,0,200);await page.keyboard.up('Alt');expect(await top(page,1)).toBe(right);
});
test('whole-document progress with unequal page counts and page jump',async({page})=>{
  await openPair(page,true);
  await page.getByLabel('滚动同步方式').selectOption('progress');
  await page.getByRole('spinbutton',{name:'原文页码'}).fill('4'); await page.getByRole('spinbutton',{name:'原文页码'}).press('Tab');
  await page.waitForTimeout(400);
  const progress=await page.locator('.viewer-container').evaluateAll(es=>es.map(e=>e.scrollTop/(e.scrollHeight-e.clientHeight)));
  expect(progress[0]).toBeGreaterThan(.2); expect(Math.abs(progress[0]-progress[1])).toBeLessThan(.003);
});
test('invalid file recovery, replacement, close and responsive help',async({page})=>{
  await page.goto('/');
  await importPdf(page, 0, {name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid')});
  await expect(page.locator('#toast')).toContainText('无法识别');
  await openPair(page);
  await importPdf(page, 0, {name:'replacement.pdf',mimeType:'application/pdf',buffer:await fixture(2)});
  await expect(page.locator('#pane-0 .page-count')).toHaveText('/ 2');
  await expect(page.locator('#pane-0 .textLayer').first()).toContainText('Parallel reading');
  await page.getByRole('button',{name:'关闭原文',exact:true}).click();await expect(page.locator('#pane-0 .empty-state')).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'使用说明'}).click();await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'开始阅读'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
});

test('reading mode expands both panes and preserves reading position and synchronization',async({page})=>{
  await openPair(page);
  await wheel(page,0,700);
  const originalTop=await top(page,0);
  const before=await page.locator('#pane-0 .viewer-container').boundingBox();
  const zoom=await page.locator('#pane-0 .zoom-input').inputValue();
  await page.getByRole('button',{name:'阅读模式',exact:true}).click();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('.syncbar')).toBeHidden();
  for(const selector of ['.pane-heading','.file-row','.pane-tools','.pane-bottom'])
    for(const el of await page.locator(selector).all()) await expect(el).toBeHidden();
  const after=await page.locator('#pane-0 .viewer-container').boundingBox();
  expect(after.height-before.height).toBeGreaterThan(250);
  expect(Math.abs(await top(page,0)-originalTop)).toBeLessThan(3);
  expect(await page.locator('#pane-0 .zoom-input').inputValue()).toBe(zoom);
  await wheel(page,1,300);
  expect(Math.abs(await top(page,0)-await top(page,1))).toBeLessThan(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.locator('#exit-reading-mode')).toBeHidden();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'阅读模式',exact:true}).click();
  await expect(page.locator('#exit-reading-mode')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button',{name:'退出阅读模式'}).click();
  await expect(page.locator('.app-header')).toBeVisible();
});
