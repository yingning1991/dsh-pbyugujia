#!/usr/bin/env node
/**
 * capability.mjs —— 一条命令列出「我现在有什么能力」：工具 / 插件 / 任务 / 检索三路。
 *
 * 2026-11-09 定：「你要做个记忆判断。就是你现在拥有什么能力你记得……避免过段时间你忘记自己能力。」
 * 为什么是生成而不是手写：手抄清单必然和 tools/ 漂移（101 个文件，天天在加），
 * 而每个工具的头注释里本来就写着「xxx.mjs —— 用途」，那就是唯一真源。
 * 所以这里只做一件事：把头注释扫出来，对齐成一张表；缺头注释的单独列，当作待补。
 *
 * 用法：
 *   node tools/capability.mjs            # 生成 notes/能力清单.md 并打印摘要
 *   node tools/capability.mjs --print    # 只打印，不写文件
 *   node tools/capability.mjs --grep 视频  # 按关键词查「我有什么能干这个的」
 *
 * 什么时候用它：接到一个活、不确定有没有现成工具时；他问「你能做什么」时；隔了一阵没碰某条链路时。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME = os.homedir();
const argv = process.argv.slice(2);
const PRINT_ONLY = argv.includes('--print');
const gIdx = argv.indexOf('--grep');
const GREP = gIdx >= 0 ? (argv[gIdx + 1] || '') : '';

function readHeader(file) {
  let s = '';
  try { s = fs.readFileSync(file, 'utf8').slice(0, 2400); } catch { return null; }
  const lines = s.split('\n').slice(0, 24);
  // 三种写法都认：`/** a.mjs —— 用途`、`// a.mjs —— 用途`、`/**` 换行后 ` * a.mjs —— 用途`
  // 2026-11-10 扩到 .py：PIL/ffmpeg 这类脚本也是能力，只扫 .mjs 会漏（card.py 就被漏过）
  const RE = /^\s*(?:\/\*\*?|\/\/|\*|\"\"\"|#)\s*([\w.-]+\.(?:mjs|py))\s*——\s*(.+?)\s*(?:\*\/|\"\"\")?\s*$/;
  for (const ln of lines) {
    const m = ln.match(RE);
    if (m) return { name: m[1], what: m[2] };
  }
  return null;
}

function firstMeaningful(file) {
  // 头注释没写「——」的，退一步取第一行不以 shebang/import/空 开头的注释
  let s = '';
  try { s = fs.readFileSync(file, 'utf8').slice(0, 1200); } catch { return ''; }
  for (const ln of s.split('\n').slice(0, 20)) {
    const m = ln.match(/^\s*\*\s*(.+?)\s*$/);
    if (m && m[1] && !m[1].startsWith('/')) return m[1];
  }
  return '';
}

// —— 工具 ——
const toolsDir = path.join(ROOT, 'tools');
const tools = [];
const noHeader = [];
const misnamed = [];
for (const f of fs.readdirSync(toolsDir).sort()) {
  if (!/\.(mjs|py)$/.test(f) || f.includes('.bak')) continue;
  const h = readHeader(path.join(toolsDir, f));
  if (h) {
    // 头注释写的名字和真实文件名对不上：这条要报，不然「自己都记错自己」正是要防的
    if (h.name !== f) misnamed.push({ file: f, declared: h.name });
    tools.push({ file: f, name: f, what: h.what });
  } else noHeader.push({ file: f, what: firstMeaningful(path.join(toolsDir, f)) || '（无注释）' });
}

// —— 插件（第三方装的，非 DSH 自带）——
const plugins = [];
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh/profiles/web/package.json'), 'utf8'));
  for (const [name, ver] of Object.entries(pkg.dependencies || {})) {
    if (name.startsWith('@deepseek-ai/') || name.startsWith('@types/')) continue;
    let v = String(ver);
    if (v.startsWith('link:') || v.startsWith('file:')) v = '本地版';
    else v = v.replace(/^[\^~]/, '');
    plugins.push({ name, ver: v });
  }
} catch { /* 读不到就空着，不编 */ }

