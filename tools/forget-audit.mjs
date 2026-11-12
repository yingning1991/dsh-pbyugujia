#!/usr/bin/env node
// forget-audit.mjs —— 记忆的「遗忘侧」体检（2026-11-05 立）
//
// 缘起：清华钟毅组 Neuron 2026-02「双印迹」模型 + eLife 2026-01 人类 7T fMRI。
//   1) 遗忘不是痕迹被抹掉，是另一群印迹细胞在主动抑制提取；抑制那群，忘掉的能取回。
//   2) 人身上也一样：忘了的东西痕迹还在，只凭「猜」也能显著好过 chance。
//   3) 所以一个记忆系统要同时管「提取」和「抑制」，只有记住没有抑制，会变成 Shank3 模型鼠：
//      忘不掉 → 认知刻板、检索噪音。
//
// 但这个工具**不自动判谁该被忘**。2026-11-05 实测：库里 137 条只有 13 条有访问痕迹
// （touches>0，占 9%），124 条的 last_touch 是空的（旧 bug 清零过）。
// 在这种可观测率下，「长期没被想起就抑制」筛出来的全是猜的——所以本工具先报事实，
// 可观测率不到一半就直接拒发候选清单，并把理由写出来（不许静默降级）。
//
// 用法：
//   node tools/forget-audit.mjs          全报告
//   node tools/forget-audit.mjs --line   一行给 22:00 复盘
//   node tools/forget-audit.mjs --json   给别的脚本吃
//
// 只读。任何标记/删除都不在这里做——抑制或删，都得我先说清理由，并且备份。

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, '..', 'memory.db');

const args = new Set(process.argv.slice(2));
const LINE = args.has('--line');
const JSONOUT = args.has('--json');

// 可观测率低于这个数，就不给候选清单（分母 100）
const OBSERVABLE_MIN = 50;
// 抑制率过高，说明可能把太多东西压掉了（分母 100）
const SUPPRESS_MAX = 40;

const db = new DatabaseSync(DB, { readOnly: true });
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);

const total = one('select count(*) c from notes').c;
const facts = one("select count(*) c from notes where kind='fact'").c;
const scenes = one("select count(*) c from notes where kind='scene'").c;
const superseded = one("select count(*) c from notes where superseded_by is not null and superseded_by<>''").c;
const expired = one("select count(*) c from notes where valid_to is not null and valid_to<>''").c;
const observed = one('select count(*) c from notes where touches>0').c;

const obsRate = total ? Math.round((observed * 100) / total) : 0;
const supRate = total ? Math.round((superseded * 100) / total) : 0;

// —— 抑制通道完整性：被取代的指向、场景条的支撑边，是否都真的存在 ——
const idSet = new Set(all('select id from notes').map((r) => r.id));

const orphanSupersede = [];
for (const r of all("select id,title,superseded_by from notes where superseded_by is not null and superseded_by<>''")) {
  for (const target of r.superseded_by.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!idSet.has(target)) orphanSupersede.push({ from: r.id, to: target, title: r.title });
  }
}

const orphanSource = [];
for (const r of all("select id,title,source_ids from notes where kind='scene' and source_ids is not null and source_ids<>''")) {
  for (const src of r.source_ids.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!idSet.has(src)) orphanSource.push({ from: r.id, to: src, title: r.title });
  }
}

// —— 候选休眠：只有可观测率达标才发 ——
let candidates = null;
if (obsRate >= OBSERVABLE_MIN) {
  candidates = all(`
    select id, title from notes
    where kind='fact'
      and (superseded_by is null or superseded_by='')
      and (valid_to is null or valid_to='')
      and touches<=1
      and importance<=2
      and last_touch is not null and last_touch<>''
      and julianday('now') - julianday(last_touch) >= 90
    order by last_touch asc limit 20
  `);
}

const report = {
  total, facts, scenes, superseded, expired, observed, obsRate, supRate,
  orphans: { supersede: orphanSupersede, source: orphanSource },
  candidates,
};

if (JSONOUT) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

const bad = orphanSupersede.length + orphanSource.length;

if (LINE) {
  const obsTxt = obsRate >= OBSERVABLE_MIN ? `可观测 ${obsRate}%` : `可观测仅 ${obsRate}%，不判休眠`;
  console.log(
    `遗忘侧：${total} 条（抑制 ${superseded} 条=${supRate}%，失效 ${expired} 条，${obsTxt}，断边 ${bad}）`
  );
  process.exit(bad ? 1 : 0);
}

console.log('=== 遗忘侧体检 ===');
console.log(`库：${total} 条（fact ${facts} / scene ${scenes}）`);
console.log(`抑制通道：${superseded} 条被取代（占 ${supRate}%）· valid_to 用过 ${expired} 条`);
console.log(`可观测率：${observed}/${total} = ${obsRate}%（touches>0）`);

if (obsRate < OBSERVABLE_MIN) {
  console.log(`  ⚠ 低于 ${OBSERVABLE_MIN}%，拒绝输出「休眠候选」——没有访问痕迹就判谁不常用，是猜的。`);
  console.log('  先修可观测性：确认 fish_recall 每次命中都写 touches/last_touch，攒够两周再说。');
} else {
  console.log(`休眠候选（90 天没被取、importance≤2）：${candidates.length} 条`);
  for (const c of candidates) console.log(`  · ${c.id} ${c.title.slice(0, 50)}`);
}

console.log('边完整性：');
if (bad === 0) {
  console.log('  ✓ 被取代的指向、场景条的支撑边，都落在库里');
} else {
  for (const o of orphanSupersede) console.log(`  ✗ ${o.from} 取代目标不存在：${o.to}`);
  for (const o of orphanSource) console.log(`  ✗ ${o.from} 支撑边不存在：${o.to}`);
}

console.log('两极：');
if (supRate > SUPPRESS_MAX) console.log(`  抑制率 ${supRate}% 偏高——可能压掉了还在用的东西，查最近的 supersedes。`);
else if (supRate === 0) console.log('  抑制率 0——一条都没被取代过，说明「改口」的通道没用上，不是好事。');
else console.log(`  抑制率 ${supRate}% 在正常区间（0–${SUPPRESS_MAX}%）。`);

process.exit(bad ? 1 : 0);
