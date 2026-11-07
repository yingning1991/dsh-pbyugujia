#!/usr/bin/env node
/**
 * mem-pin.mjs —— 钉子层管理（2026-11-06 立，借「完美记忆」那期的「钉子不淘汰」）
 *
 * 为什么：承诺和教训不该随时间沉底。库里 notes.pinned=1 的条，永远不进
 * 「该沉下去」的候选（tools/graph.mjs dormant 已排除），检索时也不会被遗忘侧挑中。
 *
 * 用法：
 *   node tools/mem-pin.mjs --list                 看现在有哪些钉子
 *   node tools/mem-pin.mjs --pin <id或关键词>      钉住（id 前缀或标题/正文包含）
 *   node tools/mem-pin.mjs --unpin <id或关键词>    取消钉
 *   node tools/mem-pin.mjs --auto                 按标签扫一遍：带「钉子」标签但没上钉的补上
 *
 * 约定：fish_remember 时 tags 写「钉子」，插件会自动 pinned=1；这条命令给老条目补钉。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dafeiyu', 'memory.db');
const db = new DatabaseSync(DB);
const args = process.argv.slice(2);
const val = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
if (!cols.includes('pinned')) {
  db.exec('ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  console.log('（补建 pinned 列）');
}

function find(q) {
  if (!q) return [];
  return db.prepare(
    "SELECT id, title, pinned FROM notes WHERE id = ? OR id LIKE ? OR title LIKE ? OR body LIKE ? ORDER BY created DESC LIMIT 20"
  ).all(q, q + '%', '%' + q + '%', '%' + q + '%');
}

if (args.includes('--list')) {
  const rows = db.prepare("SELECT id, title, tags FROM notes WHERE pinned = 1 AND (superseded_by IS NULL OR superseded_by='') ORDER BY created").all();
  console.log(`钉子 ${rows.length} 条（承诺/教训，永不沉底）：`);
  for (const r of rows) console.log(`  ${r.id}  ${r.title}`);
  process.exit(0);
}

if (args.includes('--auto')) {
  const rows = db.prepare("SELECT id, title, tags FROM notes WHERE pinned = 0 AND tags LIKE '%钉子%'").all();
  for (const r of rows) db.prepare('UPDATE notes SET pinned = 1 WHERE id = ?').run(r.id);
  console.log(`按标签补钉 ${rows.length} 条`);
  for (const r of rows) console.log(`  ${r.id}  ${r.title}`);
  process.exit(0);
}

const pin = val('--pin');
const unpin = val('--unpin');
const q = pin || unpin;
if (!q) {
  console.log('用法：--list / --pin <id或关键词> / --unpin <id或关键词> / --auto');
  process.exit(2);
}
const hits = find(q);
if (!hits.length) {
  console.log(`没找到「${q}」`);
  process.exit(1);
}
if (hits.length > 1) {
  console.log(`匹配 ${hits.length} 条，说具体一点（或直接用 id）：`);
  for (const h of hits) console.log(`  ${h.id}  ${h.title}  ${h.pinned ? '（已是钉子）' : ''}`);
  process.exit(1);
}
const t = hits[0];
db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(pin ? 1 : 0, t.id);
console.log(`${pin ? '钉住' : '取消'}：${t.id}  ${t.title}`);
