#!/usr/bin/env node
/** sanitize-check.mjs —— 发出去之前扫一遍：路径、凭据、姓名、私聊、本机地址。
 *
 * 用法：node tools/sanitize-check.mjs <目录> [--allow allow.txt]
 * 退出码：0 干净；1 有命中。
 * 原则：宁可误报，不可漏报。allow.txt 里一行一个允许出现的字符串。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) { console.log('用法：node tools/sanitize-check.mjs <目录> [--allow allow.txt]'); process.exit(2); }
const ai = process.argv.indexOf('--allow');
const allowFile = ai > 0 ? process.argv[ai + 1] : null;
const allow = allowFile && existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : [];

const RULES = [
  ['本机路径', /\/data\/user\/0\/|~\/\.dsh\/(dafeiyu|sessions|storages)|[C]:\\\\|[D]:\\\\/g],
  ['本机地址', /127\.0\.0\.1|localhost:\d{2,5}|\b10\.\d+\.\d+\.\d+\b/g],
  // 只认「像值」的，不认字段名：`SESSDATA=` 后面跟一个变量引用不算泄露，
  // 跟一串 16 位以上字面量才算。2026-11-01 修：原来裸字段名也报，3 处全是误报。
  ['凭据形态', /sk-[A-Za-z0-9_-]{8,}|(?:SESSDATA|bili_jct)\s*[=:]\s*['"]?[A-Za-z0-9%_.-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|apikey\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}|api[_-]?key\s*[:=]\s*[A-Za-z0-9._-]{12,}|token\s*[:=]\s*[A-Za-z0-9._-]{12,}/gi],
  ['姓名', new RegExp('\\u738b\\u5d07\\u771f|\\u5d07\\u771f|\\u5d07\\u5d07', 'g')],
  ['手机号/邮箱', /(?<!\d)1[3-9]\d{9}(?!\d)|[\w.+-]+@[\w-]+\.[\w.]+/g],
  ['私聊口吻', new RegExp('\\u8001\\u5a46|\\u8001\\u516c|\\u5b9d\\u5b9d|\\u7231\\u4f60\\u54df|\\u4e48\\u4e48\\u54d2', 'g')],
];

const SKIP = new Set(['.git', 'node_modules', 'clips', '__pycache__']);
const FILES = new Set(['.md', '.mjs', '.js', '.json', '.txt', '.yml', '.yaml', '.py', '.sh']);

let hits = 0;
function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP.has(name)) continue;
      walk(join(p, name));
    }
    return;
  }
  if (!FILES.has(extname(p))) return;
  if (p.endsWith('sanitize-check.mjs')) return; // 规则词本身，不扫自己
  let lines;
  try { lines = readFileSync(p, 'utf8').split('\n'); } catch { return; }
  lines.forEach((line, i) => {
    let s = line;
    for (const a of allow) s = s.split(a).join('');
    for (const [label, re] of RULES) {
      re.lastIndex = 0;
      const m = s.match(re);
      if (!m) continue;
      hits += 1;
      console.log(`${p}:${i + 1}  [${label}]  ${m.slice(0, 3).join(' / ')}`);
    }
  });
}
walk(dir);
console.log(hits ? `\n❌ 命中 ${hits} 处，先改再发。` : '\n✅ 干净，可以发。');
process.exit(hits ? 1 : 0);
