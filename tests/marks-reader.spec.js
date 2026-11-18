import {test, expect} from '@playwright/test';
import {PDFDocument, PDFName, PDFArray} from 'pdf-lib';
import {readFile} from 'node:fs/promises';

async function documentBytes(title) {
  const pdf=await PDFDocument.create();
  pdf.setTitle(title);
  for(let page=1;page<=5;page++) {
    const sheet=pdf.addPage([500,730]);
    sheet.drawText(title+' '+page,{x:60,y:580,size:22});
  }
  return Buffer.from(await pdf.save());
}

async function pickText(page,pane,number,action) {
  const text=page.locator('#pane-'+pane+' .page[data-page-number="'+number+'"] .textLayer span').filter({hasText:/Note/}).first();
  await text.scrollIntoViewIfNeeded();
  await text.evaluate(el=>{
    const range=document.createRange();
    range.selectNodeContents(el);
    const sel=getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  });
  const tool=page.locator('[data-mark-action="'+action+'"]');
  await expect(tool).toBeVisible();
  await tool.click();
}

test('annotate two PDFs, jump, link, export, move, and recover saved notes',async({page,request})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const folder='review-'+Date.now();
  expect((await request.post('/api/folders',{data:{name:folder}})).ok()).toBeTruthy();
  for(const name of ['Original Note','Translated Note']) {
    expect((await request.post('/api/import?folder='+folder+'&name='+encodeURIComponent(name+'.pdf'),{data:await documentBytes(name)})).ok()).toBeTruthy();
  }
  await page.goto('/');
  async function openBoth() {
    await page.locator('#documents-tab').click();
    for(const [name,btn] of [['Original Note.pdf','左栏'],['Translated Note.pdf','右栏']]) {
      await page.locator('.library-file').filter({hasText:name}).getByRole('button',{name:btn,exact:true}).click();
    }
    await expect.poll(()=>page.evaluate(()=>window.readerMarkState.docs.filter(Boolean).length)).toBe(2);
  }
  await openBoth();
  await page.locator('#sync-scroll').uncheck();
  const go=async(pane,n)=>{const num=page.locator('#pane-'+pane+' .page-input');await num.fill(String(n));await num.press('Enter');await num.blur()};
  await go(0,2);
  await pickText(page,0,2,'note');
  await page.locator('.mark-editor textarea').fill('核对两种表述');
  await page.locator('.mark-editor button[type=submit]').click();
  await page.locator('#marks-tab').click();
  const card=page.locator('.mark-library-card').filter({hasText:'核对两种表述'});
  await expect(card).toBeVisible();
  await go(0,4);await go(1,3);
  await page.locator('#sync-scroll').check();
  const right=page.locator('#pane-1 .viewer-container');
  const y=await right.evaluate(e=>e.scrollTop);
  await card.locator('.mark-library-jump').click();
  await expect(page.locator('#pane-0 .page-input')).toHaveValue('2');
  await page.waitForTimeout(420);
  expect(Math.abs(await right.evaluate(e=>e.scrollTop)-y)).toBeLessThan(3);
  await card.locator('button').last().click();
  await page.locator('[data-mark-edit=link]').click();
  await pickText(page,1,3,'underline');
  await expect(card).toContainText('已关联');
  await page.locator('#sync-scroll').uncheck();await go(0,1);await go(1,1);
  await card.locator('.mark-library-jump').click();
  await expect(page.locator('#pane-0 .page-input')).toHaveValue('2');
  await expect(page.locator('#pane-1 .page-input')).toHaveValue('3');
  for (const kind of ['md','pdf']) {
    const download=page.waitForEvent('download'); await page.locator('#mark-export-'+kind).click();const file=await download;
    const bytes=await readFile(await file.path());
    if(kind==='md') {expect(bytes.toString()).toContain('核对两种表述');expect(bytes.toString()).toContain('Translated Note');}
    else {const pdf=await PDFDocument.load(bytes);expect(pdf.getPage(1).node.lookup(PDFName.of('Annots'),PDFArray).size()).toBeGreaterThan(0);}
  }
  await request.post('/api/move',{data:{path:folder+'/Original Note.pdf',folder:''}});
  await page.reload();await openBoth();await page.locator('#marks-tab').click();
  await expect(card).toContainText('已关联');
  expect(errors).toEqual([]);
});