// —— 任务书 ——
const tasksDir = path.join(ROOT, 'tasks');
const tasks = [];
try {
  for (const f of fs.readdirSync(tasksDir).sort()) {
    if (!f.endsWith('.md')) continue;
    tasks.push(f.replace(/\.md$/, ''));
  }
} catch { /* 同上 */ }

// —— 输出 ——
const L = [];
L.push('# 能力清单（自动生成，勿手改）');
L.push('');
L.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}　｜　重跑：\`node tools/capability.mjs\``);
L.push('> 真源＝各文件头注释；工具一加一删，重跑这张表就对上。查某类：`node tools/capability.mjs --grep 视频`。');
L.push('');
L.push(`## 工具（${tools.length} 个，本地跑、零模型调用）`);
L.push('');
for (const t of tools) L.push(`- **${t.name}** —— ${t.what}`);
if (noHeader.length) {
  L.push('');
  L.push(`### 缺头注释，待补（${noHeader.length} 个，用途不可靠）`);
  L.push('');
  for (const t of noHeader) L.push(`- ${t.file} —— ${t.what.slice(0, 60)}`);
}
if (misnamed.length) {
  L.push('');
  L.push(`### 头注释写错名字（${misnamed.length} 个，改头注释即可）`);
  L.push('');
  for (const m of misnamed) L.push(`- ${m.file} 的头注释写成 \`${m.declared}\``);
}
L.push('');
L.push(`## 插件（${plugins.length} 个第三方，装在 profiles/web）`);
L.push('');
for (const p of plugins) L.push(`- ${p.name}@${p.ver}`);
L.push('');
L.push(`## 任务书（${tasks.length} 份，定时任务按它们跑）`);
L.push('');
L.push(tasks.map(t => '`' + t + '`').join('　'));
L.push('');
L.push('## 记忆/知识三路（别走错路）');
L.push('');
L.push('- 经历·原话（说过什么、做过什么）→ `fish_thread` 传关键词（近 7 天先在手上）');
L.push('- 经历·提炼（长期事实、偏好、决定）→ `fish_recall`（先 `light:true`）');
L.push('- 知识·方法（我学过的、写下的、任务书）→ `node tools/kb.mjs "词"`');
L.push('');
L.push('## 定时任务');
L.push('');
L.push('15 条（14 常规 + 1 一次性），以 `schedule_list` 为准；备份见 `out/tmp/jobs-slim-*.json`。');
L.push('');

let out = L.join('\n');
if (GREP) {
  const kw = GREP.toLowerCase();
  const hit = tools.filter(t => (t.name + t.what).toLowerCase().includes(kw));
  const plug = plugins.filter(p => p.name.toLowerCase().includes(kw));
  out = [`# 「${GREP}」相关的现成能力（${hit.length} 工具 / ${plug.length} 插件）`, '',
    ...hit.map(t => `- **${t.name}** —— ${t.what}`),
    ...plug.map(p => `- 插件 ${p.name}`)].join('\n');
  if (!hit.length && !plug.length) out += `\n没找到。先 `+ '`ls tools/`' + ` 看有没有叫法不同的，再决定要不要新写。`;
}

if (PRINT_ONLY || GREP) {
  console.log(out);
} else {
  const dst = path.join(ROOT, 'notes/能力清单.md');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, out);
  console.log(`✅ ${dst}`);
  console.log(`   工具 ${tools.length} 个（缺头注释 ${noHeader.length}、名不符 ${misnamed.length}）｜插件 ${plugins.length} 个｜任务书 ${tasks.length} 份`);
  if (noHeader.length) console.log(`   缺头注释：${noHeader.map(t => t.file).join(' ')}`);
  if (misnamed.length) console.log(`   名不符：${misnamed.map(m => `${m.file}→${m.declared}`).join(' ')}`);
}
