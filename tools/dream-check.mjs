#!/usr/bin/env node
/** dream-check.mjs —— 「做梦」这一步：每天抽一条记忆，回原始会话核一遍。
 *
 * 2026-11-12 建。来源：Anthropic《The components of agent memory》里的 Dreaming
 * （https://www.anthropic.com/research/components-of-agent-memory，B站 BV1KoW16NEBf 讲了一遍）；
 * 借它的**回查**，不借它造 Wiki。我们早就有原话库（chat/chat.db）和 supersedes，缺的是定时那一步。
 *
 * 用法：
 *   node tools/dream-check.mjs             # 抽下一条，出核对包（不调模型）
 *   node tools/dream-check.mjs --list      # 看队列
 *   node tools/dream-check.mjs --mark ok   # 核完：一致
 *   node tools/dream-check.mjs --mark fixed# 核完：改过了（改条由 fish_remember 挂 supersedes）
 *
 * 判据：只核「能被原话证实/推翻」的条目；印象类、审美类不进队列。
 * 状态：out/dream-state.json（id → 核过日期 + 结论），同一条 30 天不复核。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pbyugujia');
const MEM = join(DIR, 'memory.db');
const CHAT = join(DIR, 'chat/chat.db');
const STATE = join(DIR, 'out/dream-state.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const mem = new DatabaseSync(MEM, { readOnly: true });

const live = mem.prepare(`select id,title,body,kind,created,touches,importance from notes
  where coalesce(superseded_by,'')='' and coalesce(valid_to,'')=''`).all();

const days = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const COLD = 3;      // 三天内的记忆还在手上，不复核
const RECHECK = 30;  // 核过的 30 天不进队列

const queue = live
  .filter((n) => days(n.created) >= COLD)
  .filter((n) => {
    const s = state[n.id];
    if (!s) return true;
    return (Date.now() - new Date(s.checked).getTime()) / 86400000 >= RECHECK;
  })
  .sort((a, b) => (state[a.id] ? 1 : 0) - (state[b.id] ? 1 : 0) || String(a.created).localeCompare(String(b.created)));

if (has('--list')) {
  console.log(`队列 ${queue.length} 条（冷 ${COLD} 天、复核 ${RECHECK} 天）`);
  for (const n of queue.slice(0, 12)) console.log(`  ${n.created.slice(0, 10)}  ${n.id}  ${n.title.slice(0, 50)}`);
  process.exit(0);
}

const pick = queue[0];
if (!pick) { console.log('队列空了：所有记忆都在 30 天内核过。'); process.exit(0); }

// 从标题抽检索词：去掉【…】标记，中文按 2–4 字切，英文按词
const title = String(pick.title).replace(/【[^】]*】/g, ' ');
// 取「有辨识度」的词：先技术词（ASCII），再三字词，最后才二元组
const terms = [];
for (const w of title.match(/[a-zA-Z_][a-zA-Z0-9_.-]{2,}/g) || []) terms.push(w);
const han = title.replace(/[^\u4e00-\u9fff]/g, ' ');
for (const run of han.split(/\s+/).filter((x) => x.length >= 3)) {
  for (let i = 0; i + 3 <= run.length && terms.length < 10; i++) terms.push(run.slice(i, i + 3));
}
const kws = [...new Set(terms)].slice(0, 8);

const createdDay = String(pick.created).slice(0, 10);
const d = new Date(pick.created);
const lo = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
const hi = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);

const chat = new DatabaseSync(CHAT, { readOnly: true });
const rows = chat.prepare(`select sid,seq,day,role,text from msgs
  where day >= ? and day <= ? and role in ('user','assistant')`).all(lo, hi);

// 每个词有多常见：到处都有的词（大肥鱼、记忆）不算证据
const df = new Map();
for (const k of kws) df.set(k, rows.reduce((n, r) => n + (String(r.text).includes(k) ? 1 : 0), 0));
const rare = kws.filter((k) => df.get(k) <= Math.max(8, rows.length * 0.03));

const scored = rows.map((r) => {
  const t = String(r.text);
  let hit = 0, rareHit = 0;
  for (const k of kws) if (t.includes(k)) hit++;
  for (const k of rare) if (t.includes(k)) rareHit++;
  return { ...r, hit, rareHit };
}).filter((r) => r.rareHit >= 2 || (rare.length < 2 && r.hit >= 2))
  .sort((a, b) => b.rareHit - a.rareHit || b.hit - a.hit).slice(0, 6);

// 只取命中词附近，别整段塞——噪声会把判断挤掉
const cut = (t) => {
  const flat = t.replace(/\s+/g, ' ');
  let at = -1;
  for (const k of rare) { const i = flat.indexOf(k); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, 260);
  const a = Math.max(0, at - 70);
  return (a > 0 ? '…' : '') + flat.slice(a, at + 190);
};

console.log(`# 做梦核对 · ${new Date().toISOString().slice(0, 10)}`);
console.log(`\n## 记忆 [${pick.id}] ${pick.title}`);
console.log(`写入 ${pick.created.slice(0, 16)} · ${pick.kind} · 被想起 ${pick.touches} 次`);
console.log(`\n${String(pick.body).replace(/\n+/g, '\n').slice(0, 900)}`);
console.log(`\n## 当时的原话（${lo} ~ ${hi}，命中 ${scored.length} 条）`);
if (!scored.length) console.log('— 没找到含关键词的原话：可能是标题措辞与当时说法差太远，先 `fish_thread` 手查。');
for (const r of scored) console.log(`- [${r.day} ${r.sid.slice(0, 8)}#${r.seq} ${r.role}] ${cut(r.text)}`);

// 之后有没有改口：这比「当天原话」更接近 Dreaming 的本意——找后人自己推翻自己的时候
const after = String(pick.created).slice(0, 19);
const corr = chat.prepare(`select sid,seq,day,role,text from msgs
  where role in ('user','assistant') and ts > ? and (text like '%更正%' or text like '%其实%'
  or text like '%改口%' or text like '%不对%' or text like '%纠正%' or text like '%错了%' or text like '%不是…而是%')`).all(new Date(pick.created).getTime());
const corrHits = corr.map((r) => {
  const t = String(r.text);
  let hit = 0; for (const k of rare) if (t.includes(k)) hit++;
  return { ...r, hit };
}).filter((r) => r.hit >= 2).sort((a, b) => b.hit - a.hit).slice(0, 4);
console.log(`\n## 之后有没有改口（写入后的会话，同一批罕见词 + 改口信号：${corrHits.length} 条）`);
if (!corrHits.length) console.log('— 没找到。没有 ≠ 没错，只说明这段原话里没出现「更正/其实/不对」这类词。');
for (const r of corrHits) console.log(`- [${r.day} ${r.role}] ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`);

console.log(`\n## 三问（照 Anthropic 的口径）`);
console.log('1. 当时为什么这么定？原话里有没有另一面？');
console.log('2. 下一步做了什么——这条记忆有没有让动作真的变过？');
console.log('3. 哪个条件变了要改口？');
console.log('\n## 判完怎么记');
console.log(`- 一致：node tools/dream-check.mjs --mark ok`);
console.log(`- 有一处偏：fish_remember 挂 supersedes=[${pick.id}] 改条，然后 --mark fixed`);

if (has('--mark')) {
  const v = val('--mark');
  if (!['ok', 'fixed'].includes(v)) { console.error('--mark 只认 ok / fixed'); process.exit(2); }
  state[pick.id] = { checked: new Date().toISOString(), verdict: v };
  writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
  console.log(`\n已记：${pick.id} → ${v}`);
}
