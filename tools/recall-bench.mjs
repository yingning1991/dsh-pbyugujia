#!/usr/bin/env node
/**
 * recall-bench.mjs — 记忆检索小评测（2026-11-06 建）
 *
 * 为什么：说「我们记忆检索够好」只有感觉，没有数。这个脚本拿一份人工题集
 * （out/tmp/recall-bench.json：问题 → 应命中的记忆 id）跑一遍，出命中率@1/@3。
 *
 * 口径：复刻生产检索的两路召回（notes_fts 二元组 + notes_trgm 子串），
 * 合并去重后按「先 FTS 顺序、再 trgm 顺序」取前 3。生产还多一层 BM25 打分
 * 和 RRF 融合，这里只测「找不找得到」，不测排序精度。
 *
 * 用法：
 *   node tools/recall-bench.mjs            # 跑全部题
 *   node tools/recall-bench.mjs --json     # 出 JSON（给复盘/存档）
 *
 * 零模型调用、只读 memory.db。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ROOT = path.join(HOME, 'dafeiyu');
const DB = path.join(ROOT, 'memory.db');
const QFILE = process.argv.includes('--json')
  ? path.join(ROOT, 'out/tmp/recall-bench.json')
  : path.join(ROOT, 'out/tmp/recall-bench.json');

const json = process.argv.includes('--json');
const questions = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const db = new DatabaseSync(DB, { readOnly: true });

// 复刻生产的 tokenize：中文连续段切 bigram（两字一组），英文数字整词
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

function search(q) {
  const seen = new Set();
  const out = [];
  for (const id of [...ftsTop(q), ...trgmTop(q)]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

let hit1 = 0, hit3 = 0;
const misses = [];
for (const item of questions) {
  const top = search(item.q).slice(0, 3);
  const at1 = top[0] === item.expect;
  const at3 = top.includes(item.expect);
  if (at1) hit1++;
  if (at3) hit3++;
  if (!at3) misses.push({ q: item.q, expect: item.expect, got: top });
}

const n = questions.length;
const result = {
  total: n,
  hit1, hit3,
  hit1Rate: +((hit1 / n) * 100).toFixed(1),
  hit3Rate: +((hit3 / n) * 100).toFixed(1),
  misses,
};

if (json) {
  console.log(JSON.stringify(result, null, 1));
} else {
  console.log(`检索评测：${n} 题 · 命中@1 ${hit1}（${result.hit1Rate}%）· 命中@3 ${hit3}（${result.hit3Rate}%）`);
  if (misses.length) {
    console.log('漏检：');
    for (const m of misses) console.log(`  「${m.q}」应中 ${m.expect}，实际前3 ${m.got.join(',') || '无'}`);
  }
  console.log(result.hit3Rate >= 80
    ? '→ 命中@3 ≥80%，不急着加词表扩展；先改问法。'
    : '→ 命中@3 <80%，召回面确实有洞，记一笔，攒够同类再改。');
}
