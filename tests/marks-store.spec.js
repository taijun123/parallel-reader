import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('local marks are committed together and stale writes cannot replace notes', async ({request}) => {
  const endpoint = '/api/marks';
  const read = async () => (await request.get(endpoint)).json();
  const write = data => request.post(endpoint, {data});
  const first = randomUUID(), second = randomUUID();
  const left = {id:first, docId:'left-test', page:6, type:'highlight', color:'yellow', text:'working memory', note:'定义', rects:[{x:.10,y:.32,w:.19,h:.025}], linkedId:second};
  const right = {...left, id:second, docId:'right-test', page:9, text:'工作记忆', linkedId:first};
  const before = await read();
  const result = await write({revision:before.revision, upsert:[left,right], remove:[]});
  expect(result.status()).toBe(200);
  expect((await read()).marks).toEqual(expect.arrayContaining([left,right]));
  const stale = await write({revision:before.revision, upsert:[{...left, note:'old'}], remove:[]});
  expect(stale.status()).toBe(409);
  const invalid = await write({upsert:[{...left,note:'discard'}, {...right,page:0}], remove:[second]});
  expect(invalid.status()).toBe(400);
  expect((await read()).marks).toEqual(expect.arrayContaining([left,right]));
  await write({upsert:[],remove:[second]});
  const state=await read();
  expect(state.marks.find(mark=>mark.id===first).linkedId).toBeUndefined();
  expect(state.marks.some(mark=>mark.id===second)).toBe(false);
  await write({upsert:[],remove:[first]});
  expect((await request.get(endpoint,{headers:{Origin:'https://example.com'}})).status()).toBe(403);
});
