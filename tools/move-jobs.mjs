#!/usr/bin/env node
// move-jobs.mjs —— 搬家建任务走本地路由（零模型算力）
//
// 2026-11-23 立。以前建 17 条要用 schedule_create：17 段 prompt 全文进工具参数（按输出
// 4 元/M 计，约 0.019 元）＋17 条回执 20k 又按未命中买一遍（约 0.024 元）。现在改成
// 插件 lib/jobs-build.mjs 在 3080 挂的本地路由，读 slim 清单直接调 ctx.schedule。
//
// 用法：
//   node tools/move-jobs.mjs --go          # 建 + 核一条命令（搬家标准动作；省到 1 轮）
//   node tools/move-jobs.mjs --check        # 只看清单会建什么（dryRun，不建）
//   node tools/move-jobs.mjs               # 只建（默认清单 = out/tmp/ 最新 jobs-slim-*）
//   node tools/move-jobs.mjs --manifest out/tmp/jobs-slim-YYYYMMDD-HHMM.json --session session-xxxx
//
// 前 5 请求口径不变；这一步现在是 1 次 bash，不再有模型往返。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROJ = path.join(HOME_DIR, 'pbyugujia');
const argv = process.argv.slice(2);
const flag = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};

function latestManifest() {
  const dir = path.join(ROOT, 'out', 'tmp');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^jobs-slim-.*\.json$/.test(f)) : [];
  if (!files.length) return '';
  files.sort();
  return path.join('out', 'tmp', files[files.length - 1]);
}

function currentSession() {
  const env = process.env.DSH_SESSION_ID || process.env.DSH_SESSION || '';
  if (env.startsWith('session-')) return env;
  // 兜底：读引擎的调度库，找出最近写入的那条任务属于哪个会话
  try {
    const p = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'schedule.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rows = Object.values(j.tables?.tasks || {});
    rows.sort((a, b) => String(b.record?.updatedAt || '').localeCompare(String(a.record?.updatedAt || '')));
    for (const r of rows) if (String(r.sessionId || '').startsWith('session-')) return r.sessionId;
  } catch { /* 读不到就走参数 */ }
  return '';
}

const go = Boolean(flag('go', false));   // 建完同一条命令里立刻核，少一轮就少一次注入税
const dry = Boolean(flag('check', false)) && !go;
const verify = Boolean(flag('verify', false)) || go;
const verifyOnly = Boolean(flag('verify-only', false));
const handoverOnly = Boolean(flag('handover-only', false));
const handover = Boolean(flag('handover', false)) || go;   // 搬家默认连交付自检一起做
const manifest = flag('manifest', '') || latestManifest();
const session = flag('session', '') || currentSession();
// 2026-11-24 加（用户要求「现在就做」）：一条命令把仪式收全——旧窗快照 → 建 → 核 → 改绑 → 记账 → thread。
const fromSession = flag('from', '');            // 旧窗前 8 位；给了才导快照、才记账
const noFinish = Boolean(flag('no-finish', false));   // 只建不记账（排障用）
const finishOnly = Boolean(flag('finish-only', false)); // 脚本已建完，只补记账＋thread

if (!manifest) { console.error('没有清单：out/tmp/jobs-slim-*.json'); process.exit(2); }
if (!session) { console.error('没有会话号：传 --session session-xxxxxxxx'); process.exit(2); }

// 只校验：不建、不发请求（搬完复核、或平时想看一眼条数都用它）
if (verifyOnly) { const r = verifyCounts(session, manifest); process.exit(r.ok ? 0 : 1); }
if (handoverOnly) { await printHandover(session); process.exit(0); }
// 补收尾：任务已建好、只补「记账＋thread」时用（脚本跑到一半断了也能接上）
if (finishOnly) {
  if (!fromSession) { console.error('--finish-only 要带 --from <旧窗8位>'); process.exit(2); }
  await finishRitual(fromSession, session);
  process.exit(0);
}

// 硬闸：关旧窗前先导快照（11-15 丢过 19 条任务）。导 0 条不等于丢——清单在就能重建。
if (!dry && fromSession) snapshotOld(fromSession);

