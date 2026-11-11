#!/usr/bin/env node
/**
 * core-budget.mjs —— 注入预算仪表（2026-11-10 建，主理人问「以后还会再满，有没有办法未雨绸缪」）
 *
 * 为什么有它：CORE 6000 字符是每轮注入的硬上限，selfaudit 只在跑全量审计时看一次。
 * 这条命令专门盯一个数：还能装多少、哪节在膨胀、照这个速度还能撑几天。
 *
 * 依据（2026-11-10 查）：
 * - Lost in the Middle（Liu et al., TACL 2024）：长上下文里中间位置的信息最容易被忽略，U 型曲线。
 * - Aider 作者实测：超过 ~25-30k token 模型开始不听系统提示——我们 6000 字符远未到，但趋势要看。
 * - Hebrew University 2025：同样 token 数下，文档数少反而好 10-20%（「给得少而准」）。
 * - diffray 综：context 要像 OS 管内存——预算、压缩、分页。
 * 结论：不是「越多越好」，是「每轮都付钱、每轮都占注意力」。所以要有仪表，不是等撞墙。
 *
 * 用法：
 *   node tools/core-budget.mjs           # 一行
 *   node tools/core-budget.mjs --report  # 各节 + 增速 + 建议
 *   node tools/core-budget.mjs --json
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'pbyugujia') : join(homedir(), '.dsh', 'pbyugujia');
const CORE = join(DIR, 'CORE.md');
const LIMIT = 6000;
if (!existsSync(CORE)) { console.log('没有 CORE.md：' + CORE); process.exit(2); }

const raw = readFileSync(CORE, 'utf8');
const chars = (s) => [...s].length;
const total = chars(raw);

// 分节
const body = raw.split(/^## /m);
const head = body.shift();
const sections = body.map((p) => ({
  name: p.split('\n')[0].trim(),
  n: chars('## ' + p),
})).sort((a, b) => b.n - a.n);

// 增速：拿 .bak 文件的时间与大小当历史采样
const samples = [];
const files = readdirSync(DIR).filter((f) => /^CORE\.md(\.bak.*)?$/.test(f));
for (const f of files) {
  try {
    const st = statSync(join(DIR, f));
    samples.push({ f, t: st.mtimeMs, n: chars(readFileSync(join(DIR, f), 'utf8')) });
  } catch {}
}
samples.sort((a, b) => a.t - b.t);
const now = Date.now();
const week = samples.filter((s) => now - s.t < 7 * 86400000);
let perDay = null;
// 至少跨 3 天才算趋势；同一天的多次备份会把这个数放大成假象（两个样本不叫规律）
if (week.length >= 2 && (week[week.length - 1].t - week[0].t) / 86400000 >= 3) {
  const first = week[0], last = week[week.length - 1];
  const days = (last.t - first.t) / 86400000;
  perDay = (last.n - first.n) / days;
}
const room = LIMIT - total;
const pct = (total / LIMIT) * 100;
const over = total >= LIMIT;
const warn = pct >= 90 ? '🔴' : pct >= 80 ? '🟡' : '🟢';

const mode = process.argv.includes('--json') ? 'json'
  : process.argv.includes('--report') ? 'report' : 'line';

if (mode === 'json') {
  console.log(JSON.stringify({ total, limit: LIMIT, room, pct: +pct.toFixed(1), sections, perDay, samples: samples.map(s => s.f) }, null, 1));
  process.exit(0);
}

if (mode === 'line') {
  const biggest = sections[0];
  const trend = perDay === null ? '增速样本不足（需跨 3 天）'
    : perDay > 0 ? `近 7 天净增 +${perDay.toFixed(0)}/天`
    : `近期在减（${perDay.toFixed(0)}/天）`;
  console.log(`${warn} CORE ${total}/${LIMIT}（${pct.toFixed(0)}%，余 ${room}）｜最大节 ${biggest.name.slice(0, 8)} ${biggest.n}｜${trend}`);
  process.exit(0);
}

// report
console.log(`# 注入预算 ${new Date().toISOString().slice(0, 10)}`);
console.log(`${warn} ${total} / ${LIMIT} 字符（${pct.toFixed(0)}%），余 ${room}`);
console.log(`\n## 各节（大 → 小）\n`);
for (const s of sections) {
  const bar = '█'.repeat(Math.max(0, Math.round((s.n / total) * 40)));
  console.log(`${String(s.n).padStart(5)} ${bar} ${s.name}`);
}
console.log(`\n## 增速`);
if (perDay === null) console.log('- 历史样本不足两条，先攒几天');
else {
  console.log(`- 近 7 天平均 ${perDay >= 0 ? '+' : ''}${perDay.toFixed(0)} 字符/天`);
  if (perDay > 0) console.log(`- 粗估：余 ${room} 字符 ≈ ${(room / perDay).toFixed(1)} 天的新增量。这不是倒计时——每次撞墙压一轮就回落；它的用处是「从今天起，新增要挑剔一点」`);
}
console.log(`\n## 快满时怎么办（按代价从低到高）`);
console.log('- 先问：这条真需要每轮都看吗？不需要 → 挪 tasks/ 或 notes/（用到才读）。');
console.log('- 再问：有没有现成的一条能替代？有 → 合并，别新增。');
console.log('- 最后压措辞：来源故事、例子、重复判据都能砍，动作不能砍。');
console.log('- 压完必须核「动作没丢」：跑 selfaudit 的 K 项，再 grep 关键命令名。');
console.log(`\n## 已知的大头`);
console.log(`- ${sections[0].name}：${sections[0].n} 字符。真要腾地方，从这里下手最快。`);
