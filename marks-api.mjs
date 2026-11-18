import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

const types = new Set(['highlight', 'underline', 'note', 'bookmark', 'area']);
const colors = new Set(['yellow', 'mint', 'purple', 'pink']);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const error = (message, status = 400) => Object.assign(new Error(message), { status });

function validateMark(mark) {
  if (!mark || !validId(mark.id) || !validId(mark.docId) || !types.has(mark.type) ||
      !colors.has(mark.color) || !Number.isSafeInteger(mark.page) || mark.page < 1) {
    throw error('批注的文档、页码或类型无效');
  }
  if (!Array.isArray(mark.rects) || mark.rects.length > 8192) throw error('批注位置无效');
  for (const rect of mark.rects) {
    if (!rect || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1.00001) ||
        rect.x + rect.w > 1.0001 || rect.y + rect.h > 1.0001) throw error('批注超出页面范围');
  }
  for (const key of ['text', 'note']) {
    if (typeof mark[key] !== 'string' || mark[key].length > 120000) throw error('批注文本过长或无效');
  }
  if (mark.linkedId != null && (!validId(mark.linkedId) || mark.linkedId === mark.id)) throw error('关联目标无效');
  return mark;
}

async function readChange(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw error('单次批注过大', 413);
    chunks.push(chunk);
  }
  let change;
  try { change = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('批注请求格式无效'); }
  if (!change || !Array.isArray(change.upsert) || !Array.isArray(change.remove) ||
      change.upsert.length + change.remove.length > 256 || !change.remove.every(validId)) throw error('批注操作无效');
  change.upsert.forEach(validateMark);
  if (change.revision != null && (!Number.isSafeInteger(change.revision) || change.revision < 0)) throw error('批注版本无效');
  return change;
}

export function createMarksStore(root) {
  let db;
  async function connect() {
    if (db) return db;
    const path = join(root, '.parallel-reader.sqlite');
    for (const name of [root, path, path + '-journal', path + '-wal', path + '-shm']) {
      const info = await lstat(name).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (info?.isSymbolicLink()) throw error('批注库路径无效', 403);
    }
    if (db) return db;
    const connection = new DatabaseSync(path);
    try {
      connection.exec(`PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES ('revision',0);`);
    } catch (e) { connection.close(); throw e; }
    db = connection;
    return db;
  }
  function snapshot(conn) {
    return {
      revision: conn.prepare("SELECT value FROM meta WHERE key='revision'").get().value,
      marks: conn.prepare('SELECT body FROM marks ORDER BY rowid').all().map(row => JSON.parse(row.body))
    };
  }
  return async function access(req) {
    if (!['GET','POST'].includes(req.method)) throw error('不支持的批注操作', 405);
    const change = req.method === 'POST' ? await readChange(req) : null;
    const conn = await connect();
    conn.exec(change ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      if (change) {
        const revision = conn.prepare("SELECT value FROM meta WHERE key='revision'").get().value;
        if (change.revision != null && revision !== change.revision) throw error('批注已在其他窗口更新，请刷新后再次操作', 409);
        const write = conn.prepare('INSERT INTO marks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
        const del = conn.prepare('DELETE FROM marks WHERE id=?');
        for (const id of change.remove) del.run(id);
        for (const mark of change.upsert) write.run(mark.id, JSON.stringify(mark));
        conn.exec("UPDATE marks SET body=json_remove(body,'$.linkedId') WHERE json_extract(body,'$.linkedId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM marks target WHERE target.id=json_extract(marks.body,'$.linkedId'))");
        conn.exec("UPDATE meta SET value=value+1 WHERE key='revision'");
      }
      const state = snapshot(conn);
      conn.exec('COMMIT');
      return state;
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  };
}
