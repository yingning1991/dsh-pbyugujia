#!/usr/bin/env node
/** handover-check.mjs —— 搬家核对，一条命令跑完；新窗口开局只跑它。
 *
 * 用法：
 *   node tools/handover-check.mjs --slim out/tmp/jobs-slim-20261108-1045.json
 *   node tools/handover-check.mjs --slim <清单> --no-repo   # 跳过联网仓库核对
 *
 * 为什么有它：2026-11-08 搬家手工核了 11 项、跑了十来次调用。同样的活第二次
 * 要能原样跑、不返工（11-06 崇真定的验收口径），所以固化。
 *
 * 证据：arXiv 2608.29028《Facts Without Rules》——交接压缩优先保住「事实」，
 * 丢的是「边界/规矩」（25 词预算时边界存活率 0.80→0.57，事实仍近满）。
 * 所以输出分两栏：事实 / 规矩·边界。别只看第一栏全绿就放心。
 *
 * 退出码：0 全过（含「别处待归档」的 ⏳）；1 有真失败。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DF = join(HOME, 'pbyugujia');
const SID = process.env.DSH_SESSION_ID || '';
const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const slimPath = val('--slim');
const doRepo = !has('--no-repo');

const rows = [];
const add = (group, mark, text) => rows.push({ group, mark, text });
let realBad = 0;   // ⏳ 不算失败

/* ---- 1 会话号 ---- */
add('事实', SID ? '✅' : '❌', `会话号 ${SID || '（空）'}`);
if (!SID) realBad++;

/* ---- 2/3 任务：本会话条数 + prompt 对账 + 别处 active ---- */
let mine = [], others = {}, othersActive = 0;
try {
  const j = JSON.parse(readFileSync(join(HOME, 'storages', 'schedule.json'), 'utf8'));
  const all = Object.values(j.tables?.tasks || {});
  for (const t of all) {
    if (t.sessionId === SID) mine.push({ rec: t.record, active: t.status === 'active' || t.record?.state === 'scheduled' });
    else {
      const k = t.sessionId;
      others[k] ||= { total: 0, active: 0 };
      others[k].total++;
      if (t.status === 'active' || t.record?.state === 'scheduled') { others[k].active++; othersActive++; }
    }
  }
  const active = mine.filter((m) => m.active).length;
  add('事实', mine.length ? '✅' : '❌', `本会话任务 ${mine.length} 条（active ${active}）`);
  if (!mine.length) realBad++;

  if (slimPath) {
    const slim = JSON.parse(readFileSync(slimPath, 'utf8'));
    let diff = 0;
    for (const s of slim) {
      const m = mine.find((x) => x.rec.title === s.title)?.rec;
      if (!m || m.prompt !== s.prompt || m.kind !== s.kind ||
        (s.expression && m.expression !== s.expression) ||
        (s.time && m.time !== s.time) ||
        (s.weekdays && JSON.stringify(m.weekdays) !== JSON.stringify(s.weekdays))) diff++;
    }
    add('事实', diff === 0 && slim.length === mine.length ? '✅' : '❌',
      `清单对账 ${slim.length} 条 → 差异 ${diff} 处`);
    if (diff || slim.length !== mine.length) realBad++;
  }

  if (othersActive === 0) add('事实', '✅', '别处 active 0 条');
  else {
    const brief = Object.entries(others).filter(([, v]) => v.active)
      .map(([k, v]) => `${k.slice(8, 16)}(${v.active})`).join(' ');
    add('事实', '⏳', `别处 active ${othersActive} 条：${brief} —— 崇真归档旧窗口后归零，不算失败`);
  }

  /* ---- 3c 旧会话归档状态（2026-11-08 加，只报不判失败；省新窗口去探入口） ---- */
  try {
    const wj = JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8'));
    const arch = new Set(wj?.global?.archivedSessionIds || []);
    const sids = Object.keys(others);
    const yes = sids.filter((s) => arch.has(s));
    const no = sids.filter((s) => !arch.has(s)).map((s) => s.slice(8, 16));
    add('事实', no.length ? '⏳' : '✅',
      `旧会话归档：${sids.length} 个里 ${yes.length} 已归档${no.length ? `；未归档 ${no.join(' ')}（归由崇真做，不算失败）` : ''}`);
  } catch (e) { add('事实', '⚠️', `workspace.json 读不了：${e.message}`); }
} catch (e) {
  add('事实', '❌', `schedule.json 读不了：${e.message}`); realBad++;
}

/* ---- 4/5 记忆库：表结构 + 场景条 ---- */
try {
  const db = new DatabaseSync(join(DF, 'memory.db'));
  const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
  const need = ['kind', 'source_ids', 'start_time', 'end_time'];
  const miss = need.filter((k) => !cols.includes(k));
  add('事实', cols.length && !miss.length ? '✅' : '❌',
    `notes ${cols.length} 列${miss.length ? ' 缺 ' + miss.join(',') : '，四字段齐'}`);
  if (!cols.length || miss.length) realBad++;
  const sc = db.prepare("select id,title,source_ids from notes where kind='scene'").all();
  const withSrc = sc.filter((r) => String(r.source_ids || '').trim());
  add('事实', sc.length && withSrc.length === sc.length ? '✅' : (sc.length ? '❌' : '⏳'),
    `scene ${sc.length} 条；带 source_ids 的 ${withSrc.length} 条，共 ${withSrc.reduce((a, r) => a + String(r.source_ids).split(',').filter(Boolean).length, 0)} 个 id`);
  if (sc.length && withSrc.length !== sc.length) realBad++;
  db.close();
} catch (e) {
  add('事实', '❌', `memory.db 读不了：${e.message}`); realBad++;
}

