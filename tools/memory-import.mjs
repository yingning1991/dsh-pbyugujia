#!/usr/bin/env node
/**
 * memory-import.mjs —— 把旧记忆文件扫成「候选条」，不直接写库
 *
 * 为什么只出候选：记忆的质量靠一条条判断，不靠批量导入。
 * 扫进来的是原料，落库前要过「三行」——是什么 / 什么撑着 / 何时不成立。
 *
 * 用法：
 *   node tools/memory-import.mjs --dir <旧文件目录> [--out <候选.jsonl>] [--limit 500]
 *   node tools/memory-import.mjs --dir ~/legacy --out out/import-candidates.jsonl
 *
 * 输入：目录下的 .md / .txt / .json（递归，最多 200 个文件）
 * 输出：
 *   - 候选 jsonl：每行 {source, line, title, body, why}
 *   - 屏幕统计：扫了几个文件、提了几条、跳过几行
 * 不写数据库、不改原文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const dir = get('--dir');
const outFile = get('--out', path.join(process.cwd(), 'out', 'import-candidates.jsonl'));
const limit = Number(get('--limit', '500')) || 500;

if (!dir) {
  console.error('用法：node tools/memory-import.mjs --dir <旧文件目录> [--out 候选.jsonl]');
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.error(`目录不存在：${dir}`);
  process.exit(2);
}

// 像「长期事实」的行：带日期、偏好、约定、决定、身体、习惯、喜好
const KEEP = [
  /20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/,
  /(喜欢|讨厌|不爱|爱吃|不吃|习惯|总是|每次|从来不|偏好|在意|受不了)/,
  /(决定|约定|说好|答应|以后|下次|从今|规矩|红线|不许|必须)/,
  /(早上|晚上|睡前|饭|功|身体|睡|醒|咳|疼|胃|血压)/,
  /(我的名字|叫我|称呼|叫我什么)/,
];
// 明显不是记忆的：代码、链接、表格分隔、纯标题、太短
const DROP = [
  /^\s*(```|~~~)/,
  /^\s*\|/,
  /^\s*[-*]\s*\[[ x]\]/,
  /https?:\/\//,
  /^\s*#+\s*$/,
];

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (acc.length >= 200) break;
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'out', 'trash'].includes(e.name)) continue;
      walk(p, acc);
    } else if (/\.(md|txt|json|jsonl)$/i.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function linesOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.jsonl$/i.test(file)) {
    const rows = [];
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        const t = o.title || o.name || '';
        const b = o.body || o.content || o.text || '';
        if (b) rows.push({ line: t ? `${t}｜${b}` : b, raw: ln });
      } catch { /* 不是 json 行，忽略 */ }
    }
    return rows;
  }
  if (/\.json$/i.test(file)) {
    try {
      const o = JSON.parse(raw);
      const flat = [];
      const dig = (v, depth = 0) => {
        if (depth > 3 || v == null) return;
        if (typeof v === 'string') { if (v.trim()) flat.push({ line: v.trim(), raw: v }); }
        else if (Array.isArray(v)) v.forEach((x) => dig(x, depth + 1));
        else if (typeof v === 'object') Object.values(v).forEach((x) => dig(x, depth + 1));
      };
      dig(o);
      return flat;
    } catch { return []; }
  }
  return raw.split('\n').map((ln) => ({ line: ln, raw: ln }));
}

const files = walk(dir);
const candidates = [];
let scanned = 0;

for (const f of files) {
  scanned++;
  for (const { line } of linesOf(f)) {
    const t = line.replace(/^\s*[-*+]\s*/, '').replace(/^#+\s*/, '').trim();
    if (t.length < 8 || t.length > 400) continue;
    if (DROP.some((re) => re.test(line))) continue;
    if (!KEEP.some((re) => re.test(t))) continue;
    candidates.push({
      source: path.relative(dir, f),
      title: t.slice(0, 40),
      body: t,
      why: '含日期/偏好/约定/身体线关键词',
    });
    if (candidates.length >= limit) break;
  }
  if (candidates.length >= limit) break;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, candidates.map((c) => JSON.stringify(c)).join('\n') + (candidates.length ? '\n' : ''), 'utf8');

console.log(`扫了 ${scanned} 个文件，提出 ${candidates.length} 条候选 → ${outFile}`);
console.log('下一步：把这份 jsonl 交给 AI，一条条按「三行」写进记忆（是什么 / 什么撑着 / 何时不成立），拿不准的问你，别自己补。');