const body = { sessionId: session, manifest, dryRun: dry };
// 2026-11-23：主路径换成 jobs-build-2（老路径的 handler 会握死 ctx，报 inactive context）；
// 老路径留作兜底，插件还是旧版时也能跑。
const URLS = [
  'http://127.0.0.1:3080/dsh-pbyugujia/jobs-build-2',
  'http://127.0.0.1:3080/dsh-pbyugujia/jobs-build',
];

let out = { ok: false, error: '未调用' };
for (const url of URLS) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const got = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (got.ok) { out = got; break; }
    // 只有「路由不存在」才换下一条（404；静态兜底对 POST 回 405）；业务报错直接报出来
    if (res.status === 404 || res.status === 405) { out = got; continue; }
    out = got; break;
  } catch (error) {
    out = { ok: false, error: String(error?.message || error) };
  }
}

if (!out.ok) {
  console.error('建任务失败：', out.error || JSON.stringify(out.errors || out));
  process.exit(1);
}
console.log(`${dry ? '试跑' : '已建'} ${out.count} 条｜清单 ${manifest}｜会话 ${session.slice(0, 16)}`);
for (const c of out.created) {
  // 试跑时插件只回 title+rrule（scheduledAt 要等真建才有），把 rrule 摊成一行打出来
  const timing = c.rrule ? c.rrule.replace(/\n/g, ' | ') : (c.scheduledAtLocal ? `→ ${c.scheduledAtLocal}` : '');
  console.log('  ·', c.title, timing ? `— ${timing}` : '');
}
if (out.errors?.length) { console.error('失败：', JSON.stringify(out.errors)); process.exit(1); }

if (verify) {
  const r = verifyCounts(session, manifest);
  // 本窗自己不齐＝真错，不记账；旧窗还响＝正常，只警告，收尾照做（否则一条命令走不到底）。
  if (r.block) { console.error('✗ 本窗不齐：先修，不记账。'); process.exit(1); }
}
if (handover) await printHandover(session);
if (dry) {
  printFinishPreview(fromSession, session);
} else if (!noFinish && fromSession) {
  await finishRitual(fromSession, session);
} else if (!fromSession) {
  console.log('（没给 --from：跳过旧窗快照与记账；要一条收全就带 --from <旧窗8位>）');
}

/**
 * 本地校验，顶替原来的「搬家轻核」模型步骤（2026-11-23 用户问：轻核还要不要）。
 * 查三件：① 本会话 active 条数等于清单条数；② 别处没有 active（否则两边各响一次）；
 * ③ 打印本会话最早的下一条触发，人眼看一眼就是清单里该先到的那条。
 * 不查：rrule 的未来展开是否正确（建的时候 dryRun 已逐条打印，够用）。
 */
