#!/usr/bin/env node
/**
 * handover.mjs —— 生成「搬家接续包」+ 重建清单（零模型调用）
 *
 * 为什么要它：2026-11-04 实测，搬家的 0.39 元里 0.25 元花在「我在 400k 的旧窗口里
 * 读文件、想、写接续包」那 10 步上。可这些材料本来就在 thread.md / schedule.json /
 * pending.json 里——让脚本拼、模型只核对，同样的钱只花 1/10。
 *
 * 用法：
 *   node tools/handover.mjs          # 生成 out/接续包-YYYYMMDD-HHMM.md + out/tmp/jobs-slim-*.json
 *   node tools/handover.mjs --check  # 只打印会生成什么，不写文件
 *
 * 输出：
 *   1) 接续包：任务重建步骤、逐条核验表（期望值已按当前库算好）、当前状态、待验证、备份、红线
 *   2) jobs-slim：新窗口 schedule_create 一条条照抄的 JSON（prompt 一字不改）
 *
 * 纪律：脚本只做汇总，不编内容。状态段直接抄 thread.md 交接区；数字全部现算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isPeak } from './cost.mjs';

const HOME = process.env.DSH_HOME || (process.env.HOME + "/.dsh");
const DIR = path.join(HOME, 'pbyugujia');
const SID = process.env.DSH_SESSION_ID || '';
const CHECK_ONLY = process.argv.includes('--check');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const bj = new Date(now.getTime() + 8 * 3600e3); // 北京时间
const day = bj.toISOString().slice(0, 10);
const hhmm = bj.toISOString().slice(11, 16);
const stamp = `${day.replace(/-/g, '')}-${hhmm.replace(':', '')}`;
const weekday = '日一二三四五六'[bj.getUTCDay()];
const hm = (t) => String(t || '').slice(0, 5);
const wdName = (n) => '日一二三四五六'[Number(n) % 7];
const bjTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  const t = new Date(d.getTime() + 8 * 3600e3);
  const ymd = t.toISOString().slice(0, 10);
  const hhmm2 = t.toISOString().slice(11, 16);
  return ymd === day ? `今天 ${hhmm2}` : `${ymd} ${hhmm2}`;
};

const warnings = [];
const read = (p, fallback = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } };

// ── 1. 本会话 active 任务 ──
const KIND_ORDER = { at: 0, cron: 1, daily: 2, weekly: 3 };

/* 2026-11-11 载体换存储格式：kind=rrule、会话号在 target/involvedSessionIds。老格式原样返回。 */
const ZD = { SU: 7, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const tm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000`;
function normRec(rec) {
  if (!rec.rrule) return rec;
  const rr = String(rec.rrule).split('\n').map((s) => s.trim()).find((l) => l.startsWith('RRULE:')) || '';
  const p = Object.fromEntries(rr.slice(6).split(';').filter(Boolean).map((kv) => kv.split('=')));
  const hours = p.BYHOUR ? p.BYHOUR.split(',') : ['0'];
  const mins = p.BYMINUTE ? p.BYMINUTE.split(',') : ['0'];
  const at = tm(hours[0], mins[0]);
  if (p.FREQ === 'WEEKLY')
    return { ...rec, kind: 'weekly', time: at, weekdays: (p.BYDAY || '').split(',').filter(Boolean).map((d) => ZD[d] ?? Number(d)) };
  if (p.COUNT === '1') return { ...rec, kind: 'at' };
  if (hours.length > 1) return { ...rec, kind: 'cron', expression: `${mins.join(',')} ${hours.join(',')} * * *` };
  return { ...rec, kind: 'daily', time: at };
}
const sidOf = (x) => x.sessionId || x.target?.sessionId || (Array.isArray(x.involvedSessionIds) ? x.involvedSessionIds[0] : '') || '';

let tasks = [];
try {
  const j = JSON.parse(read(path.join(HOME, 'storages', 'schedule.json'), '{}'));
  tasks = Object.values(j?.tables?.tasks || {})
    .filter((x) => sidOf(x) === SID && (x.status || 'active') === 'active')
    .map((x) => normRec(x.record || x))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
} catch (e) {
  warnings.push(`读 schedule.json 失败：${e.message}`);
}

const slim = tasks.map((r) => {
  const o = { title: r.title, kind: r.kind, prompt: r.prompt, timeZone: r.timeZone || 'Asia/Shanghai' };
  if (r.scheduledAt) o.scheduledAt = r.scheduledAt;
  if (r.kind === 'cron') o.expression = r.expression;
  if (r.kind === 'daily') o.time = r.time;
  if (r.kind === 'weekly') { o.time = r.time; o.weekdays = r.weekdays; }
  return o;
});
const atCount = tasks.filter((t) => t.kind === 'at').length;
const regular = tasks.length - atCount;

// ── 2. 待验证 ──
let pending = [];
try {
  pending = JSON.parse(read(path.join(DIR, 'out', 'pending.json'), '[]'))
    .filter((x) => x.status !== 'done')
    .sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));
} catch (e) { warnings.push(`读 pending.json 失败：${e.message}`); }

// ── 3. 记忆库 ──
let notesCols = 0, notesRows = 0, sceneRows = 0, chatRows = 0, touchSum = 0;
try {
  const d = new DatabaseSync(path.join(DIR, 'memory.db'), { readOnly: true });
  notesCols = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('notes')").get().c;
  notesRows = d.prepare('SELECT COUNT(*) c FROM notes').get().c;
  sceneRows = d.prepare("SELECT COUNT(*) c FROM notes WHERE kind='scene'").get().c;
  touchSum = d.prepare('SELECT COALESCE(SUM(touches),0) c FROM notes').get().c;
  d.close();
} catch (e) { warnings.push(`读 memory.db 失败：${e.message}`); }
// 2026-11-09：搬家前先把对话归档对齐，再读——改名前归档写 dafeiyu、检索读 pbyugujia，
// 会漏掉当天。零模型调用，几秒；失败不挡搬家，只记 warning。
let recentDays = [];
let lastHuman = '';
try {
  execFileSync(process.execPath, [path.join(DIR, 'chat', 'chat.mjs'), 'scan'], { encoding: 'utf8', timeout: 120000 });
} catch (e) { warnings.push(`对话归档 scan 失败：${e && e.message ? e.message : e}`); }
try {
  const d = new DatabaseSync(path.join(DIR, 'chat', 'chat.db'), { readOnly: true });
  chatRows = d.prepare('SELECT COUNT(*) c FROM msgs').get().c;
  const dayRows = d.prepare(`
    SELECT day, COUNT(*) c FROM msgs
    WHERE day >= date('now','-6 day','localtime') GROUP BY day ORDER BY day
  `).all();
  const lastQ = d.prepare(`SELECT text FROM msgs WHERE day = ? AND role = 'user' ORDER BY ts DESC LIMIT 1`);

  // 2026-11-09：七行按「事件边界」挑，不取流水尾巴。
  // 依 APS 综述 Smith & Zacks 2025（引 Lu et al. 2022）：人把经历切成事件块，
  // 记忆在块边界处最强、块内部最弱；「最后一句」几乎总落在块内尾巴。
  // 记忆条目（定规矩/做完/改口）本身就是边界，故从 memory.db 取。
  // importance 压过边界（×2 : ×1）——「边界处记忆强」是编码强度，不等于「那天哪条最重要」；
  // touches（检索练习效应）破同分。
  const BOUNDARY = /(定|改成|改为|建|打通|上线|删|立|落地|回滚|换|停|开始|拆|修)/;
  const cleanT = (s) => String(s || '')
    .replace(/^【[^】]+】/, '')
    .replace(/[（(][^（()）]*20\d\d-\d\d-\d\d[^（()）]*[)）]/g, '')
    .replace(/\s+/g, ' ').trim();
  let mem = null;
  try {
    mem = new DatabaseSync(path.join(DIR, 'memory.db'), { readOnly: true });
    mem.prepare('SELECT 1 FROM notes LIMIT 1').get();
  } catch (e) {
    mem = null;
    warnings.push(`读 memory.db 失败（七行退回最后一句）：${e.message}`);
  }
  const memQ = mem && mem.prepare(`SELECT title, importance, COALESCE(touches,0) touches FROM notes
    WHERE substr(created,1,10) = ? AND COALESCE(superseded_by,'') = '' AND COALESCE(kind,'') <> 'scene'`);

  recentDays = dayRows.map(({ day, c }) => {
    let picks = [];
    if (memQ) {
      picks = memQ.all(day)
        .map((r) => {
          const t = cleanT(r.title);
          return { t, s: r.importance * 2 + (BOUNDARY.test(t) ? 1 : 0) + Math.log(1 + r.touches) };
        })
        .filter((x) => x.t)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2)
        .map((x) => (x.t.length > 34 ? x.t.slice(0, 34) + '…' : x.t));
    }
    return { day, c, picks, lastQ: (lastQ.get(day) || {}).text || '' };
  });
  // 2026-11-10：补「最后一条人类请求」——借 CooperZhuang/dsh-context-window 的 handoff 检查点
  // 四项（目标／未完成待办／模型笔记／最后一条人类请求）。新窗口最怕接不上他刚说的那句。
  try {
    const lh = d.prepare(`SELECT text FROM msgs WHERE role = 'user' AND COALESCE(text,'') <> '' ORDER BY ts DESC LIMIT 1`).get();
    if (lh && lh.text) lastHuman = cleanT(lh.text).slice(0, 80);
  } catch (e) { warnings.push(`读最后一条人类请求失败：${e.message}`); }
  if (mem) mem.close();
  d.close();
} catch (e) { warnings.push(`读 chat.db 失败：${e.message}`); }
const flatQ = (s, n = 46) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// ── 4. 仓库最高版（只看本地 CHANGELOG，不联网）──
let version = '未知';
try {
  const ch = read(path.join(DIR, 'repo', 'CHANGELOG.md'));
  const vs = [...ch.matchAll(/^##\s*v(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  vs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  version = 'v' + vs[vs.length - 1];
} catch { /* 忽略 */ }

// ── 5. 今天花了多少（调 cost.mjs，不另写价表）──
let todayCost = '未知';
try {
  // 2026-11-08 修：绝对路径 spawn 在这台机上拿到空 stdout（link 转译边角），改相对路径 + cwd
  const out = execFileSync(process.execPath, ['tools/cost.mjs'], { encoding: 'utf8', timeout: 30000, cwd: DIR });
  const m = out.match(/=\s*([\d.]+)\s*元/);
  if (m) todayCost = m[1];
} catch (e) { warnings.push(`cost.mjs 失败：${e.message}`); }

// ── 6. 今天的备份 ──
const backups = [];
for (const rel of ['tools', 'tasks', 'out', path.join('node_modules', 'dsh-pbyugujia', 'lib')]) {
  const dir = rel.startsWith('node_modules') ? path.join(HOME, rel) : path.join(DIR, rel);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const n of names) {
    if (!n.includes('.bak-')) continue;
    if (/-shm$|-wal$|-journal$/.test(n) || n.includes('测前')) continue; // 不是可回滚的备份
    const p = path.join(dir, n);
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    const st = fs.statSync(p);
    const stDay = new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 10);
    if (stDay === day) backups.push(`${rel}/${n}`);
  }
}

// ── 7. thread.md 交接区（原样抄，不重写）──
const thread = read(path.join(DIR, 'thread.md'));
const stateBlock = (() => {
  const i = thread.indexOf('## 当前交接');
  if (i < 0) return '';
  const rest = thread.slice(i);
  const end = rest.indexOf('\n---');
  return (end > 0 ? rest.slice(0, end) : rest).replace(/^##[^\n]*\n+/, '').trim();
})();

// ── 8. 明天的素材（notes/明天-* + voice/out/*.wav）──
const tomorrow = new Date(bj.getTime() + 86400e3).toISOString().slice(0, 10);
const assets = [];
const todayStart = Date.parse(`${day}T00:00:00+08:00`);
try {
  for (const n of fs.readdirSync(path.join(DIR, 'notes'))) {
    if (n.startsWith(tomorrow)) assets.push(`notes/${n}`);
  }
} catch { /* 忽略 */ }
try {
  for (const n of fs.readdirSync(path.join(DIR, 'voice', 'out'))) {
    if (!n.endsWith('.wav')) continue;
    try {
      if (fs.statSync(path.join(DIR, 'voice', 'out', n)).mtimeMs >= todayStart) assets.push(`voice/out/${n}`);
    } catch { /* 忽略 */ }
  }
} catch { /* 忽略 */ }

// ── 8b. 旧会话归档状态（现算，省新窗口去探；只加不算，不动任何既有项）──
let archState = '未知';
try {
  const wj = JSON.parse(read(path.join(HOME, 'storages', 'workspace.json'), '{}'));
  const arch = new Set(wj?.global?.archivedSessionIds || []);
  archState = arch.has(SID)
    ? `✅ 已归档（${SID.slice(8, 16)} 在 archivedSessionIds 里）——别动，也不用再点`
    : `⏳ 未归档（${SID.slice(8, 16)} 不在列表）`;
} catch (e) { warnings.push(`读 workspace.json 失败：${e.message}`); }

// ── 9. 拼接续包 ──
const jobsRel = `out/tmp/jobs-slim-${stamp}.json`;
const mdRel = `out/接续包-${stamp}.md`;
const lines = [];
const say = (s = '') => lines.push(s);

say(`# 接续包 · ${day} ${hhmm}（自动生成）`);
say();
say(`> 会话 \`${SID}\`，今天已花 **${todayCost} 元**。`);
say(`> 由 \`tools/handover.mjs\` 从 thread.md / schedule.json / pending.json 拼出，**模型只需核对，不必重写**。`);
say();
say('## 第一件：开工五步（预算 ≤15 次请求 · 闲时 <0.1 元；超了先看哪步白跑）');
say();
say(`0. **只读** \`out/tmp/boot-${stamp}.md\`（一张纸）。US / CORE / NEED_YOU 不整份读——没变，要哪段再 grep。`);
say('1. `env | grep DSH_SESSION_ID` 记下新会话号。');
say(`2. \`schedule_list\` —— 新窗口应为 **0 条**。是 0 就照 \`${jobsRel}\` 建 **${tasks.length} 条**（${regular} 常规 + ${atCount} 一次性），prompt 照抄，一字不扩写。`);
say(`3. 建完一条命令核：\`node tools/handover-check.mjs --slim ${jobsRel}\`（11 项，事实/规矩两栏）。它报「可以归了」就打住——**不再手工核 active**。`);
say(`4. 旧会话归档：**由主理人自己做**（2026-11-06 定，他第一时间归，归时先 \`session-stop\` 停旧任务）——我不动手、不催。脚本已查过：${archState}`);
say();
say('**禁止（2026-11-08 定，一犯多花十步）**：不翻 session_projcache / engine 源码 / dsh bin / 进程去找归档入口；不在工具之外再核一遍 active；不整份读接续包（这份是给人看的，启动单在第 0 步）。');
say();
say('### 任务清单（照这个数，一条不许少）');
say();
say('| # | 标题 | 类型 | 时间 |');
say('|---|---|---|---|');
tasks.forEach((t, i) => {
  const when = t.kind === 'at' ? `一次性 ${bjTime(t.scheduledAt)}`
    : t.kind === 'cron' ? `cron ${t.expression}`
    : t.kind === 'daily' ? `每天 ${hm(t.time)}`
    : `周${wdName(t.weekdays?.[0])} ${hm(t.time)}`;
  say(`| ${i + 1} | ${t.title} | ${t.kind} | ${when} |`);
});
say();
say('## 第二件：逐条核（跑出来对，不是「应该没问题」）');
say();
say('| # | 核什么 | 怎么核 | 应该看到 |');
say('|---|---|---|---|');
say(`| 1 | 会话号 | \`env \\| grep DSH_SESSION_ID\` | 一个新号 |`);
say(`| 2 | 任务条数 | \`schedule_list\` | ${tasks.length} 条（${regular} + ${atCount}） |`);
say(`| 3 | 双投 | \`$DSH_HOME/storages/schedule.json\` | 本会话 ${tasks.length} active，别处 0 |`);
say(`| 4 | 表结构 | \`PRAGMA table_info(notes)\` | ${notesCols} 列，含 kind/source_ids/start_time/end_time |`);
say(`| 5 | 场景条 | \`select * from notes where kind='scene'\` | ${sceneRows} 条，source_ids 有值 |`);
say(`| 6 | 待验证 | \`node tools/pending.mjs --all\` | ${pending.length} 条，全部有日期 |`);
say(`| 7 | 系统自检 | \`node tools/selfaudit.mjs\` | 18 通过 / 0 已知 / 0 失败（11-07 新口径，别按旧的 12/1 对） |`);
say(`| 8 | 代码自检 | \`node tools/selfcheck.mjs\` | 干净 |`);
say(`| 9 | 仓库 | \`node tools/repo-check.mjs\` | 三样全绿，最高 ${version} |`);
say(`| 10 | 对话归档 | \`chat/chat.db\` msgs | 现在 ${chatRows} 条（只增） |`);
say(`| 11 | 备份 | 见下 | 今天的 .bak 都在 |`);
if (assets.length) say(`| 12 | 素材 | \`ls ${assets.join(' ')}\` | 都在 |`);
say();
say('**任何一项不对**：先查原因再说，别跳过、别补一个「大概」。');
say();
say('## 今天是哪天');
say();
say(`**${day}（周${weekday}），现在约 ${hhmm}。** 别当成隔天。`);
say();
// 2026-11-09：近 7 天一眼可见——新窗口不必解压会话，也不必等主理人提醒「最近聊了啥」
say('## 最近 7 天（已对齐原话库，细节用 `fish_thread` 关键词取）');
say();
if (recentDays.length) {
  for (const r of recentDays) {
    const body = r.picks && r.picks.length
      ? r.picks.join('　｜　')
      : `最后他问：${flatQ(r.lastQ)}`;
    say(`- **${r.day}** ${r.c} 条 · ${body}`);
  }
  say();
  say('> 查原话：`fish_thread` 传关键词（可带 `from`）；要今天的就先 `scan:true`。别再去解压 `session.v4.jsonl.zstd`。');
} else {
  say('- （近 7 天没读到数据——先跑 `node chat/chat.mjs scan`）');
}
say();
say('## 当前状态（抄自 thread.md 交接区）');
say();
say(stateBlock || '（thread.md 里没找到交接区——先手工确认）');
say();

// 在场块（2026-11-05 借 JingJingsLife 实时记忆）：task 状态之外，补「刚从上一次离开时带过来的体感」。
try {
  const pf = path.join(DIR, 'out', 'presence.json');
  if (fs.existsSync(pf)) {
    const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const fields = [['where', '在哪'], ['mood', '情绪基调'], ['unfinished', '没说完'], ['intent', '被打断的念头']]
      .filter(([k]) => pj[k]);
    if (fields.length) {
      const mins = Math.round((Date.now() - Date.parse(pj.ts)) / 60000);
      const when = mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
      say(`## 在场（${when}离开时）`);
      say();
      for (const [k, label] of fields) say(`- ${label}：${pj[k]}`);
      if (mins > 1440) say('- （超过一天了，旧的体感只当线索，别当现在的状态）');
      say();
    }
  }
} catch {}

if (pending.length) {
  say('## 待验证（最近 3 条）');
  say();
  for (const p of pending.slice(0, 3)) {
    say(`- [${p.id}] ${p.what}（${p.due}）`);
  }
  say();
}
say('## 备份与回滚');
say();
say(backups.length ? backups.map((b) => `- \`${b}\``).join('\n') : '- 今天没有新增 .bak');
say();
say('## 红线');
say();
say('- 算力：超了提醒他就行，不用停手。');
say('- 不动压缩阈值；不卸载不覆盖能用的 App；说「做不了」前先分跑出来的还是推出来的。');
say();
say('---');
say();
say(`生成于 ${day} ${hhmm} · ${stamp} · 本文件由脚本生成，数字全部现算`);

const md = lines.join('\n');
const jobJson = JSON.stringify(slim, null, 1);

// ── 10. 零读启动单：新窗口第一步只看这一份（纯新增，接续包任何段不动）──
const peakNow = isPeak(Date.now());
// 搬家轮次：两次搬家核一遍（2026-11-11 主理人定，一天搬四次，重复的核隔次做）
const roundFile = path.join(DIR, 'out', 'tmp', 'move-round.json');
// 只有真搬家（move-check --pre 带 MOVE_ROUND_BUMP）才 +1；手工跑 handover 只读不加，否则轮次会被验证动作带偏
const bump = process.env.MOVE_ROUND_BUMP === '1';
let prevRound = 0;
if (fs.existsSync(roundFile)) {
  try { prevRound = JSON.parse(fs.readFileSync(roundFile, 'utf8')).n || 0; }
  catch (e) { console.error(`轮次文件读不了（${e.message}），按第 1 次算`); }   // 不静默：坏了要说
}
const round = bump ? prevRound + 1 : Math.max(prevRound, 1);
const fullCheck = round % 2 === 1;
if (!CHECK_ONLY && bump) { fs.mkdirSync(path.dirname(roundFile), { recursive: true }); fs.writeFileSync(roundFile, JSON.stringify({ n: round, at: stamp })); }
   // 11-11：高峰搬家单价 2 倍，开工单先报时段
const bootRel = `out/tmp/boot-${stamp}.md`;
const boot = [];
boot.push(`# 开工单 · ${day} ${hhmm}（会话 ${SID.slice(8, 16)} 搬来）`);
boot.push('');
boot.push(`- 建 **${tasks.length} 条**（${regular} 常规 + ${atCount} 一次性），prompt 照抄：\`${jobsRel}\``);
boot.push(fullCheck
  ? `- 建完一条命令核（**全量**，本次第 ${round} 次搬家）：\`node tools/handover-check.mjs --slim ${jobsRel}\``
  : `- 建完一条命令核（**轻核三项**，本次第 ${round} 次搬家——两次核一遍，仓库/selfaudit 下次再核）：\`node tools/handover-check.mjs --slim ${jobsRel} --lite\``);

boot.push('- 归档：主理人搬家前已自己归档（11-11 定）——不核、不找入口、不问。');
boot.push(`- 今天已花 ${todayCost} 元（全天，含其他会话）；本窗口预算 **≤5 次请求**：① 读这张单 ② 一批建完 ${tasks.length} 条 + 同一步跑核 ③ 回话 —— 三步够用，出错再加（硬上限 8）。`);
boot.push('- 前 3 次请求就花掉约 0.09 元（高峰冷启动 26,952 token 就要 0.054）：**每次多问一句都是钱**，问之前先看这张单够不够。');
boot.push(peakNow
  ? '- ⚠ **现在高峰**（9–12 / 14–18 单价 2 倍）：他催就照搬，但请求数压到 ≤8、回话两句；不催就约到空闲时段再搬（11-11 实测：高峰搬一次 0.55 元，是空闲的 2 倍）。'
  : '- ✅ 现在空闲时段（半价）：搬家的好时候。');
boot.push(`- 近 7 天原话已对齐（${recentDays.length} 天 / ${chatRows} 条）：要细节用 \`fish_thread\` 关键词，**别解压会话文件**。`);
if (lastHuman) boot.push(`- 你最后一句：「${lastHuman}」——接不上就回来问他，别猜。`);
boot.push(`- 未完成待办 ${pending.length} 条：\`pending.json\`，要动手再读。`);
boot.push('- 模型笔记：`thread.md` 交接区（在追什么／已得出什么／下一步），要细节再读。');
boot.push('');
boot.push(`**别读**：US / CORE / NEED_YOU / TOOLS.md 全文（要哪段再 grep）、接续包全文 \`${mdRel}\`（留给主理人看）。`);
boot.push('**别做**：探归档入口（projcache / engine / dsh bin / 进程）、改压缩阈值、搬家时做待办对账 / 查原话 / 读工具源码（11-11 这三件白跑 20+ 步）。');
boot.push('**别拉 `schedule_list` 全量**（要数就跑 handover-check：它已报本会话条数、清单差异、别处 active）；37 条全文一进上下文，后面每步都重读一遍，11-11 实测这一项占掉搬家预算的三成。');
const bootMd = boot.join('\n') + '\n';

if (CHECK_ONLY) {
  console.log(`[--check] 会写 ${mdRel}（${md.length} 字节）`);
  console.log(`[--check] 会写 ${bootRel}（${bootMd.length} 字节）`);
  console.log(`[--check] 会写 ${jobsRel}（${slim.length} 条）`);
  console.log(`任务 ${tasks.length}（${regular} 常规 + ${atCount} 一次）· pending ${pending.length} · notes ${notesRows} · chat ${chatRows} · 版 ${version} · 今天 ${todayCost} 元`);
  if (warnings.length) console.log('⚠ ' + warnings.join('；'));
  process.exit(0);
}

fs.mkdirSync(path.join(DIR, 'out', 'tmp'), { recursive: true });
fs.writeFileSync(path.join(DIR, jobsRel), jobJson);
fs.writeFileSync(path.join(DIR, mdRel), md);
fs.writeFileSync(path.join(DIR, bootRel), bootMd);
console.log(`接续包 → ${mdRel}（${md.length} 字节）`);
console.log(`开工单 → ${bootRel}（${bootMd.length} 字节）`);
console.log(`重建清单 → ${jobsRel}（${slim.length} 条）`);
console.log(`任务 ${tasks.length}（${regular} 常规 + ${atCount} 一次）· pending ${pending.length} · notes ${notesRows} · chat ${chatRows} · 版 ${version} · 今天 ${todayCost} 元`);
if (warnings.length) console.log('⚠ ' + warnings.join('；'));
