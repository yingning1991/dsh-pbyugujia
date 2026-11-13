#!/usr/bin/env node
/**
 * mem-ingest.mjs —— 批量精炼入库（2026-11-06 立，借「完美记忆」那期的「清单先判、按批炼、写库前四道校验」）
 *
 * 为什么：fish_remember 是一条一条即写，批量提炼时容易漏结构、漏证据标记、重复入库。
 * 这个工具先把一批候选压过四道校验，过了才写。
 *
 * 用法：
 *   node tools/mem-ingest.mjs --check batch.json     只校验，不写
 *   node tools/mem-ingest.mjs --write batch.json     校验通过就写库
 *   node tools/mem-ingest.mjs --template > batch.json  出个空模板
 *
 * batch.json：数组，每项 { title, body, tags:[], importance, kind? }
 *
 * 四道校验（任何一道不过，这条就不写，只报原因）：
 *   1. 结构：title 非空；body ≥3 行（默认是什么 / 哪些观察撑着 / 什么时候不成立）
 *   2. 证据标记：title 必须以【他说的】/【结果】/【我判断】开头
 *   3. 重复：与库内指纹相同 → 跳过（不当错误，只报「已有」）
 *   4. 同题冲突：同 title 但指纹不同、又没写 supersedes → 标待人工，不写
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pbyugujia', 'memory.db');
const args = process.argv.slice(2);

if (args.includes('--template')) {
  console.log(JSON.stringify([{ title: '【他说的】一句话标题', body: '默认是什么：…\n哪些观察撑着它：…\n什么时候不成立：…', tags: [], importance: 4 }], null, 1));
  process.exit(0);
}

const wi = args.indexOf('--write'), ci = args.indexOf('--check');
const mode = wi >= 0 ? 'write' : 'check';
const file = wi >= 0 ? args[wi + 1] : args[ci + 1];
if (!file || file.startsWith('--')) {
  console.log('用法：node tools/mem-ingest.mjs --check|--write batch.json');
  process.exit(2);
}

const batch = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(batch)) {
  console.log('batch 必须是数组');
  process.exit(2);
}

const db = new DatabaseSync(DB);
const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
const hasPinned = cols.includes('pinned');

// 与插件同一套指纹：去重口径要一致，否则两边会各写一份
const tokenize = (s) => [...String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')].join('').match(/[\p{L}\p{N}]+/gu) || [];
const fpOf = (title, body) => createHash('sha1').update(tokenize(title + '\n' + body).join(' ')).digest('hex');

const MARKS = ['【他说的】', '【结果】', '【我判断】'];
const ok = [], dup = [], bad = [], conflict = [];

for (const [i, n] of batch.entries()) {
  const title = String(n.title || '').trim();
  const body = String(n.body || '').trim();
  const tag = `#${i + 1}`;

  if (!title) { bad.push(`${tag} 没有标题`); continue; }
  const lines = body.split('\n').filter((l) => l.trim());
  if (lines.length < 3) { bad.push(`${tag} 《${title}》正文只有 ${lines.length} 行，要三行（默认是什么/哪些观察撑着/什么时候不成立）`); continue; }
  if (!MARKS.some((m) => title.startsWith(m))) { bad.push(`${tag} 《${title}》标题缺证据标记（【他说的】/【结果】/【我判断】）`); continue; }

  const fp = fpOf(title, body);
  const same = db.prepare('SELECT id FROM notes WHERE fp = ?').get(fp);
  if (same) { dup.push(`${tag} 《${title}》库里已有（${same.id}）`); continue; }
  const sameTitle = db.prepare("SELECT id, fp FROM notes WHERE title = ? AND (superseded_by IS NULL OR superseded_by='')").all(title);
  if (sameTitle.length && !n.supersedes) {
    conflict.push(`${tag} 《${title}》同题已在库（${sameTitle.map((r) => r.id).join(',')}），要改说法请给 supersedes`);
    continue;
  }
  ok.push({ ...n, title, body, tags: n.tags || [], importance: Number(n.importance) || 3 });
}

console.log(`读入 ${batch.length} 条 → 可写 ${ok.length} · 已有 ${dup.length} · 不合规 ${bad.length} · 冲突待定 ${conflict.length}`);
for (const x of [...bad, ...conflict, ...dup]) console.log('  · ' + x);

if (mode === 'write' && ok.length) {
  const now = new Date().toISOString();
  let n = 0;
  for (const x of ok) {
    const id = 'fy-' + now.slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6);
    const pinned = x.tags.some((t) => String(t).includes('钉子')) ? 1 : 0;
    const rid = Number(
      db.prepare(`INSERT INTO notes (id,title,tags,body,importance,created,updated,fp${hasPinned ? ',pinned' : ''}) VALUES (?,?,?,?,?,?,?,?${hasPinned ? ',?' : ''})`)
        .run(id, x.title, x.tags.join(', '), x.body, x.importance, now, now, fpOf(x.title, x.body), ...(hasPinned ? [pinned] : [])).lastInsertRowid
    );
    db.prepare('INSERT INTO notes_fts (rowid, id, text) VALUES (?,?,?)')
      .run(rid, id, tokenize(x.title + ' ' + x.tags.join(' ') + ' ' + x.body).join(' '));
    n++;
    console.log(`  + ${id}  ${x.title}${pinned ? '  （钉子）' : ''}`);
  }
  console.log(`已写入 ${n} 条`);
} else if (mode === 'check' && ok.length) {
  console.log('（只校验没写。要写加 --write）');
}
