#!/usr/bin/env node
/** recall-bench.mjs —— 跑人工题集测记忆检索命中率@1/@3 */
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
const ROOT = path.join(HOME, 'pbyugujia');
const DB = path.join(ROOT, 'memory.db');
const QFILE = process.argv.includes('--json')
  ? path.join(ROOT, 'out/tmp/recall-bench.json')
  : path.join(ROOT, 'out/tmp/recall-bench.json');

const json = process.argv.includes('--json');
/* 2026-11-14 加 --prod：直接调生产 search()（含 RRF 三路融合与打分），测真实排序。
   必须带 noBump——否则测量本身会写 last_touch/last_mood 加固记忆，第二次跑就不是同一基线。 */
const PROD = process.argv.includes('--prod');
let prodSearch = null;
if (PROD) {
  const mod = await import(path.join(HOME, 'node_modules', 'dsh-pbyugujia', 'lib', 'index.js'));
  prodSearch = (q) => mod._internal.search(q, 10, false, false, { noBump: true }).map((x) => String(x.row.id));
}
const questions = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const db = new DatabaseSync(DB, { readOnly: true });

/* 2026-11-17：题集里的 expect 可能已被取代（生产默认不返回被取代的条 ⇒ 那几题永远不可能中）。
   评测前把 expect 沿 superseded_by 追到最新版本；记下改了几条，别假装分数是旧的。 */
const followStale = db.prepare('SELECT id, superseded_by FROM notes WHERE id = ?');
let remapped = [];
for (const item of questions) {
  let cur = item.expect, guard = 0;
  for (;;) {
    const r = followStale.get(cur);
    if (!r || !r.superseded_by || guard++ > 5) break;
    cur = r.superseded_by;
  }
  if (cur !== item.expect) { remapped.push(item.expect + '→' + cur); item.expectOrig = item.expect; item.expect = cur; }
}
if (remapped.length) console.log(`（题集修正：${remapped.length} 条 expect 已过期，追到最新版：${remapped.join('、')}）`);

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

let hit1 = 0, hit3 = 0, hit5 = 0, rrSum = 0;
const misses = [];
for (const item of questions) {
  const full = prodSearch ? prodSearch(item.q) : search(item.q);   // --prod 走生产 RRF 排序
  const top = full.slice(0, 3);
  const rank = full.indexOf(item.expect) + 1;   // 1-based；0 = 前 20 没中
  const at1 = rank === 1;
  const at3 = rank > 0 && rank <= 3;
  if (at1) hit1++;
  if (at3) hit3++;
  if (rank > 0 && rank <= 5) hit5++;
  rrSum += rank > 0 ? 1 / rank : 0;
  if (!at3) misses.push({ q: item.q, expect: item.expect, got: top });
}

const n = questions.length;
/* 2026-11-18 加：噪音代理指标（用户转的知识库横评第四条：不是召回越多越好，是恰好才行）。
   定义 = top-3 里「没命中期望条」的比例。**未命中 ≠ 无关**，只说明「没证明有用」，
   所以这是上限估计，当参考不当准确率；真要测无关率得人工标注每一条。 */
const TOPK = 3;
const noiseProxy = +(((TOPK * n - hit3) / (TOPK * n)) * 100).toFixed(1);
const result = {
  total: n,
  hit1, hit3, hit5,
  hit1Rate: +((hit1 / n) * 100).toFixed(1),
  hit3Rate: +((hit3 / n) * 100).toFixed(1),
  hit5Rate: +((hit5 / n) * 100).toFixed(1),
  mrr: +(rrSum / n).toFixed(3),
  noiseProxyRate: noiseProxy,
  misses,
};

if (json) {
  console.log(JSON.stringify(result, null, 1));
} else {
  console.log(`检索评测：${n} 题 · 命中@1 ${hit1}（${result.hit1Rate}%）· 命中@3 ${hit3}（${result.hit3Rate}%）· 命中@5 ${hit5} · MRR ${result.mrr} · 噪音代理 ${result.noiseProxyRate}%`);
  if (misses.length) {
    console.log('漏检：');
    for (const m of misses) console.log(`  「${m.q}」应中 ${m.expect}，实际前3 ${m.got.join(',') || '无'}`);
  }
  console.log(result.hit3Rate >= 80
    ? '→ 命中@3 ≥80%，不急着加词表扩展；先改问法。'
    : '→ 命中@3 <80%，召回面确实有洞，记一笔，攒够同类再改。');
}
