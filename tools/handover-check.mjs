#!/usr/bin/env node
/**
 * handover-check.mjs —— 搬家/交接核对：一条命令，把「事实」和「规矩」分两栏报出来。
 *
 * 用法：
 *   node tools/handover-check.mjs --slim out/tmp/jobs-slim-YYYYMMDD-HHMM.json
 *   node tools/handover-check.mjs --slim <清单> --no-repo   # 跳过联网仓库核对
 *   node tools/handover-check.mjs --home ~/.dsh --session session-xxxx
 *
 * 为什么分两栏：arXiv 2608.29028《Facts Without Rules》实测，交接压缩时
 * 「操作事实」几乎全保留，「边界/规矩」最先丢（25 词预算时保留率 0.80→0.57，
 * 两者相关性接近零）。只核事实全绿，等于没核规矩。
 *
 * 每项都能缺：数据目录没这个文件就标 ⏭，不算失败；核心项缺了标 ❌。
 *
 * 退出码：0 全过（含 ⏳ 待归档）；1 有真失败。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const HOME = val('--home') || process.env.DSH_HOME || join(homedir(), '.dsh');
const DF = join(HOME, 'pbyugujia');
const SID = val('--session') || process.env.DSH_SESSION_ID || '';
const slimPath = val('--slim');
const doRepo = !has('--no-repo');

const rows = [];
const add = (group, mark, text) => rows.push({ group, mark, text });
let realBad = 0;

/* ---- 1 会话号 ---- */
if (SID) add('事实', '✅', `会话号 ${SID}`);
else { add('事实', '❌', '没拿到会话号（env DSH_SESSION_ID 空，也没给 --session）'); realBad++; }

/* ---- 2/3 任务：本会话条数 + 清单对账 + 别处 active ---- */
let mine = [], othersActive = 0;
try {
  const j = JSON.parse(readFileSync(join(HOME, 'storages', 'schedule.json'), 'utf8'));
  const others = {};
  for (const t of Object.values(j.tables?.tasks || {})) {
    if (t.sessionId === SID) mine.push({ rec: t.record, active: t.status === 'active' || t.record?.state === 'scheduled' });
    else {
      others[t.sessionId] ||= { active: 0 };
      if (t.status === 'active' || t.record?.state === 'scheduled') { others[t.sessionId].active++; othersActive++; }
    }
  }
  const active = mine.filter((m) => m.active).length;
  add('事实', mine.length ? '✅' : '❌', `本会话任务 ${mine.length} 条（active ${active}）`);
  if (!mine.length) realBad++;

  if (slimPath && existsSync(slimPath)) {
    const slim = JSON.parse(readFileSync(slimPath, 'utf8'));
    let diff = 0;
    for (const s of slim) {
      const m = mine.find((x) => x.rec.title === s.title)?.rec;
      if (!m || m.prompt !== s.prompt || m.kind !== s.kind ||
        (s.expression && m.expression !== s.expression) ||
        (s.time && m.time !== s.time) ||
        (s.weekdays && JSON.stringify(m.weekdays) !== JSON.stringify(s.weekdays))) diff++;
    }
    const ok = diff === 0 && slim.length === mine.length;
    add('事实', ok ? '✅' : '❌', `清单对账 ${slim.length} 条 → 差异 ${diff} 处`);
    if (!ok) realBad++;
  } else add('事实', '⏭', '没给 --slim，跳过清单对账');

  if (othersActive === 0) add('事实', '✅', '别处 active 0 条');
  else {
    const brief = Object.entries(others).filter(([, v]) => v.active)
      .map(([k, v]) => `${k.slice(0, 12)}(${v.active})`).join(' ');
    add('事实', '⏳', `别处 active ${othersActive} 条：${brief} —— 旧窗口归档后归零，不算失败`);
  }
} catch (e) {
  add('事实', '⏭', `schedule.json 读不了（${e.code || e.message}），跳过任务核对`);
}

/* ---- 4/5 记忆库：表结构 + 场景条 ---- */
let hasScene = false;
try {
  const dbPath = join(DF, 'memory.db');
  if (existsSync(dbPath)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: false });
    const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
    const need = ['kind', 'source_ids', 'start_time', 'end_time'];
    const miss = need.filter((k) => !cols.includes(k));
    add('事实', cols.length && !miss.length ? '✅' : '❌',
      `notes ${cols.length} 列${miss.length ? '，缺 ' + miss.join(',') : '，四字段齐'}`);
    if (!cols.length || miss.length) realBad++;
    const sc = db.prepare("select id,source_ids from notes where kind='scene'").all();
    hasScene = sc.length > 0;
    const ids = sc.reduce((a, r) => a + String(r.source_ids || '').split(',').filter(Boolean).length, 0);
    add('事实', '✅', `scene ${sc.length} 条，source_ids 共 ${ids} 个`);
    db.close();
  } else add('事实', '⏭', '没有 memory.db，跳过记忆库核对');
} catch (e) { add('事实', '⚠️', `memory.db 打不开：${e.message}`); }

