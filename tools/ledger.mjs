/** ledger.mjs —— 记忆账本：证明「一条都没丢过」
 *
 * 用法：
 *   node ledger.mjs --sync     把新记忆补进账本（老记录绝不覆盖）
 *   node ledger.mjs --verify   校验：账本里的每一条都还在，且正文没被改
 *   node ledger.mjs --line     输出一行健康日志，可追加进复盘
 *
 * 环境变量（一般不用设）：
 *   MEM_DB      默认 $DSH_HOME/dafeiyu/memory.db
 *   MEM_LEDGER  默认 $DSH_HOME/dafeiyu/out/ledger.json
 *
 * 顺序纪律：先 --sync 再 --verify。反过来会把新记忆误报成「丢了」。
 * 退出码：0 正常；1 有缺失或被改。
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DB = process.env.MEM_DB || path.join(HOME, 'dafeiyu', 'memory.db');
const LEDGER = process.env.MEM_LEDGER || path.join(HOME, 'dafeiyu', 'out', 'ledger.json');

const sha = (t) => crypto.createHash('sha256').update(t || '', 'utf8').digest('hex');

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
    return d.prepare('SELECT id, title, body, updated FROM notes').all()
      .map((r) => ({ id: String(r.id), title: String(r.title || ''), body: String(r.body || ''), updated: String(r.updated || '') }));
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
  let added = 0, changed = 0;
  for (const n of all) {
    const h = sha(n.body);
    const old = l.rows[n.id];
    if (!old) { l.rows[n.id] = { sha256: h, len: n.body.length, title: n.title, first: n.updated }; added += 1; continue; }
    if (old.sha256 !== h) {
      // 正文变了：留旧哈希做「改口留痕」，只把当前值记上，不覆盖历史
      old.prev = old.prev || [];
      if (!old.prev.some((p) => p.sha256 === old.sha256)) old.prev.push({ sha256: old.sha256, len: old.len, at: old.seen || null });
      old.sha256 = h; old.len = n.body.length; old.seen = n.updated;
      changed += 1;
    }
  }
  l.updated = new Date().toISOString();
  saveLedger(l);
  console.log(`账本同步：共 ${all.length} 条，新记 ${added}，正文变动 ${changed}`);
}

function verify() {
  const l = loadLedger();
  const all = notes();
  const byId = new Map(all.map((n) => [n.id, n]));
  const missing = [], altered = [];
  for (const [id, row] of Object.entries(l.rows)) {
    const n = byId.get(id);
    if (!n) { missing.push(id); continue; }
    if (sha(n.body) !== row.sha256) altered.push(id);
  }
  const unlogged = all.filter((n) => !l.rows[n.id]).map((n) => n.id);
  if (missing.length) console.log(`❌ 丢了 ${missing.length} 条：${missing.slice(0, 5).join(', ')}`);
  if (altered.length) console.log(`❌ 正文被改 ${altered.length} 条：${altered.slice(0, 5).join(', ')}`);
  if (unlogged.length) console.log(`⚠️ 未入账 ${unlogged.length} 条（先跑 --sync）`);
  if (!missing.length && !altered.length) console.log(`✅ 账本对得上：${all.length} 条，一条没丢、一条没被改`);
  return missing.length || altered.length ? 1 : 0;
}

const cmd = process.argv[2] || '--verify';
if (cmd === '--sync') sync();
else if (cmd === '--verify') process.exit(verify());
else if (cmd === '--line') {
  const l = loadLedger();
  const all = notes();
  const unlogged = all.filter((n) => !l.rows[n.id]).length;
  const bad = verify() === 1;
  const day = new Date().toISOString().slice(0, 10);
  const f = freshness();
  console.log(`[memory] ${day} total=${all.length} ledger=${bad ? 'FAIL' : 'OK'} pending=${unlogged} fresh=${f.avg.toFixed(2)} low=${f.low}/${f.n}`);
}
else { console.log('用法：node ledger.mjs --sync | --verify | --line'); process.exit(2); }