function verifyCounts(sessionId, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifestPath), 'utf8'));
  const store = JSON.parse(fs.readFileSync(
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'schedule.json'),
    'utf8',
  ));
  const rows = Object.values(store.tables?.tasks || {});
  // 会话号有两处：新格式在 target.sessionId，老条目在顶层 sessionId
  const sidOf = (r) => r?.target?.sessionId || r?.sessionId || '';
  // --session 常只给前 8 位（搬家习惯）。先归一化成 8 位再比——直接 startsWith 会把
  // 「session-20f3…」和「20f309dc」判成两个窗（2026-11-24 实测踩到，全绿被误报成 ✗）。
  const normSid = (s) => String(s || '').replace(/^session-/, '').slice(0, 8);
  const same = (a, b) => { const x = normSid(a); const y = normSid(b); return Boolean(x && y && x === y); };
  const active = rows.filter((r) => r.status === 'active');
  const mine = active.filter((r) => same(sidOf(r), sessionId));
  const others = active.filter((r) => !same(sidOf(r), sessionId));
  const titles = new Set(mine.map((r) => r.record?.title));
  const missing = manifest.map((j) => j.title).filter((t) => !titles.has(t));
  // 正文逐字对账（2026-11-23 补）：条数齐 ≠ 正文齐。14:30 那次开工单少 11 条句尾「执行。」，
  // 只核条数查不出；19:00 单跑一道逐字，现在并进同一条命令，新窗不用再多一步。
  const promptOf = Object.fromEntries(mine.map((r) => [r.record?.title, String(r.record?.prompt ?? "")]));
  const promptDiff = manifest.filter((j) => promptOf[j.title] !== j.prompt).map((j) => j.title);
  const next = mine
    .map((r) => r.record?.scheduledAt)
    .filter(Boolean)
    .sort()[0];

  // 会话号核对：环境里的会话号与传入的一致才算「真核过」，防止核了个错的窗
  const envSession = process.env.DSH_SESSION_ID || process.env.DSH_SESSION || '';
  const sessionOk = !envSession || same(envSession, sessionId);

  // 分两类：block＝本窗自己不齐（真错，别记账）；others＝旧窗还响（正常顺序：新窗先跑、他再关旧窗）。
  // 2026-11-24 改：以前 others 也算 bad，会卡住收尾——但他必须在新窗先跑才能导旧窗快照，
  // 那时旧窗 13 条还 active，一条命令就对不上了。现在 others 只警告，收尾照做。
  const block = mine.length !== manifest.length || missing.length || promptDiff.length || !sessionOk;
  const ok = !block;
  console.log(`校验：清单 ${manifest.length} / 本会话 active ${mine.length} / 别处 active ${others.length}${envSession ? ` / 会话号 ${sessionOk ? '一致' : '不一致'}` : ' / 会话号 未给(跳过)'}`);
  if (missing.length) console.log('  缺：', missing.join('、'));
  if (promptDiff.length) console.log('  正文不同：', promptDiff.join('、'));
  if (next) {
    const local = new Date(next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  下一条：${local}`);
  }
  if (others.length) console.log('  旧窗还有 active：', others.map((r) => `${(sidOf(r) || '?').slice(0, 12)}·${r.record?.title}`).slice(0, 3).join('、'), `等 ${others.length} 条——跑完这条就关旧窗，关完可 --verify-only 复核`);
  console.log(block ? '  ✗ 本窗不齐，先修，别关旧窗' : others.length ? '  ✓ 本窗齐；旧窗还响，关它就消' : '  ✓ 条数与清单一致，别处为空');
  return { ok, block, others: others.length };
}

// ── 交付自检：记忆能查、在追能接、外部绑定跟着走（全是本地动作，零模型算力）──
function memoryProbe(words = ['搬家', '记忆']) {
  const dbPath = path.join(PROJ, 'memory.db');
  if (!fs.existsSync(dbPath)) return `记忆库不存在：${dbPath}`;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('select * from notes').all();
    const hits = rows.filter((r) => words.some((w) => JSON.stringify(r).includes(w)));
    const sample = hits.slice(0, 2).map((r) => String(r.title || r.id || '').slice(0, 30));
    return `${rows.length} 条 · 命中「${words.join('/')}」${hits.length} 条${sample.length ? `｜${sample.join('；')}` : '｜⚠ 没命中，别当搬成了'}`;
  } catch (e) {
    return `查询失败：${e.message}`;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function threadTail(n = 2) {
  const p = path.join(HOME_DIR, 'dafeiyu', 'thread.md');
  if (!fs.existsSync(p)) return '没有 thread.md';
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().startsWith('-'));
  return lines.slice(-n).map((l) => l.replace(/\s+/g, ' ').slice(0, 120)).join(' ‖ ');
}

async function rebind(sessionId) {
  const sid = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`;
  const done = [];
  try {
    const r = await fetch('http://127.0.0.1:3080/dsh-fish-home/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 会话: sid }),
    });
    const j = await r.json().catch(() => ({}));
    done.push(`鱼鱼窝桥 ${j.ok ? '已改' : '失败'}`);
  } catch (e) { done.push(`鱼鱼窝桥 失败(${e.message})`); }

  const bp = path.join(HOME_DIR, 'worlds/bloom-harness/yingning/binding.json');
  try {
    if (fs.existsSync(bp)) {
      const j = JSON.parse(fs.readFileSync(bp, 'utf8'));
      j.sessionId = sid;
      fs.writeFileSync(bp, JSON.stringify(j));
      done.push('花语乡 binding 已改');
    }
  } catch (e) { done.push(`花语乡 binding 失败(${e.message})`); }

  try {
    const yp = path.join(HOME_DIR, 'profiles/web/cordis.patch.yml');
    if (fs.existsSync(yp)) {
      const src = fs.readFileSync(yp, 'utf8');
      const out = src.replace(/(sessionId:\s*")session-[0-9a-f-]+(")/g, `$1${sid}$2`);
      if (out !== src) {
        fs.copyFileSync(yp, `${yp}.bak-move`);
        fs.writeFileSync(yp, out);
        done.push('patch bloom 段 已改');
      } else done.push('patch bloom 段 本来一致');
    }
  } catch (e) { done.push(`patch 失败(${e.message})`); }
  return done.join('｜');
}

