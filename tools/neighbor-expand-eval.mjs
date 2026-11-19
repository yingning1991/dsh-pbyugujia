#!/usr/bin/env node
/** neighbor-expand-eval.mjs —— 离线验「命中后加一跳邻居」值不值（2026-11-13 建） */
/**
 * neighbor-expand-eval.mjs — 横向记忆扩展的离线评测
 *
 * 为什么：HiVe-Mem（arXiv 2611.12872）说「先语义检索种子、再顺关系图扩邻居」能提升召回且省 token。
 * 我们的同义扩写、场景条 source_ids、张力边，是这套的手工版。要动线上检索前，先离线看：
 * 加一跳邻居到底提不提升命中，代价是多少 token（11-12 栽过：没离线验就改，重启三次）。
 *
 * 口径：
 * 基线 = recall-bench 的前 3 条（FTS 二元组 + trgm 子串，先 FTS 顺序再 trgm）。
 * 变体 A = 前三 + 一跳邻居（每条种子挂的 source_ids / 张力对端；去重后追加在种子后）。
 * 变体 B = 单纯取前 5（用来分辨「提升是来自扩邻居，还是只是多给了两条」）。
 * 指标 = 命中@1 / @3 / @5（expect 在不在），以及「多带的字」= 追加条目的标题+正文长度。
 *
 * 用法：
 *   node tools/neighbor-expand-eval.mjs          # 人读表格
 *   node tools/neighbor-expand-eval.mjs --json   # 出 JSON
 *
 * 零模型调用、只读 memory.db。改检索前必须先在真数据上跑这个。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ROOT = path.join(HOME, 'pbyugujia');
const DB = path.join(ROOT, 'memory.db');
const QFILE = path.join(ROOT, 'out/tmp/recall-bench.json');
const asJson = process.argv.includes('--json');

const questions = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const db = new DatabaseSync(DB, { readOnly: true });

function tokens(s) {
  const t = String(s || '').normalize('NFKC').toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (x) => { if (x && !seen.has(x)) { seen.add(x); out.push(x); } };
  let cjk = '', word = '';
  const flushCjk = () => {
    if (!cjk) return;
    if (cjk.length === 1) push(cjk);
    else for (let i = 0; i < cjk.length - 1; i += 1) push(cjk.slice(i, i + 2));
    cjk = '';
  };
  const flushWord = () => { if (word) { push(word); word = ''; } };
  for (const ch of t) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) { flushWord(); cjk += ch; }
    else if (/[a-z0-9]/.test(ch)) { flushCjk(); word += ch; }
    else { flushCjk(); flushWord(); }
  }
  flushCjk(); flushWord();
  return out;
}

function chunks(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3);
}

function ftsTop(q, limit = 20) {
  const toks = tokens(q);
  if (!toks.length) return [];
  const esc = (t) => `"${t.replace(/"/g, '""')}"`;
  for (const joiner of ['AND', 'OR']) {
    try {
      const expr = toks.map(esc).join(` ${joiner} `);
      const rows = db.prepare(
        `SELECT f.id AS id FROM notes_fts f JOIN notes n ON n.id = f.id
         WHERE notes_fts MATCH ? AND n.superseded_by = ''
         ORDER BY bm25(notes_fts) LIMIT ?`
      ).all(expr, limit);
      if (rows.length) return rows.map((r) => String(r.id));
    } catch { /* 下一档 */ }
  }
  return [];
}

function trgmTop(q, limit = 20) {
  const cs = chunks(q);
  if (!cs.length) return [];
  const expr = cs.map((s) => `"${s.replace(/"/g, '""')}"`).join(' AND ');
  try {
    return db.prepare(
      `SELECT f.id AS id FROM notes_trgm f JOIN notes n ON n.id = f.id
       WHERE notes_trgm MATCH ? AND n.superseded_by = ''
       ORDER BY bm25(notes_trgm) LIMIT ?`
    ).all(expr, limit).map((r) => String(r.id));
  } catch { return []; }
}

