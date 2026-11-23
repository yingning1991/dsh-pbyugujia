#!/usr/bin/env node
/** action-recall.mjs —— 按「这次要做什么」检索记忆，而不是只按关键词相似度。
 *
 * 2026-11-12 建，来源：两条视频的判据（ActKV「按动作保留，不按新近/相似保留」；
 * 长任务插件失效的教训「触发要写死、别靠自觉」）。这里是原型，不改插件、不重启。
 *
 * 用法：
 *   node tools/action-recall.mjs "明天要搬家换窗口"        # 动作模式（带动作加权）
 *   node tools/action-recall.mjs "明天要搬家换窗口" --baseline  # 纯关键词对照
 *   node tools/action-recall.mjs --eval                     # 6 个真实场景，两种模式对比
 *
 * 打分：中文按二元组切，标题×4、标签×3、正文×1，正文按长度归一；整串命中另加。
 * 动作加权（只在动作模式）：正文带「判据/步骤/命令/node tools/触发」+2、标签像流程/纠错/工具 +1.5、
 * kind=scene +1 —— 都是「这条告诉你怎么做」的信号，不是「这条讲的是什么」的信号。
 * 判据：不指望它一定赢；赢了才值得进插件，输了就照实说。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pbyugujia', 'memory.db');
const { DatabaseSync } = process.getBuiltinModule?.('node:sqlite') || await import('node:sqlite');
const db = new DatabaseSync(DB, { readOnly: true });

// 注意：superseded_by / valid_to 存的是空字符串不是 NULL，别用 is null 过滤（11-12 栽过一次）
const notes = db.prepare(`select id,title,tags,body,kind,importance from notes
  where coalesce(superseded_by,'')='' and coalesce(valid_to,'')=''`).all();

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
function tokens(s) {
  const out = new Set();
  const low = String(s || '').toLowerCase();
  for (const w of low.match(/[a-z0-9_.-]{2,}/g) || []) out.add(w);
  const han = low.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < han.length - 1; i++) out.add(han.slice(i, i + 2));
  return [...out];
}

const ACTION_HINTS = /判据|步骤|命令|node tools\/|触发|下次|怎么做|办法|口径/;
// 动作同义扩写：同一种活常换说法（换窗口/新窗口/接手；装插件/装包），
// 不扩写的话「指的是同一件事」就断了（11-12 第一轮 6 例里两例 0 分都是这个原因）。
const EXPAND = [
  [/搬家|换窗口|新窗口|接手|接续/, ['窗口', '接续', '任务', '重建']],
  [/装.*插件|装包|安装|pnpm/, ['插件', 'pnpm', 'install', '依赖']],
  [/出片|发视频|发布|成片/, ['片子', '交付', '相册', '标题']],
  [/记进库|写记忆|落库|记下来/, ['记忆', '落库', '协议', '写']],
  [/同步|推送|仓库/, ['同步', 'repo', '仓库']],
];
const PROC_TAGS = /流程|纠错|工具|实验|协议|操作|方法/;

function score(note, q, actionMode) {
  const toks = tokens(q);
  const title = String(note.title || '').toLowerCase();
  const tags = String(note.tags || '').toLowerCase();
  const body = String(note.body || '').toLowerCase();
  const count = (h, t) => h.split(t).length - 1;
  let s = 0;
  for (const [re, extra] of EXPAND) if (re.test(String(q))) for (const e of extra) toks.push(...tokens(e));
  for (const t of toks) {
    s += count(title, t) * 4 + count(tags, t) * 3 + Math.min(count(body, t), 3) * 1;
  }
  const phrase = String(q).toLowerCase();
  if (title.includes(phrase)) s += 6;
  else if (body.includes(phrase)) s += 3;
  s /= Math.sqrt(1 + (cjk(body) + body.length) / 800);   // 长文不该因为字多就赢
  if (actionMode) {
    if (ACTION_HINTS.test(body)) s += 2;
    if (PROC_TAGS.test(tags)) s += 1.5;
    if (note.kind === 'scene') s += 1;
  }
  return s;
}

function top(q, actionMode, k = 3) {
  return notes
    .map((n) => ({ ...n, s: score(n, q, actionMode) }))
    .filter((n) => n.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
}

// 六个场景：ground truth = 我做这件事时真的需要的那几条（不是我搜出来才定的）
const CASES = [
  { q: '明天要搬家换窗口', want: ['fy-261030-kbei', 'fy-261102-1v29'] },
  { q: '出一条片子发出去', want: ['fy-261109-0ss3', 'fy-261106-gi73', 'fy-261106-4bvv'] },
  { q: '装个插件试试', want: ['fy-261111-jwg4', 'fy-261111-fz1q'] },
  { q: '把本地改动同步进仓库', want: ['fy-261111-63uy'] },
  { q: '新窗口接手继续做', want: ['fy-261102-1v29'] },
  { q: '把这条活记进库里', want: ['fy-261105-r2rq'] },
];

const argv = process.argv.slice(2);

if (argv.includes('--eval')) {
  let hitB = 0, hitA = 0, total = 0;
  for (const c of CASES) {
    const b = top(c.q, false).map((x) => x.id);
    const a = top(c.q, true).map((x) => x.id);
    const nb = c.want.filter((id) => b.includes(id)).length / c.want.length;
    const na = c.want.filter((id) => a.includes(id)).length / c.want.length;
    hitB += nb; hitA += na; total += 1;
    console.log(`${c.q}  期望 ${c.want.length} 条`);
    console.log(`  基线 ${nb.toFixed(2)}  ${b.join(' ')}`);
    console.log(`  动作 ${na.toFixed(2)}  ${a.join(' ')}`);
  }
  console.log(`\n命中率@3：基线 ${(hitB / total * 100).toFixed(0)}% → 动作 ${(hitA / total * 100).toFixed(0)}%（${total} 例）`);
  process.exit(0);
}

const q = argv.filter((a) => !a.startsWith('--')).join(' ');
if (!q) { console.error('用法：node tools/action-recall.mjs "要做什么" [--baseline]'); process.exit(2); }
const mode = !argv.includes('--baseline');
for (const [i, n] of top(q, mode, 5).entries()) {
  console.log(`${i + 1}. ${n.s.toFixed(2)}  ${n.id}  ${n.title.slice(0, 58)}`);
}