async function printHandover(sessionId) {
  console.log('── 交付自检（本地，零模型算力） ──');
  console.log('  记忆：', memoryProbe());
  console.log('  在追：', threadTail(2));
  console.log('  改绑：', await rebind(sessionId));
  console.log('  花语乡插件要重载才认新会话：plugin_manager include:bloom false→true（一条工具调用，别忘）');
}

// ── 2026-11-24：仪式收全（旧窗快照已在前面做过；这里只补记账＋thread）──
function sidShort(id) { return String(id || '').replace(/^session-/, '').slice(0, 8); }

function snapshotOld(from) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'preclose.mjs'), '--session', from], { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = text.match(/导出 (\d+) 条/);
  const n = m ? Number(m[1]) : -1;
  console.log('── 旧窗快照 ──');
  if (n < 0) console.log(`  ✗ 没导出来：${text.trim().split('\n').slice(-2).join(' / ')}`);
  else if (n === 0) console.log('  0 条——旧窗任务已清或还没建；清单在，内容不丢');
  else console.log(`  ${n} 条，条数对上再关旧窗`);
  return n;
}

function moveCostOf(toFull) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  // move-cost 只认前 8 位（它按 replace(/^session-/,'').slice(0,8) 比），传全号会「没有记录」
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'move-cost.mjs'), sidShort(toFull), today, '--json'], { encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout);
    return { cost: Number(j.cost), requests: Number(j.requests) };
  } catch { return { cost: null, requests: null }; }
}

function appendThread(line) {
  const p = path.join(HOME_DIR, 'dafeiyu', 'thread.md');
  try { fs.appendFileSync(p, `${line}\n`); return line; } catch (e) { return `写 thread 失败：${e.message}`; }
}

async function finishRitual(from, to) {
  const jobs = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifest), 'utf8'));
  const rc = moveCostOf(to);
  const costTxt = Number.isFinite(rc.cost) ? `${rc.cost.toFixed(4)} 元/${rc.requests} 请求` : '没量到';
  const now = new Date(Date.now() + 8 * 3600e3);
  const day = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);
  const facts = `搬家收工（${sidShort(from)} → ${sidShort(to)}，${jobs.length} 条）：verify 四项绿；改绑三处（鱼鱼窝桥/bloom binding/patch）已改；仪式 ${costTxt}；花语乡待重载。`;
  const lr = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'move-ledger.mjs'), 'add',
    '--from', sidShort(from), '--to', sidShort(to),
    '--note', `${jobs.length} 条`,
    '--ritual', Number.isFinite(rc.cost) ? String(rc.cost) : '',
    '--ritual-req', Number.isFinite(rc.requests) ? String(rc.requests) : '',
  ], { encoding: 'utf8' });
  const ledgerTxt = `${lr.stdout || ''}${lr.stderr || ''}`.trim().split('\n')[0] || '没回执';
  console.log('── 收尾（账＋thread）──');
  console.log('  账本：', ledgerTxt);
  console.log('  thread：', appendThread(`- ${day} ${hhmm}｜${facts}`));
  console.log('  剩一步（手）：plugin_manager include:bloom false→true');
}

function printFinishPreview(from, to) {
  const jobs = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifest), 'utf8'));
  const rc = moveCostOf(to);
  console.log('── 收尾预览（--check，不写盘）──');
  console.log(`  旧窗快照：${from ? sidShort(from) : '没给 --from，跳过'}`);
  console.log(`  账本：${jobs.length} 条；本窗此刻累计 ${Number.isFinite(rc.cost) ? rc.cost.toFixed(4) + ' 元/' + rc.requests + ' 请求' : '没量到'}（这就是仪式花费）`);
  console.log('  thread：一行收工；剩下手核：花语乡重载、近 7 天原话');
}
