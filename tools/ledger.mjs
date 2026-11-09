/** ledger.mjs —— 记忆账本：证明「一条都没丢过」
 *
 * 用法：
 *   node ledger.mjs --sync     把新记忆补进账本（老记录绝不覆盖）
 *   node ledger.mjs --verify   校验：账本里的每一条都还在，且正文没被改
 *   node ledger.mjs --line     输出一行健康日志，可追加进复盘
 *
 * 环境变量（一般不用设）：
 *   MEM_DB      默认 $DSH_HOME/pbyugujia/memory.db
 *   MEM_LEDGER  默认 $DSH_HOME/pbyugujia/out/ledger.json
 *
 * 顺序纪律：先 --sync 再 --verify。反过来会把新记忆误报成「丢了」。
 * 退出码：0 正常；1 有缺失或被改。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DB = process.env.MEM_DB || path.join(HOME, 'pbyugujia', 'memory.db');
const LEDGER = process.env.MEM_LEDGER || path.join(HOME, 'pbyugujia', 'out', 'ledger.json');

const sha = (t) => crypto.createHash('sha256').update(t || '', 'utf8').digest('hex');

// v2（2026-11-02 agmi 自测后加的）：只哈希正文，等于「改标题、改重要度」不算数（T8 漏了）。
// 改成一并哈希 title + importance + body。老账本（无 ver 字段）在 --sync 时一次性迁移，不记 prev。
const LEDGER_VER = 2;
const sig = (n) => sha(`${n.title}\u0000${n.importance ?? 3}\u0000${n.body}`);

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { updated: null, rows: {} }; }
}

function saveLedger(l) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, LEDGER);
}

function notes() {
  const d = new DatabaseSync(DB);
  try {
    return d.prepare('SELECT id, title, body, importance, updated FROM notes').all()
      .map((r) => ({ id: String(r.id), title: String(r.title || ''), body: String(r.body || ''), importance: Number(r.importance ?? 3), updated: String(r.updated || '') }));
  } finally { d.close(); }
}

// 鲜活度：按重要度的半衰期算「还记不记得清」，被取代的条不计入。
function freshness() {
  const d = new DatabaseSync(DB);
  try {
    const rows = d.prepare('SELECT importance, last_touch, updated, superseded_by FROM notes').all();
    const now = Date.now();
    const HALF = { 1: 7, 2: 15, 3: 30, 4: 45, 5: 60 };
    let sum = 0, n = 0, low = 0;
    for (const r of rows) {
      if (r.superseded_by) continue;
      const lt = Number(r.last_touch);
      const t = Number.isFinite(lt) && lt > 0 ? lt : (Date.parse(r.updated) || now);
      const days = Math.max(0, (now - t) / 86400000);
      const f = Math.pow(0.5, days / ((HALF[Number(r.importance)] || 30)));
      sum += f; n += 1;
      if (f < 0.3) low += 1;
    }
    return { avg: n ? sum / n : 1, low, n };
  } finally { d.close(); }
}

function sync() {
  const l = loadLedger();
  const all = notes();
  let added = 0, changed = 0, migrated = 0;
  const migrating = Number(l.ver || 1) < LEDGER_VER;
  for (const n of all) {
    const h = sig(n);
    const old = l.rows[n.id];
    if (migrating) { // 一次性迁移：不改旧哈希历史，直接换成新口径
      if (old) { old.sha256 = h; old.len = n.body.length; migrated += 1; } else { l.rows[n.id] = { sha256: h, len: n.body.length, title: n.title, first: n.updated }; added += 1; }
      continue;
    }
    if (!old) { l.rows[n.id] = { sha256: h, len: n.body.length, title: n.title, first: n.updated }; added += 1; continue; }
    if (old.sha256 !== h) {
      // 正文变了：留旧哈希做「改口留痕」，只把当前值记上，不覆盖历史
      old.prev = old.prev || [];
      if (!old.prev.some((p) => p.sha256 === old.sha256)) old.prev.push({ sha256: old.sha256, len: old.len, at: old.seen || null });
      old.sha256 = h; old.len = n.body.length; old.seen = n.updated;
      changed += 1;
    }
  }
  l.ver = LEDGER_VER;
  l.updated = new Date().toISOString();
  saveLedger(l);
  console.log(`账本同步：共 ${all.length} 条，新记 ${added}，正文变动 ${changed}${migrated ? `，口径迁移 ${migrated}` : ''}`);
}

function verify() {
  const l = loadLedger();
  const all = notes();
  const byId = new Map(all.map((n) => [n.id, n]));
  const missing = [], altered = [];
  for (const [id, row] of Object.entries(l.rows)) {
    const n = byId.get(id);
    if (!n) { missing.push(id); continue; }
    if (sig(n) !== row.sha256) altered.push(id);
  }
  const unlogged = all.filter((n) => !l.rows[n.id]).map((n) => n.id);
  if (missing.length) console.log(`❌ 丢了 ${missing.length} 条：${missing.slice(0, 5).join(', ')}`);
  if (altered.length) console.log(`❌ 内容/标题/重要度被改 ${altered.length} 条：${altered.slice(0, 5).join(', ')}`);
  // 未入账 = 有人绕过写入路径塞了新条目（伪造插入 T5 / 跨上下文重放 T6）。
  // 以前只打 ⚠ 还照打 ✅、退出码 0 —— agmi 自测逮到的，2026-11-02 改成退出码 2。
  if (unlogged.length) console.log(`❌ 未入账 ${unlogged.length} 条（绕过写入路径塞进来的？确认是自己写的再 --sync）：${unlogged.slice(0, 5).join(', ')}`);
  if (!missing.length && !altered.length && !unlogged.length) console.log(`✅ 账本对得上：${all.length} 条，一条没丢、一条没被改`);
  if (missing.length || altered.length) return 1;
  return unlogged.length ? 2 : 0;
}

const cmd = process.argv[2] || '--verify';
if (cmd === '--sync') sync();
else if (cmd === '--verify') process.exit(verify());
else if (cmd === '--line') {
  const l = loadLedger();
  const all = notes();
  const unlogged = all.filter((n) => !l.rows[n.id]).length;
  const v = verify();
  const bad = v === 1; // 2 = 只有未入账，不算账本坏了
  const day = new Date().toISOString().slice(0, 10);
  const f = freshness();
  console.log(`[memory] ${day} total=${all.length} ledger=${bad ? 'FAIL' : 'OK'} pending=${unlogged} fresh=${f.avg.toFixed(2)} low=${f.low}/${f.n}`);
}
else { console.log('用法：node ledger.mjs --sync | --verify | --line'); process.exit(2); }