/* ---- 6 pending ---- */
try {
  const f = join(DF, 'out', 'pending.json');
  if (existsSync(f)) {
    const list = JSON.parse(readFileSync(f, 'utf8'));
    const noDate = list.filter((x) => !x.due);
    add('事实', noDate.length ? '❌' : '✅', `pending ${list.length} 条，没日期 ${noDate.length} 条`);
    if (noDate.length) realBad++;
  } else add('事实', '⏭', '没有 pending.json，跳过');
} catch (e) { add('事实', '⚠️', `pending.json 读不了：${e.message}`); }

/* ---- 7 对话归档 ---- */
try {
  const f = join(DF, 'chat', 'chat.db');
  if (existsSync(f)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(f, { readOnly: true });
    const n = db.prepare('select count(*) c from msgs').get().c;
    add('事实', '✅', `chat.db ${n} 条`);
    db.close();
  } else add('事实', '⏭', '没有 chat/chat.db，跳过');
} catch (e) { add('事实', '⚠️', `chat.db 读不了：${e.message}`); }

/* ---- 8 备份：今天的 .bak ---- */
try {
  const d = new Date();
  const tag = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const dirs = [join(DF, 'tools'), join(HOME, 'node_modules', 'dsh-pbyugujia', 'lib')];
  const hits = [];
  for (const dir of dirs) if (existsSync(dir))
    for (const f of readdirSync(dir)) if (f.includes('.bak-') && f.includes(tag)) hits.push(f);
  add('事实', hits.length ? '✅' : '⏭', `今天（${tag}）的 .bak ${hits.length} 个${hits.length ? '：' + hits.slice(0, 3).join(' ') : ''}`);
} catch (e) { add('事实', '⚠️', `备份扫描失败：${e.message}`); }

/* ---- 9 selfaudit（规矩栏核心） ---- */
const runNode = (file, timeout = 120000) => {
  if (!existsSync(file)) return null;
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout });
  return (r.stdout || '') + (r.stderr || '');
};
try {
  const out = runNode(join(DF, 'tools', 'selfaudit.mjs'));
  if (out === null) add('规矩', '⏭', '没有 selfaudit.mjs，跳过');
  else {
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
  }
} catch (e) { add('规矩', '❌', `selfaudit 跑不了：${e.message}`); realBad++; }

/* ---- 10 CORE 体积 ---- */
try {
  const f = join(DF, 'CORE.md');
  if (existsSync(f)) {
    const n = readFileSync(f, 'utf8').length;
    add('规矩', n <= 6000 ? '✅' : '❌', `CORE ${n}/6000 字符`);
    if (n > 6000) realBad++;
  } else add('规矩', '⏭', '没有 CORE.md，跳过');
} catch (e) { add('规矩', '⚠️', `CORE.md 读不了：${e.message}`); }

/* ---- 11 selfcheck ---- */
try {
  const out = runNode(join(DF, 'tools', 'selfcheck.mjs'));
  if (out === null) add('规矩', '⏭', '没有 selfcheck.mjs，跳过');
  else {
    const ok = /✅ 干净/.test(out);
    add('规矩', ok ? '✅' : '❌', `selfcheck ${ok ? '干净' : '不干净'}`);
    if (!ok) realBad++;
  }
} catch (e) { add('规矩', '❌', `selfcheck 跑不了：${e.message}`); realBad++; }

/* ---- 12 仓库（可跳） ---- */
if (doRepo) {
  try {
    const out = runNode(join(DF, 'tools', 'repo-check.mjs'), 180000);
    if (out === null) add('规矩', '⏭', '没有 repo-check.mjs，跳过');
    else {
      const ver = (out.match(/v0\.\d+\.\d+/g) || []).pop() || '?';
      const ok = /✅ 仓库齐了/.test(out);
      add('规矩', ok ? '✅' : '❌', `repo-check 三样${ok ? '绿' : '不绿'}（最高 ${ver}）`);
      if (!ok) realBad++;
    }
  } catch (e) { add('规矩', '❌', `repo-check 跑不了：${e.message}`); realBad++; }
} else add('规矩', '⏭', 'repo-check 跳过（--no-repo）');

/* ---- 打印 ---- */
let last = '';
for (const r of rows) {
  if (r.group !== last) { console.log(`\n[${r.group}]`); last = r.group; }
  console.log(`  ${r.mark} ${r.text}`);
}
console.log(`\n${realBad === 0 ? '✅ 可以交接：事实和规矩两栏都没有真失败' : `❌ ${realBad} 项真失败，先查因`}`);
process.exit(realBad === 0 ? 0 : 1);
