#!/usr/bin/env node
'use strict';
/**
 * graph.mjs — 记忆共现图 + 检索打分（规格见 notes/2026-10-31-记忆引擎规格.md）
 *
 * 用法：
 *   node tools/graph.mjs init      建表
 *   node tools/graph.mjs seed      冷启动连边（标签 / 同天）
 *   node tools/graph.mjs stats     看状态
 *   node tools/graph.mjs recall 关键词...
 *   node tools/graph.mjs dormant   挑一条「刚沉下去」的旧事
 *   node tools/graph.mjs tick      批量结算（recall_event → 权重；技能、激素衰减）
 *   node tools/graph.mjs skill list|add <name> <desc>|hit <name> <Q>
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const DIR = path.join(HOME, '.dsh', 'pbyugujia');
const DBFILE = path.join(DIR, 'memory.db');

// ---- 常数（全在规格书里）----
const DAY = 86400;
const LAM_S1 = 1.8e-6;   // /秒，前3天
const LAM_S2 = 1.5e-5;   // /秒，3-7天（单池近似不用，保留）
const LAM_M = 2.7e-7;    // /秒，中期
const LAM_L = 2.16e-8;   // /秒，长期
const LAM_H = 0.0578;    // /小时，情绪回归
const LAM_B = 0.0012;    // /小时，技能自然遗忘
const KQ = 0.25;
const EF_MIN = 1.3, EF_MAX = 2.5, INIT_EF = 2.5;
const DORMANT_L = 0.05;
const EDGE_W = { co_activate: 1.00, temporal: 1.20, same_day: 1.15, same_tag: 1.15, same_project: 1.25, ground: 1.25 };
const H_BASE = { sero: 0.60, dopa: 0.40, cort: 0.20, oxy: 0.50 };

const db = new DatabaseSync(DBFILE);

function nowISO() { return new Date().toISOString(); }
function ageSec(iso, now = Date.now()) { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0; }

// 档位（2026-10-31 借 plastic-memory）：被提到 3 次算 1 次强化，满 3 次强化（=9 次）升「特殊」。
// 只影响衰减速度与显示，不改库结构、不删任何一条。
function tierOf(n) { return (n.touches || 0) >= 9 ? 'special' : 'normal'; }

// 权重衰减：单池近似（0-3天 S1，之后 M，跳过 S2）；特殊档走 LAM_L，沉得慢。
function weightOf(n, now = Date.now()) {
  const age = ageSec(n.created, now);
  const w0 = (n.importance || 3) / 5;
  if (age < 3 * DAY) return w0 * Math.exp(-LAM_S1 * age);
  const lam = tierOf(n) === 'special' ? LAM_L : LAM_M;
  return w0 * Math.exp(-LAM_S1 * 3 * DAY) * Math.exp(-lam * (age - 3 * DAY));
}

// 鲜活度：w / w0，1 = 刚记住，0.1 约等于「只剩大概」。窗口不是删除线。
function freshnessOf(n, now = Date.now()) {
  const w0 = (n.importance || 3) / 5;
  return w0 ? weightOf(n, now) / w0 : 0;
}
function recencyOf(n, now = Date.now()) { return Math.exp(-LAM_M * ageSec(n.created, now)); }
function salienceOf(n) { return Math.min(1, Math.max(0, ((n.importance || 3) - 3) / 2)); }

// ---- 中文二元组 ----
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}
function noteText(n) { return `${n.title} ${n.tags} ${n.body}`; }

// ---- 初始化 ----
function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      a TEXT NOT NULL, b TEXT NOT NULL, kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0, last_seen TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (a, b, kind));
    CREATE INDEX IF NOT EXISTS idx_edges_a ON edges(a);
    CREATE INDEX IF NOT EXISTS idx_edges_b ON edges(b);

    CREATE TABLE IF NOT EXISTS recall_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      query TEXT NOT NULL,
      hits TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'graph',
      settled INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_recall_settled ON recall_event(settled);

    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      desc TEXT NOT NULL,
      L REAL NOT NULL DEFAULT 0.30,
      I REAL NOT NULL DEFAULT 0,
      EF REAL NOT NULL DEFAULT 2.5,
      last_used TEXT NOT NULL DEFAULT '');

    CREATE TABLE IF NOT EXISTS hormones (
      k TEXT PRIMARY KEY, v REAL NOT NULL, updated TEXT NOT NULL DEFAULT '');
  `);
  for (const [k, v] of Object.entries(H_BASE)) {
    db.prepare('INSERT OR IGNORE INTO hormones (k, v, updated) VALUES (?,?,?)').run(k, v, nowISO());
  }
  console.log('表已就绪：edges / recall_event / skills / hormones');
}

// ---- 冷启动连边 ----
function link(a, b, kind) {
  if (!a || !b || a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  const w = EDGE_W[kind] || 1.0;
  const row = db.prepare('SELECT weight FROM edges WHERE a=? AND b=? AND kind=?').get(x, y, kind);
  if (row) {
    db.prepare('UPDATE edges SET last_seen=? WHERE a=? AND b=? AND kind=?').run(nowISO(), x, y, kind);
  } else {
    db.prepare('INSERT INTO edges (a,b,kind,weight,last_seen) VALUES (?,?,?,?,?)').run(x, y, kind, w, nowISO());
  }
}

function seed() {
  const notes = db.prepare('SELECT id,title,tags,body,importance,created FROM notes').all();
  let n = 0;
  const before = db.prepare('SELECT COUNT(*) c FROM edges').get().c;

  // 同标签
  const byTag = new Map();
  for (const t of notes) {
    for (const tag of String(t.tags || '').split(/[,，、;；\s]+/).filter(Boolean)) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(t.id);
    }
  }
  for (const ids of byTag.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) { link(ids[i], ids[j], 'same_tag'); n++; }
  }

  // 同一天
  const byDay = new Map();
  for (const t of notes) {
    const d = String(t.created || '').slice(0, 10);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t.id);
  }
  for (const ids of byDay.values()) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) { link(ids[i], ids[j], 'same_day'); n++; }
  }

  const after = db.prepare('SELECT COUNT(*) c FROM edges').get().c;
  console.log(`冷启动：处理 ${n} 对，边从 ${before} 增到 ${after}`);
}

// ---- 检索（只读，写 recall_event）----
function recall(query, topN = 6) {
  const notes = db.prepare('SELECT id,title,tags,body,importance,created,touches,last_touch FROM notes').all();
  if (!notes.length) { console.log('库里没有记忆'); return; }

  const qb = [...bigrams(query)];
  if (!qb.length) { console.log('查询太短'); return; }

  // idf：全库稀有度
  const df = new Map();
  for (const n of notes) {
    const nb = bigrams(noteText(n));
    for (const g of qb) if (nb.has(g)) df.set(g, (df.get(g) || 0) + 1);
  }
  const N = notes.length;
  const idf = g => Math.log((N + 1) / ((df.get(g) || 0) + 1)) + 0.05;

  const scored = [];
  for (const n of notes) {
    const nb = bigrams(noteText(n));
    let hit = 0, wsum = 0, total = 0;
    for (const g of qb) {
      const w = idf(g); total += w;
      if (nb.has(g)) { hit++; wsum += w; }
    }
    if (!hit) continue;
    const sim = total ? wsum / total : 0;            // 稀有词加权的字面命中
    const cover = hit / qb.length;                   // 朴素覆盖率
    const w_n = weightOf(n);
    const rec = recencyOf(n);
    const base = (0.30 * sim + 0.30 * cover + 0.30 * w_n + 0.10 * rec) * (0.5 + salienceOf(n));
    scored.push({ n, base, sim, cover, w_n });
  }
  scored.sort((a, b) => b.base - a.base);

  // 扩散一步
  const seeds = scored.slice(0, 3);
  const pot = new Map();
  for (const s of seeds) pot.set(s.n.id, s.base);
  const boost = new Map();
  for (const s of seeds) {
    // 种子自己也吃一份，免得直接命中被扩散出去的邻居压过
    boost.set(s.n.id, Math.max(boost.get(s.n.id) || 0, s.base));
    const edges = db.prepare('SELECT a,b,weight FROM edges WHERE a=? OR b=?').all(s.n.id, s.n.id);
    for (const e of edges) {
      const other = e.a === s.n.id ? e.b : e.a;
      const p = s.base * 0.75 * e.weight;
      if (p >= 0.05) boost.set(other, Math.max(boost.get(other) || 0, p));
    }
  }

  const out = scored.map(s => {
    const region = 1 + 0.3 * (boost.get(s.n.id) || 0);
    return { ...s, region, final: s.base * region };
  }).sort((a, b) => b.final - a.final).slice(0, topN);

  // v1：扩散只给「已命中」的条目加权，不新引入条目。
  // 新引入条目需要真正的个性化 PageRank，等第一版跑稳再加。

  db.prepare('INSERT INTO recall_event (ts,query,hits,source) VALUES (?,?,?,?)')
    .run(nowISO(), query, JSON.stringify(out.slice(0, topN).map(o => o.n.id)), 'graph');

  for (const o of out.slice(0, topN)) {
    const tag = o.via ? ' [扩散]' : '';
    const sp = tierOf(o.n) === 'special' ? ' [特殊]' : '';
    console.log(`${o.final.toFixed(4)}  ${o.n.id}  ${o.n.title}${tag}${sp}`);
    console.log(`         w=${o.w_n.toFixed(4)} sim=${o.sim.toFixed(2)} cover=${o.cover.toFixed(2)} 用了${o.n.touches}次 鲜活${freshnessOf(o.n).toFixed(2)}`);
  }
}

// ---- 挑一条「刚沉下去」的 ----
function dormant() {
  const notes = db.prepare('SELECT id,title,tags,body,importance,created,touches,last_touch FROM notes').all();
  const cand = notes
    .map(n => ({ n, w: weightOf(n) }))
    .filter(x => x.w >= 0.002 && x.w < 0.02 && (x.n.importance || 3) >= 4 && tierOf(x.n) !== 'special')
    .sort((a, b) => b.w - a.w);
  let pick;
  if (cand.length) {
    pick = cand[0];
  } else {
    // 库还年轻，归档带是空的：退回「重要 + 最久没被碰」
    const fb = notes
      .filter(n => (n.importance || 3) >= 4)
      .map(n => ({ n, w: weightOf(n) }))
      .sort((a, b) => String(a.n.last_touch || a.n.created).localeCompare(String(b.n.last_touch || b.n.created)));
    if (!fb.length) { console.log('没有可提的旧事'); return; }
    pick = fb[0];
    console.log('（归档带还空，退回「重要且最久没碰」）');
  }
  console.log(`${pick.n.id}  w=${pick.w.toFixed(4)}  ${pick.n.title}`);
  console.log(pick.n.body);
}

// ---- 批量结算 ----
function tick() {
  const rows = db.prepare('SELECT id,ts,query,hits FROM recall_event WHERE settled=0').all();
  let touched = 0;
  for (const r of rows) {
    let ids = [];
    try { ids = JSON.parse(r.hits || '[]'); } catch { ids = []; }
    for (const id of ids) {
      const n = db.prepare('SELECT touches FROM notes WHERE id=?').get(id);
      if (!n) continue;
      db.prepare('UPDATE notes SET touches=?, last_touch=? WHERE id=?').run((n.touches || 0) + 1, r.ts, id);
      touched++;
    }
    db.prepare('UPDATE recall_event SET settled=1 WHERE id=?').run(r.id);
  }

  // 技能衰减
  const now = Date.now();
  const skills = db.prepare('SELECT * FROM skills').all();
  for (const s of skills) {
    if (!s.last_used) continue;
    const dt = (now - Date.parse(s.last_used)) / 3600000; // 小时
    if (dt <= 0) continue;
    const lam = LAM_B * Math.pow(1.0 / Math.max(s.I || 1, 1.0), 0.3);
    const L = Math.max(0, Math.min(1, s.L * Math.exp(-lam * dt)));
    db.prepare('UPDATE skills SET L=? WHERE name=?').run(L, s.name);
  }

  // 激素回归
  const hs = db.prepare('SELECT * FROM hormones').all();
  for (const h of hs) {
    const base = H_BASE[h.k];
    if (base === undefined || !h.updated) continue;
    const dt = (now - Date.parse(h.updated)) / 3600000;
    const v = base + (h.v - base) * Math.exp(-LAM_H * dt);
    db.prepare('UPDATE hormones SET v=?, updated=? WHERE k=?').run(v, new Date(now).toISOString(), h.k);
  }

  console.log(`结算：${rows.length} 条检索、${touched} 次命中；技能 ${skills.length} 项、激素 ${hs.length} 维已回归`);
}

// ---- 技能 ----
function skill(sub, a, b) {
  if (sub === 'list') {
    const rows = db.prepare('SELECT * FROM skills ORDER BY L DESC').all();
    if (!rows.length) { console.log('还没有技能，用 add 登记'); return; }
    for (const s of rows) {
      const flag = s.L < DORMANT_L ? ' [休眠]' : '';
      console.log(`${s.name}  L=${s.L.toFixed(3)} I=${s.I} EF=${s.EF.toFixed(2)}${flag}  ${s.desc}`);
    }
    return;
  }
  if (sub === 'add') {
    db.prepare('INSERT OR REPLACE INTO skills (name,desc,L,I,EF,last_used) VALUES (?,?,?,?,?,?)')
      .run(a, b || '', 0.30, 0, INIT_EF, '');
    console.log(`登记技能：${a}`);
    return;
  }
  if (sub === 'hit') {
    // Q 只用外部信号：肯定 5 / 否定 1 / 无反馈 3
    const Q = Math.max(0, Math.min(5, Number(b)));
    const s = db.prepare('SELECT * FROM skills WHERE name=?').get(a);
    if (!s) { console.log('没有这个技能'); return; }
    const I = s.I || 0;
    let EF = s.EF;
    if (Q >= 3) EF = s.EF + (0.1 - (5 - Q) * (0.08 + (5 - Q) * 0.02));
    else EF = s.EF + (0.1 - (5 - Q) * (0.08 + (5 - Q) * 0.02));
    EF = Math.max(EF_MIN, Math.min(EF_MAX, EF));
    const I_new = Q >= 3 ? (I === 0 ? 1 : I === 1 ? 6 : I * EF) : 1;
    // 原式对 Q<3 也加分，练废了反而涨熟练度。改成失败打折。
    const L_new = Q >= 3
      ? Math.min(1.0, s.L + KQ * (Q / 5.0) * ((1 - s.L) / (1 + 0.05 * I)))
      : Math.max(0, s.L * 0.75);
    db.prepare('UPDATE skills SET L=?, I=?, EF=?, last_used=? WHERE name=?')
      .run(L_new, I_new, EF, nowISO(), a);
    console.log(`${a}: Q=${Q}  L ${s.L.toFixed(3)}→${L_new.toFixed(3)}  I ${I}→${I_new.toFixed(1)}  EF ${s.EF.toFixed(2)}→${EF.toFixed(2)}`);
    return;
  }
  console.log('skill 子命令：list | add <name> <desc> | hit <name> <Q>');
}

function stats() {
  const q = s => db.prepare(s).get();
  console.log('notes      ', q('SELECT COUNT(*) c FROM notes').c);
  console.log('edges      ', q('SELECT COUNT(*) c FROM edges').c);
  console.log('recall_evt ', q('SELECT COUNT(*) c FROM recall_event').c, '未结算', q('SELECT COUNT(*) c FROM recall_event WHERE settled=0').c);
  console.log('skills     ', q('SELECT COUNT(*) c FROM skills').c);
  const byKind = db.prepare('SELECT kind, COUNT(*) c FROM edges GROUP BY kind ORDER BY c DESC').all();
  console.log('边类型     ', byKind.map(r => `${r.kind}:${r.c}`).join('  '));
}

// ---- CLI ----
const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'init': init(); break;
    case 'seed': init(); seed(); break;
    case 'recall': recall(rest.join(' ')); break;
    case 'dormant': dormant(); break;
    case 'tick': tick(); break;
    case 'skill': skill(rest[0], rest[1], rest.slice(2).join(' ')); break;
    case 'stats': stats(); break;
    default:
      console.log('用法：init | seed | recall <词> | dormant | tick | skill list|add|hit | stats');
  }
} finally {
  db.close();
}
