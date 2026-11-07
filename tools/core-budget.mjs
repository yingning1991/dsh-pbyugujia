#!/usr/bin/env node
/** core-budget.mjs —— CORE 注入预算核对（按「字符」，不是字节）
 *
 * 用法：
 *   node tools/core-budget.mjs                  # 默认读 ./CORE.md，上限 6000 字符
 *   node tools/core-budget.mjs --file CORE.md --max 6000
 *   node tools/core-budget.mjs --json           # 给脚本用
 *
 * 为什么要它（2026-11-07 踩的坑）：
 *   自检量的是 6643/6656 **字节**，以为还剩 13；插件按 **2600 字符**截断，
 *   实际超了 131 字符——当天新加的那条静默没进注入，谁都没发现。
 *   单位错了，护栏就是装饰。
 *
 * 退出码：0 正常；1 超限 / 文件不存在。
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const file = flag('--file', 'CORE.md');
const max = Number(flag('--max', '6000'));
const asJson = args.includes('--json');

let text = '';
try { text = fs.readFileSync(file, 'utf8'); }
catch { console.error(`读不到 ${file}`); process.exit(1); }

// 按字符数（码点）算，与插件的 String.length 口径一致；中文、emoji 都不虚胖。
const chars = Array.from(text).length;
const margin = max - chars;
const pct = max > 0 ? Math.round((chars / max) * 100) : 0;

if (asJson) {
  console.log(JSON.stringify({ file, chars, max, margin, percent: pct, over: margin < 0 }));
} else {
  console.log(`${file}: ${chars} 字符 / 上限 ${max}（${pct}%），余量 ${margin}`);
  if (margin < 0) console.error(`超出 ${-margin} 字符——超出部分不会进注入，先合并或替换，别只加。`);
}
process.exit(margin < 0 ? 1 : 0);