/* ---- 6 pending ---- */
try {
  const list = JSON.parse(readFileSync(join(DF, 'out', 'pending.json'), 'utf8'));
  const noDate = list.filter((x) => !x.due);
  add('事实', noDate.length ? '❌' : '✅', `pending ${list.length} 条，没日期 ${noDate.length} 条`);
  if (noDate.length) realBad++;
} catch (e) {
  add('事实', '❌', `pending.json 读不了：${e.message}`); realBad++;
}

/* ---- 7 对话归档 ---- */
try {
  const db = new DatabaseSync(join(DF, 'chat', 'chat.db'), { readOnly: true });
  const n = db.prepare('select count(*) c from msgs').get().c;
  add('事实', n >= 34552 ? '✅' : '⚠️', `chat.db ${n} 条（基线 34552，只增）`);
  if (n < 34552) realBad++;
  db.close();
} catch (e) {
  add('事实', '❌', `chat.db 读不了：${e.message}`); realBad++;
}

/* ---- 8 备份：今天的 .bak ---- */
try {
  const d = new Date();
  const tag = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const dirs = [join(DF, 'tools'), join(HOME, 'node_modules', 'dsh-pbyugujia', 'lib')];
  let hits = [];
  for (const dir of dirs) if (existsSync(dir))
    for (const f of readdirSync(dir)) if (f.includes('.bak-') && f.includes(tag)) hits.push(f);
  add('事实', hits.length ? '✅' : '⚠️', `今天（${tag}）的 .bak ${hits.length} 个${hits.length ? '：' + hits.slice(0, 4).join(' ') : ''}`);
} catch (e) { add('事实', '⚠️', `备份扫描失败：${e.message}`); }

/* ---- 9 selfaudit（规矩/边界栏的核心） ---- */
try {
  const r = spawnSync(process.execPath, [join(DF, 'tools', 'selfaudit.mjs')], { encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/通过 (\d+)，已知 (\d+)，失败 (\d+)/);
  const fails = [...out.matchAll(/❌ ([A-Z][A-Z0-9]?) /g)].map((x) => x[1]);
  if (!m) { add('规矩', '❌', 'selfaudit 没给出结论'); realBad++; }
  else {
    const [, pass, known, fail] = m.map(Number);
    const onlyAF = fails.length > 0 && fails.every((f) => f === 'A' || f === 'F');
    if (fail === 0 && known === 0) add('规矩', '✅', `selfaudit ${pass} 通过 / 0 失败`);
    else if (onlyAF && othersActive > 0) add('规矩', '⏳', `selfaudit ${pass} 通过 / ${fail} 失败（${fails.join('')}：别处 active 造成，归档后自愈）`);
    else { add('规矩', '❌', `selfaudit ${pass} 通过 / ${known} 已知 / ${fail} 失败（${fails.join('') || '?'}）`); realBad++; }
  }
} catch (e) { add('规矩', '❌', `selfaudit 跑不了：${e.message}`); realBad++; }

/* ---- 10 CORE 体积（规矩层不许涨过头） ---- */
try {
  const s = readFileSync(join(DF, 'CORE.md'), 'utf8');
  const n = s.length;
  add('规矩', n <= 6000 ? '✅' : '❌', `CORE ${n}/6000 字符`);
  if (n > 6000) realBad++;
} catch (e) { add('规矩', '❌', `CORE.md 读不了：${e.message}`); realBad++; }

/* ---- 11 selfcheck ---- */
try {
  const r = spawnSync(process.execPath, [join(DF, 'tools', 'selfcheck.mjs')], { encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = /✅ 干净/.test(out);
  add('规矩', ok ? '✅' : '❌', `selfcheck ${ok ? '干净' : '不干净'}`);
  if (!ok) realBad++;
} catch (e) { add('规矩', '❌', `selfcheck 跑不了：${e.message}`); realBad++; }

/* ---- 12 仓库（可跳） ---- */
if (doRepo) {
  try {
    const r = spawnSync(process.execPath, [join(DF, 'tools', 'repo-check.mjs')], { encoding: 'utf8', timeout: 180000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ver = (out.match(/v0\.1\.\d+/g) || []).pop() || '?';
    const ok = /✅ 仓库齐了/.test(out);
    add('规矩', ok ? '✅' : '❌', `repo-check 三样${ok ? '绿' : '不绿'}（最高 ${ver}）`);
    if (!ok) realBad++;
  } catch (e) { add('规矩', '❌', `repo-check 跑不了：${e.message}`); realBad++; }
} else add('规矩', '⏭', 'repo-check 跳过（--no-repo）');

/* ---- 打印 ---- */
const w = Math.max(...rows.map((r) => r.text.length));
let last = '';
for (const r of rows) {
  if (r.group !== last) { console.log(`\n[${r.group}]`); last = r.group; }
  console.log(`  ${r.mark} ${r.text}`);
}
console.log(`\n${realBad === 0 ? '✅ 可以报「可以归了」' : `❌ ${realBad} 项真失败，先查因`}`);
process.exit(realBad === 0 ? 0 : 1);
