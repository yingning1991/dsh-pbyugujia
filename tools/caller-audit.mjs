#!/usr/bin/env node
/**
 * caller-audit.mjs —— 「落地了，但没人调用」（2026-11-19 建，用户当天问的）
 *
 * 起因：巩固段写进 tasks/06，可那张卡没有定时任务在跑——等于没落地。
 * 用户那句判据是：「写完不算，得挂在一个每天/每周会跑的动作上」。
 *
 * 用法：
 *   node tools/caller-audit.mjs            # 近 7 天
 *   node tools/caller-audit.mjs --days 30
 *   node tools/caller-audit.mjs --all      # 列出所有只在笔记里的
 *
 * 判据（三档）：
 *   ① 流程调用：被 tasks/、~/.dsh/skills/、AGENTS.md、CORE.md、出片等卡提到，或定时 prompt 里有，或别的工具 import/调用 → 算挂上了
 *   ② 只在笔记：只在 notes/ learnings/ journal/ 里出现 → **这就是「写了落地、没有会跑的动作叫它」**
 *   ③ 完全没人叫：哪儿都没有
 *
 * 口径限制（别当全知）：只查「名字有没有被提到」，不查「提到的那次真的跑了吗」——后者看 claim-audit。
 * 一次性评估脚本（*eval* / *test*）单独归一档：它们本来就该是一次性，不算欠账。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = path.resolve(import.meta.dirname, '..');
const HOME = process.env.HOME || os.homedir();
const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const DAYS = num('--days', 7);
const ALL = argv.includes('--all');
const since = Date.now() - DAYS * 864e5;

const base = (f, dir) => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs });
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const read = (p) => fs.readFileSync(p, 'utf8');

// 近 N 天动过的工具
const tools = fs.readdirSync(path.join(BASE, 'tools'))
  .filter((f) => !f.startsWith('.') && /\.(mjs|js|py)$/.test(f))
  .map((f) => base(f, 'tools'))
  .filter((x) => x.m >= since);

// 会跑的动作组成的语料
const flow = [];
const addFlow = (p) => { if (exists(p)) flow.push({ p, txt: read(p) }); };
const tasksDir = path.join(BASE, 'tasks');
for (const f of fs.readdirSync(tasksDir)) {
  if (!f.endsWith('.md') || f.includes('.bak')) continue;
  addFlow(path.join(tasksDir, f));
}
const skillDir = path.join(HOME, '.dsh', 'skills');
if (fs.existsSync(skillDir)) for (const d of fs.readdirSync(skillDir)) addFlow(path.join(skillDir, d, 'SKILL.md'));
addFlow(path.join(HOME, '.dsh', 'AGENTS.md'));
addFlow(path.join(BASE, 'CORE.md'));
addFlow(path.join(BASE, 'know', 'INDEX.md'));
addFlow(path.join(BASE, 'know', 'PORTABLE.md'));

// 定时任务 prompt：取最新清单
let prompts = '';
const tmp = path.join(BASE, 'out', 'tmp');
if (fs.existsSync(tmp)) {
  const slim = fs.readdirSync(tmp).filter((f) => /^jobs-slim-.*\.json$/.test(f)).sort().pop();
  if (slim) { try { prompts = JSON.parse(read(path.join(tmp, slim))).map((x) => x.prompt || '').join('\n'); } catch {} }
}

const notes = [];
for (const d of ['notes', 'learnings', 'journal']) {
  for (const f of fs.readdirSync(path.join(BASE, d))) {
    const p = path.join(BASE, d, f);
    if (exists(p) && /\.(md|json)$/.test(f)) notes.push({ p, txt: read(p) });
  }
}
const src = fs.readdirSync(path.join(BASE, 'tools'))
  .filter((f) => /\.(mjs|js|py)$/.test(f))
  .map((f) => ({ p: 'tools/' + f, txt: read(path.join(BASE, 'tools', f)) }));

const hit = (name, corpus) => corpus.filter((c) => c.p !== name && !c.p.endsWith('/' + name) && c.txt.includes(name)).map((c) => c.p);
const oneOff = (f) => /(eval|test|pilot\d*)/i.test(f);

const buckets = { flow: [], notes: [], orphan: [], oneoff: [] };
for (const x of tools) {
  let h = hit(x.f, flow).concat(hit(x.f, src));
  if (prompts.includes(x.f)) h.push('定时prompt');
  if (h.length) { buckets.flow.push({ f: x.f, h }); continue; }
  const n = hit(x.f, notes);
  if (!n.length) buckets.orphan.push({ f: x.f });
  else if (oneOff(x.f)) buckets.oneoff.push({ f: x.f, h: n });
  else buckets.notes.push({ f: x.f, h: n });
}

console.log(`近 ${DAYS} 天动过的工具 ${tools.length} 个：流程调用 ${buckets.flow.length}｜只在笔记 ${buckets.notes.length}｜一次性评估 ${buckets.oneoff.length}｜没人叫 ${buckets.orphan.length}`);
console.log('\n✗ 只在笔记里（写了落地、没有会跑的动作叫它）：');
for (const o of buckets.notes) console.log(`  · ${o.f}  ← ${o.h.slice(0, 2).join(', ')}`);
if (ALL) {
  console.log('\n（一次性评估脚本，不算欠账）：');
  for (const o of buckets.oneoff) console.log(`  · ${o.f}`);
}
if (buckets.orphan.length) {
  console.log('\n✗ 完全没人叫：');
  for (const o of buckets.orphan) console.log(`  · ${o.f}`);
}
if (!buckets.notes.length && !buckets.orphan.length) console.log('\n✅ 都挂上了。');

// ───────── v2（2026-11-19 当天加）：提到 ≠ 会执行 ─────────
// 用户问「这样以后就不会被丢下了吧」——不能这么说。所以再出两份数：
//   ② 只被文字提到（卡里写了名字但没有 `node tools/X` 这样的可执行行）
//   ③ 卡 × 定时任务对账（有多少卡根本没有任何定时任务点名）
const execRe = /(?:node|python3?|bash)\s+(?:[\w./~-]*\/)?tools\/([\w.-]+\.(?:mjs|js|py))/g;
const execSet = new Set();
for (const c of flow) {
  let m; execRe.lastIndex = 0;
  while ((m = execRe.exec(c.txt))) if (!c.p.endsWith(m[1])) execSet.add(m[1]);
}
const textOnly = tools.map((x) => x.f).filter((f) => !execSet.has(f));
if (textOnly.length) {
  console.log(`\n② 只被文字提到、没有可执行行（提到 ≠ 会执行）：${textOnly.length} 个`);
  for (const f of textOnly) console.log(`  · ${f}`);
}
const scheduled = new Set();
for (const m of prompts.matchAll(/tasks\/([^\s"）]+\.md)/g)) scheduled.add(m[1]);
const cards = fs.readdirSync(path.join(BASE, 'tasks')).filter((f) => f.endsWith('.md') && !f.includes('.bak'));
const unsched = cards.filter((c) => !scheduled.has(c));
console.log(`\n③ 卡 × 定时任务：盘上 ${cards.length} 张，被定时点名 ${cards.length - unsched.length} 张，没点名 ${unsched.length} 张（不一定是缺，历史/按需/SOP 都算）`);
console.log('  ' + unsched.join(' '));