function search(q, limit = 20) {
  const seen = new Set();
  const out = [];
  for (const id of [...ftsTop(q, limit), ...trgmTop(q, limit)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const getRow = db.prepare('SELECT id,title,body,source_ids,tension FROM notes WHERE id = ?');
const rowCache = new Map();
function row(id) {
  if (!rowCache.has(id)) rowCache.set(id, getRow.get(id) || null);
  return rowCache.get(id);
}

// 一跳邻居：source_ids（场景条挂的原子条）+ 张力对端（"id:kind" 里取 id）
function neighborsOf(id) {
  const r = row(id);
  if (!r) return [];
  const out = [];
  for (const x of String(r.source_ids || '').split(/[,，\s]+/)) if (x) out.push(x.trim());
  for (const x of String(r.tension || '').split(/[,，\s]+/)) {
    const cut = x.indexOf(':');
    if (cut > 0) out.push(x.slice(0, cut).trim());
  }
  return out.filter((x) => x && x !== id);
}

function charsOf(ids) {
  let n = 0;
  for (const id of ids) {
    const r = row(id);
    if (r) n += String(r.title || '').length + String(r.body || '').length;
  }
  return n;
}

function hit(rank, expect) {
  if (!expect) return false;
  const i = rank.indexOf(expect);
  return i >= 0;
}

const rowsOut = [];
let sumA = 0, sumExtra = 0;

for (const { q, expect } of questions) {
  const all = search(q, 20);
  const base3 = all.slice(0, 3);
  const base5 = all.slice(0, 5);

  const seedSet = new Set(base3);
  const nbr = [];
  for (const id of base3) {
    for (const n of neighborsOf(id)) {
      if (!seedSet.has(n) && !nbr.includes(n)) nbr.push(n);
    }
  }
  const variantA = [...base3, ...nbr];

  const hits = (arr) => ({ at1: arr[0] === expect, at3: hit(arr.slice(0, 3), expect), at5: hit(arr.slice(0, 5), expect) });
  const b = hits(base3), b5 = hits(base5), a = hits(variantA);
  if (a.at3 && !b.at3) sumA += 1;
  const extraChars = charsOf(nbr);
  sumExtra += extraChars;

  rowsOut.push({ q, expect, base3: b, base5: b5, expand3: a, added: nbr.length, extraChars });
}

const pct = (n, d) => `${n}/${d}`;
const cnt = (f) => rowsOut.filter(f).length;

if (asJson) {
  console.log(JSON.stringify({
    questions: rowsOut.length,
    baseline3: { at1: cnt((r) => r.base3.at1), at3: cnt((r) => r.base3.at3), at5: cnt((r) => r.base3.at5) },
    base5: { at3: cnt((r) => r.base5.at3), at5: cnt((r) => r.base5.at5) },
    expand3: { at1: cnt((r) => r.expand3.at1), at3: cnt((r) => r.expand3.at3), at5: cnt((r) => r.expand3.at5) },
    rescued: sumA, totalAddedChars: sumExtra,
    rows: rowsOut,
  }, null, 1));
  process.exit(0);
}

console.log(`题集 ${rowsOut.length} 题（out/tmp/recall-bench.json）\n`);
console.log('方案                     命中@1   命中@3   命中@5   多带字');
const line = (name, at1, at3, at5, extra) =>
  console.log(`${name.padEnd(22, ' ')}${pct(at1, rowsOut.length).padEnd(9, ' ')}${pct(at3, rowsOut.length).padEnd(9, ' ')}${pct(at5, rowsOut.length).padEnd(9, ' ')}${extra}`);
line('基线 前3', cnt((r) => r.base3.at1), cnt((r) => r.base3.at3), cnt((r) => r.base3.at5), '0');
line('对照 单纯前5', cnt((r) => r.base3.at1), cnt((r) => r.base5.at3), cnt((r) => r.base5.at5), '—');
line('变体 前3+一跳邻居', cnt((r) => r.expand3.at1), cnt((r) => r.expand3.at3), cnt((r) => r.expand3.at5), String(sumExtra));

const misses = rowsOut.filter((r) => !r.expand3.at5);
if (misses.length) {
  console.log('\n加邻居后仍没中的：');
  for (const r of misses) console.log(`- ${r.q}（应中 ${r.expect}；邻居 ${r.added} 条）`);
}
const rescued = rowsOut.filter((r) => !r.base3.at3 && r.expand3.at3);
if (rescued.length) {
  console.log('\n邻居救回来的：');
  for (const r of rescued) console.log(`- ${r.q}（补了 ${r.added} 条、${r.extraChars} 字）`);
}
console.log(`\n结论口径：@3 涨了且多带的字远小于「多给两条正文」→ 值得做规则版；@3 没涨 → 只是多给，不是扩得准。`);
