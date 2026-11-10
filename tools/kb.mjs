#!/usr/bin/env node
/**
 * kb.mjs —— 本地「知识」检索（零模型、零联网）：notes / learnings / tasks 的 md 全文，SQLite FTS5。
 *
 * 为什么要它（2026-11-09，主人说「优化你需要的」，从 B 站那支「从零手搓 Agent」借来的分界）：
 *   那条片子把「记忆＝存经历」和「RAG＝存知识」分成两条检索路。我们原来只有经历那条
 *   （fish_thread 原话 / fish_recall 记忆条），知识（我学过的、写下的方法、任务书）
 *   只能拿 grep 撞，中文一断词就撞不到。
 *
 * 用法：
 *   node tools/kb.mjs "关键词" [更多词…] [--n 5] [--full]
 *   node tools/kb.mjs index       # 只建索引（增量，按 mtime+size）
 *   node tools/kb.mjs stats
 *
 * 设计：index() 在每次检索前自动跑增量；分词用中文二元组 + unicode61，和 chat.db 同一个路子。
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const ROOT = process.env.DSH_DATA_DIR ? join(HOME, process.env.DSH_DATA_DIR) : join(HOME, 'pbyugujia');
const DB = join(ROOT, 'kb.db');
const DIRS = ['notes', 'learnings', 'tasks'];
const MAX_BYTES = 400_000;

mkdirSync(ROOT, { recursive: true });

function open() {
  const db = new DatabaseSync(DB);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, title TEXT, text TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      path UNINDEXED, bigram, tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER);
  `);
  return db;
}

function walk(dir, out) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, out); }
    else if (extname(e.name) === '.md') {
      // 边界：fy-*.md 是记忆条的镜像，归 fish_recall；知识库只收方法/笔记/任务书
      if (/^fy-/.test(e.name)) continue;
      // 别名表是配置不是知识：它一进索引就会把每次放宽都抢成第一条
      if (e.name === '检索别名表.md') continue;
      out.push(p);
    }
  }
}

function titleOf(text, path) {
  const m = text.match(/^#\s+(.+)$/m);
  return (m ? m[1].trim() : '') || relative(ROOT, path).replace(/\.md$/, '');
}

// 中文二元组：把「记忆优化」切成 记忆/忆优/优化；英文和数字按词保留
function tokensOf(s) {
  const out = [];
  const t = String(s || '').toLowerCase();
  const runs = t.match(/[\u4e00-\u9fa5]+|[a-z0-9_+#.-]+/g) || [];
  for (const r of runs) {
    if (/[\u4e00-\u9fa5]/.test(r)) {
      for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2));
      if (r.length === 1) out.push(r);
    } else out.push(r);
  }
  return out;
}
const bigrams = (s) => tokensOf(s).join(' ');

// 检索别名表（2026-11-10 建）：同一件事我说法多，库里常是另一种写法。
// 格式见 notes/检索别名表.md：一行一组，`|` 分隔同义说法。
function loadAliases() {
  let txt = '';
  try { txt = readFileSync(join(ROOT, 'notes', '检索别名表.md'), 'utf8'); } catch { return []; }
  return txt.split('\n')
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').split('|').map((s) => s.trim().toLowerCase()).filter(Boolean))
    .filter((g) => g.length > 1);
}

function index(db) {
  const files = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  let added = 0, skipped = 0;
  for (const p of files) {
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    const prev = db.prepare('SELECT mtime, size FROM files WHERE path = ?').get(p);
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) { skipped++; continue; }
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    const title = titleOf(text, p);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM docs WHERE path = ?').run(p);
      db.prepare('DELETE FROM docs_fts WHERE path = ?').run(p);
      db.prepare('INSERT INTO docs (path, mtime, size, title, text) VALUES (?,?,?,?,?)')
        .run(p, st.mtimeMs, st.size, title, text);
      db.prepare('INSERT INTO docs_fts (path, bigram) VALUES (?,?)').run(p, bigrams(title + '\n' + text));
      db.prepare('INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?,?,?)')
        .run(p, st.mtimeMs, st.size);
      db.exec('COMMIT');
      added++;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('跳过', p, e.message);
    }
  }
  return { total: files.length, added, skipped };
}

function snippet(text, toks, span = 150) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  let at = -1;
  for (const t of toks) { at = flat.indexOf(t); if (at >= 0) break; }
  if (at < 0) return flat.slice(0, span * 2) + (flat.length > span * 2 ? '…' : '');
  const s = Math.max(0, at - span), e = Math.min(flat.length, at + span);
  return (s > 0 ? '…' : '') + flat.slice(s, e).trim() + (e < flat.length ? '…' : '');
}

function search(db, words, n) {
  const base = words.map((w) => String(w).toLowerCase());
  const strict = [...new Set(base.flatMap((w) => tokensOf(w)))];
  if (!strict.length) return { rows: [], relaxed: [], added: [] };

  const run = (toks, op) => {
    const expr = toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
    return db.prepare(`
      SELECT d.path, d.title, d.text, bm25(docs_fts) AS r
      FROM docs_fts JOIN docs d ON d.path = docs_fts.path
      WHERE docs_fts MATCH ? ORDER BY r LIMIT ?
    `).all(expr, n);
  };

  // 一、严格：所有词素都必须出现（原行为）
  const rows = run(strict, 'AND');
  if (rows.length >= n) return { rows, relaxed: [], added: [] };

  // 二、放宽：命中不够时，把别名表里的同义说法一并带上，改用 OR 再搜一次。
  //    触发条件就是「严格命中的篇数 < 要的篇数」，不是每回都放宽。
  const loose = new Set(strict);
  const added = new Set();
  for (const w of base) {
    for (const g of loadAliases()) {
      if (!g.some((m) => m.length >= 2 && (m.includes(w) || w.includes(m)))) continue;
      for (const m of g) {
        if (m.includes(w) || w.includes(m)) continue;
        for (const t of tokensOf(m)) { if (!loose.has(t)) { loose.add(t); added.add(t); } }
      }
    }
  }
  if (!added.size) return { rows, relaxed: [], added: [] };

  const have = new Set(rows.map((r) => r.path));
  const extra = run([...loose], 'OR').filter((r) => !have.has(r.path));
  return { rows: [...rows, ...extra].slice(0, n), relaxed: extra, added: [...added] };
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const db = open();

if (cmd === 'index') {
  const r = index(db);
  console.log(`索引 ${r.total} 个 md：新/改 ${r.added}，未变 ${r.skipped}`);
  process.exit(0);
}
if (cmd === 'stats') {
  const c = db.prepare('SELECT COUNT(*) c FROM docs').get().c;
  console.log(`知识库 ${DB}：${c} 篇`);
  process.exit(0);
}

const nArg = argv.find((a) => a.startsWith('--n'));
const n = nArg ? Number(nArg.split('=')[1] || argv[argv.indexOf(nArg) + 1]) || 5 : 5;
const full = argv.includes('--full');
const words = argv.filter((a) => !a.startsWith('--') && a !== String(n));
if (!words.length) { console.log('用法：node tools/kb.mjs "关键词" [更多词…] [--n 5] [--full]'); process.exit(2); }

index(db); // 检索前先增量对齐，几毫秒
const res = search(db, words, n);
const rows = res.rows;
if (!rows.length) { console.log('知识库里没命中。'); process.exit(0); }
const strictN = rows.length - res.relaxed.length;
console.log(`命中 ${rows.length} 篇（知识 = notes/learnings/tasks）`
  + (res.relaxed.length ? `｜严格 ${strictN} 篇，同义放宽补 ${res.relaxed.length} 篇（${res.added.slice(0, 6).join(' ')}）` : ''));
for (const r of rows) {
  console.log(`\n[${relative(ROOT, r.path)}] ${r.title}`);
  if (full) console.log(r.text.slice(0, 4000));
  else console.log('  ' + snippet(r.text, words.map((w) => String(w).toLowerCase())));
}
