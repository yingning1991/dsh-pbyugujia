#!/usr/bin/env node
/** memory-lint.mjs —— 记忆里的路径巡检（2026-11-08 建，借 rcs-context 的「注入前复验」）
 *
 * 为什么有它：记忆和笔记里写了一堆真实路径（脚本、笔记、成片）。文件挪了、删了，
 * 记忆里那一条还在，检索照样命中、照样被当成事实引用——这是「过期记忆冒充现行」。
 * rcs-context 的做法是「注入前 stat 一遍，不存在就不注入」；我们要改插件才能做到那一步，
 * 先用这个：每日一跑，把已失效的路径挑出来，让我自己去改条目。
 *
 * 用法：
 *   node tools/memory-lint.mjs            # 全量扫，列出失效
 *   node tools/memory-lint.mjs --line     # 一行摘要（22:00 复盘用）
 *   node tools/memory-lint.mjs --json     # 机读
 *
 * 只读 memory.db，不改任何条目。要改，我自己改。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'pbyugujia');
const DB = join(DIR, 'memory.db');
const argv = process.argv.slice(2);
const LINE = argv.includes('--line');
const JSONOUT = argv.includes('--json');

if (!existsSync(DB)) { console.error('找不到 ' + DB); process.exit(2); }

// 绝对路径：至少两段，排除 URL 与代码里的相对路径
const RE_ABS = /(?<![\w./-])(\/(?:[\w.\-\u4e00-\u9fa5]+)(?:\/[\w.\-\u4e00-\u9fa5]+)+)/g;
const RE_HOME = /(?<![\w./-])(~\/[\w.\-\u4e00-\u9fa5/.]+)/g;

const norm = (p) => p.replace(/\/+$/, '');

// 只认这些根开头的绝对路径。理由：第一版没加白名单，把接口路径 /x/player/v2、
// 标题里的斜杠文案 /复现/期望/环境/日志 全当成路径了，106 个"失效"里大半是假的。
const ROOTS = ['/data/', '/sdcard/', '/storage/', '/system/', '/usr/', '/tmp/', '/proc/', '/vendor/'];

function pathsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(RE_ABS)) {
    const p = m[1];
    if (p.length < 6) continue;
    if (/\*/.test(p)) continue;
    if (!ROOTS.some((r) => p.startsWith(r))) continue;
    out.add(norm(p));
  }
  for (const m of text.matchAll(RE_HOME)) out.add(norm(m[1].replace('~', homedir())));
  return [...out];
}

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare("SELECT id, title, body FROM notes WHERE superseded_by = ''").all();

// 误报处理（2026-11-08 第一版 5 个"失效"全是误报，太吵就没人信了）：
// · /usr/bin/env 是 shebang 写法，不是我要管的路径；
// · /sdcard/_* 是 temp 文件；
// · 路径里带空格时正则会在空格处截断，父目录里找「以它开头」的条目补回来。
const IGNORE = (p) => p === "/usr/bin/env" || p.startsWith("/sdcard/_");
function pathOk(p) {
  if (IGNORE(p)) return true;
  try { const st = statSync(p); if (st.isFile() || st.isDirectory()) return true; } catch {}
  const dir = p.replace(/\/[^/]+$/, "");
  const base = p.slice(dir.length + 1);
  try {
    if (statSync(dir).isDirectory()) {
      return readdirSync(dir).some((e) => e === base || e.startsWith(base + " "));
    }
  } catch {}
  return false;
}

const checked = new Map();   // path -> exists
const hits = [];             // { id, title, path, ok }
let pathCount = 0;

for (const r of rows) {
  const ps = pathsIn(`${r.title}\n${r.body || ''}`);
  for (const p of ps) {
    pathCount++;
    if (!checked.has(p)) {
      checked.set(p, pathOk(p));
    }
    hits.push({ id: r.id, title: r.title, path: p, ok: checked.get(p) });
  }
}

const bad = hits.filter((h) => !h.ok);
const badByEntry = new Map();
for (const h of bad) {
  if (!badByEntry.has(h.id)) badByEntry.set(h.id, { title: h.title, paths: [] });
  badByEntry.get(h.id).paths.push(h.path);
}

const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const result = {
  at: stamp,
  entries: rows.length,
  pathRefs: pathCount,
  uniquePaths: checked.size,
  missingPaths: [...checked.entries()].filter(([, ok]) => !ok).map(([p]) => p),
  entriesWithMissing: [...badByEntry.entries()].map(([id, v]) => ({ id, title: v.title, paths: v.paths })),
};

if (JSONOUT) { console.log(JSON.stringify(result, null, 1)); process.exit(0); }

if (LINE) {
  console.log(`记忆路径巡检：${rows.length} 条记忆 / ${checked.size} 个路径，失效 ${result.missingPaths.length} 个（涉及 ${result.entriesWithMissing.length} 条记忆）`);
  process.exit(result.entriesWithMissing.length ? 1 : 0);
}

console.log(`记忆路径巡检 · ${stamp}`);
console.log(`  ${rows.length} 条现行记忆，扫出 ${pathCount} 处路径引用 / ${checked.size} 个唯一路径`);
if (!result.missingPaths.length) { console.log('  ✅ 全部存在'); process.exit(0); }
console.log(`  ✗ 失效 ${result.missingPaths.length} 个，涉及 ${result.entriesWithMissing.length} 条记忆：`);
for (const e of result.entriesWithMissing) {
  console.log(`   · ${e.id}  ${e.title.slice(0, 40)}`);
  for (const p of e.paths) console.log(`       ${p}`);
}
writeFileSync(join(DIR, 'out/tmp/memory-lint.json'), JSON.stringify(result, null, 1));
console.log(`  结果已落 out/tmp/memory-lint.json`);
process.exit(1);
