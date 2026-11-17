// cost.mjs —— 唯一权威账本：按 DeepSeek 官方时段价算钱。
//
// 官方价（2026-11-02 查证，https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
// deepseek-flash（百万 tokens）：
//   缓存命中输入   空闲 0.02 元 / 高峰 0.04 元
//   缓存未命中输入 空闲 1 元   / 高峰 2 元
//   输出           空闲 4 元   / 高峰 8 元
// 高峰时段：北京时间 周一至周五 9:00–12:00、14:00–18:00（不含法定节假日）；其余全部空闲（半价）。
//
// ⚠ 以前 usage.mjs / move-check.mjs / steps.mjs 各写一张 P 表，都是错的：
//   output 写 9.0（空闲时高估 2.25 倍）、input 写死 1.0（高峰时低估一半）、缓存命中也写死。
// 这个文件是唯一一份价表，别再在别处另写。
//
// 用法：
//   node tools/cost.mjs            今天（按空闲/高峰分别结算）
//   node tools/cost.mjs 2026-11-02 指定日期
//   node tools/cost.mjs --from 2026-11-02T16:53:25+08:00   从某时刻起

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
const UDIR = path.join(HOME, "token-usage");

// 单价表：元 / 百万 tokens
const RATE = {
  idle: { miss: 1.0, hit: 0.02, out: 4.0 },
  peak: { miss: 2.0, hit: 0.04, out: 8.0 },
};

// 是否为高峰时段（北京时间，周一至周五 9–12 / 14–18）
export function isPeak(ms) {
  const d = new Date(ms + 8 * 3600e3);           // 换算到北京时间
  const wd = d.getUTCDay();                       // 0=周日
  if (wd === 0 || wd === 6) return false;
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// 单次请求的费用（元）
export function costOf(ms, u = {}) {
  const r = isPeak(ms) ? RATE.peak : RATE.idle;
  return ((u.inputTokens || 0) * r.miss + (u.cacheReadTokens || 0) * r.hit + (u.outputTokens || 0) * r.out) / 1e6;
}

// ── CLI ──
// 包成 main()：被 ctx.mjs import 时只取 costOf，不跑 CLI、不 process.exit。
function main() {
const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? Date.parse(args[fromIdx + 1]) : 0;
const dayArg = fromIdx >= 0 ? null : (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) ? args[0] : null);
const day = dayArg || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const file = path.join(UDIR, `usage-${day}.jsonl`);
if (!fs.existsSync(file)) { console.log(`没有 ${day} 的用量记录：${file}`); process.exit(1); }

const bySess = new Map();
const tot = { n: 0, fail: 0, idle: 0, peak: 0, tok: 0, inTok: 0, cacheTok: 0 };
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (j.time < from) continue;
  const u = j.usage || {};
  tot.n++;
  if (String(j.requestId || "").startsWith("failure")) { tot.fail++; continue; }
  const c = costOf(j.time, u);
  if (isPeak(j.time)) tot.peak += c; else tot.idle += c;
  tot.tok += (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.outputTokens || 0);
  tot.inTok += (u.inputTokens || 0) + (u.cacheReadTokens || 0);
  tot.cacheTok += (u.cacheReadTokens || 0);
  const key = (j.sessionId || "?").slice(-8);
  const b = bySess.get(key) || { n: 0, cost: 0, out: 0 };
  b.n++; b.cost += c; b.out += u.outputTokens || 0;
  bySess.set(key, b);
}

const y = (n) => n.toFixed(3);
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : (n / 1e3).toFixed(0) + "k");
const sum = tot.idle + tot.peak;
console.log(`${day}${from ? `（从 ${new Date(from + 8 * 3600e3).toISOString().slice(11, 19)} 起）` : ""}`);
console.log(`  请求 ${tot.n} 次（失败 ${tot.fail}）· 共 ${k(tot.tok)} tokens`);
console.log(`  高峰 ${y(tot.peak)} 元 + 空闲 ${y(tot.idle)} 元 = ${y(sum)} 元`);
// 主理人 2026-11-06 定：看的是「单次」多少钱，不是总额——单次过 0.1 元就搬（搬家本身 < 0.1，一次回本）。
if (tot.inTok > 0) console.log(`  缓存读 ${(100 * tot.cacheTok / tot.inTok).toFixed(1)}%（占输入 token；越高说明前缀越稳）`);
if (tot.n - tot.fail > 0) console.log(`  单次均价 ${(sum / (tot.n - tot.fail)).toFixed(3)} 元（分母 ${tot.n - tot.fail} 次）${sum / (tot.n - tot.fail) >= 0.1 ? " ← 过 0.1，该搬" : ""}`);
console.log(`  （现在${isPeak(Date.now()) ? "是" : "不是"}高峰时段：周${"日一二三四五六"[new Date(Date.now() + 8 * 3600e3).getUTCDay()]} ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16)}）`);
if (tot.n) {
  const top = [...bySess.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 6);
  console.log(`\n最贵的会话：`);
  for (const [sid, b] of top) console.log(`  …${sid}  ${String(b.n).padStart(4)} 次  ${y(b.cost)} 元  次均 ${(b.cost / b.n).toFixed(3)}  输出 ${k(b.out)}`);
} // if (tot.n)
} // main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
