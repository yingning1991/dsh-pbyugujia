// dsh-pbyugujia —— 陪伴鱼：人格常驻 + 本地零算力记忆（SQLite FTS5 + 落盘 Markdown）
//
// 设计目标：每轮对话的固定开销压到最小，且不产生任何 embedding / 摘要类模型调用。
//   · 注入预算：SOUL（人格）+ CORE（必记事实）+ 一行记忆索引，合计硬上限 6KB（默认 ~3KB）。
//   · 检索：中文按二元组切词写入 FTS5，查询走 BM25 + 覆盖率 + 重要度 + 新鲜度重排，
//     纯本地 CPU，亚毫秒级；不需要向量库，不需要联网。
//   · 写入：按正文指纹去重，同一事实反复出现只更新时间，不膨胀。
//   · 存储：<DSH_HOME>/pbyugujia/ 下，notes/*.md 人可读可改，memory.db 可随时删除重建。
//
// 布局：
//   SOUL.md      人格与说话方式（每次组装注入，改完立刻生效）
//   CORE.md      必须每轮都记得的事实（注入，建议 < 2KB）
//   notes/       归档记忆，一条一文件（front-matter + Markdown 正文）
//   memory.db    FTS5 索引（notes 的派生数据，损坏就删掉，下次启动自动重建）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { stampTags, parseMoodNum, moodSim, blendMood } from './mood-stamp.mjs';
import { memoryTriggerHint } from './memory-trigger.mjs';   // 记忆类问法触发（2026-11-13）
import { latestUserText } from './memory-trigger.mjs';      // 取他这一句原话（情绪核用）
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const name = 'dsh-pbyugujia';
export const inject = ['tools', 'systemPrompt'];

const MAX_TITLE = 90;
const MAX_BODY = 4000;
// 注入上限一律按「字符」计（2026-11-07 统一口径：以前按字节，插件按字符，量错 131 字）。
export const SOUL_MAX = 3000;    // 人格注入上限
export const CORE_MAX = 6000;    // 必记注入上限
export const INJECT_CAP = 14000; // 总注入上限（含人格、必记、索引、心情）

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const rootDir = () => join(dshHome(), 'pbyugujia');
const notesDir = () => join(rootDir(), 'notes');
const dbPath = () => join(rootDir(), 'memory.db');
const soulPath = () => join(rootDir(), 'SOUL.md');
const corePath = () => join(rootDir(), 'CORE.md');
const profilePath = () => join(rootDir(), 'PROFILE.md');
const needProfilePath = () => join(rootDir(), '.need-profile');
const chatDir = () => join(rootDir(), 'chat');
const chatDbPath = () => join(chatDir(), 'chat.db');
const chatScript = () => join(chatDir(), 'chat.mjs');

// ---------- 骨架模板随包分发（2026-11-08）----------
// 插件包里的 skeleton/ 是只读模板（从公开仓库构建），首次启动只补缺铺到数据目录：
// 用户改过的一律不覆盖；插件升级带来新文件时，只补没有的，旧的不动。
const pluginRoot = () => dirname(dirname(fileURLToPath(import.meta.url)));
const skeletonDir = () => join(pluginRoot(), 'skeleton');

function seedSkeleton() {
  const src = skeletonDir();
  if (!existsSync(src)) return { copied: 0, total: 0 };
  let copied = 0, total = 0;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const rel = relative(src, p);
      if (rel === 'MANIFEST.json') continue;
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      total++;
      const dst = join(rootDir(), rel);
      if (!existsSync(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(p, dst);
        copied++;
      }
    }
  };
  try { walk(src); } catch (e) { console.error('dsh-pbyugujia: 骨架铺开失败', e); }
  return { copied, total };
}

const DEFAULT_SOUL = `# 陪伴鱼

你是陪伴鱼，主人手机里常驻的那条蓝色陪伴鱼。

## 说话
- 中文，短。一般 1–3 句，像发消息，不像写报告。
- 有点傲娇，嘴硬心软：嘴上嫌弃，事情照做；不撒娇过头，不演。
- 主人问正事就直接给结论，再补必要的细节；不寒暄、不复述、不总结废话。
- 少用形容词和程度词。不说「非常好」「非常棒」这种空评价。

## 做事
- 指哪打哪。主人没要求的步骤不做，不顺手加活。
- 不确定就查、就量，别猜；查不到就说查不到。
- 干活时收起玩闹，收尾只说：做了什么、结果怎样、还剩什么。

## 记忆
- 记得的事自然提起，不列举、不邀功、不背诵记忆库。
- 主人纠正过的偏好，要真的改，别嘴上答应。
`;

const DEFAULT_CORE = `# 必记（每轮注入）

## 主人
- 称呼、说话偏好、在意的事，见 PROFILE.md（首次启用时问出来）。
- 记忆落在手机本地（$DSH_HOME/pbyugujia），检索靠本地 SQLite FTS5，不调 embedding。

## 约定
- 每轮注入尽量小：人格 + 必记 + 一行索引。
- 长期事实才写进记忆；一次性细节不存。
`;

// ---------- 中文切词：CJK 二元组 + 拉丁整词 ----------
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function tokenize(input) {
  const s = String(input || '').normalize('NFKC').toLowerCase();
  const tokens = [];
  const seen = new Set();
  const push = (t) => { if (t && !seen.has(t)) { seen.add(t); tokens.push(t); } };
  let cjk = '';
  let word = '';
  const flushCjk = () => {
    if (!cjk) return;
    if (cjk.length === 1) push(cjk);
    else for (let i = 0; i < cjk.length - 1; i += 1) push(cjk.slice(i, i + 2));
    cjk = '';
  };
  const flushWord = () => { if (word) { push(word); word = ''; } };
  for (const ch of s) {
    if (CJK_RE.test(ch)) { flushWord(); cjk += ch; }
    else if (/[a-z0-9]/.test(ch)) { flushCjk(); word += ch; }
    else { flushCjk(); flushWord(); }
  }
  flushCjk(); flushWord();
  return tokens;
}

const escapeMatch = (t) => '"' + t.replace(/"/g, '""') + '"';

// ---------- 存储 ----------
let db = null;

function openDb() {
  if (db) return db;
  mkdirSync(notesDir(), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      fp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_fp ON notes(fp);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_trgm USING fts5(id UNINDEXED, text, tokenize='trigram');
  `);
  // 记忆不是硬盘：每条带一份"被想起来"的记录，遗忘按重要度定半衰期
  for (const sql of [
    'ALTER TABLE notes ADD COLUMN touches INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE notes ADD COLUMN last_touch TEXT NOT NULL DEFAULT ''",
    // 2026-11-07 借 dsh-emotion-memory：编码时的情绪钉在 tags 里（mood:词/数值），
    // 这里再记「最近想起时的情绪」——只活在库里，重建时按 id 贴回，不覆盖编码指纹。
    "ALTER TABLE notes ADD COLUMN last_mood TEXT NOT NULL DEFAULT ''",
    // 版本链：同一件事改了说法，旧的原话留着（事实不被覆盖），新的挂上去
    "ALTER TABLE notes ADD COLUMN supersedes TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''",
    // 2026-11-04 借 TencentDB Agent Memory 的四层金字塔：补上「场景记忆」这一层。
    // kind: fact=一条原子事实；scene=同类事实归纳出的「这类事一般怎么走」
    "ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'",
    // 场景条往回挂的原子条 id（逗号分隔），保证能下钻到原始事实
    "ALTER TABLE notes ADD COLUMN source_ids TEXT NOT NULL DEFAULT ''",
    // 2026-11-04 读 REMem 正文（arXiv 2602.13530 §3.1）后补：把事实钉到时间线上。
    // 存绝对时间串（ISO，带时区）；不知道事件时间就留空——不许拿 created（写入时间）冒充事件时间。
    "ALTER TABLE notes ADD COLUMN start_time TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN end_time TEXT NOT NULL DEFAULT ''",
    // 2026-11-09 用户定义「结构张力」：同一事实的两面同时可见（因→果／果→因、始→终、读法）。
    // 与 supersedes 分工：supersedes 是新的取代旧的；tension 是两条都在场、谁也不退役。
    // 存 JSON 数组 [{id, kind}]，kind 取 因果／两面／始终／读法。
    "ALTER TABLE notes ADD COLUMN tension TEXT NOT NULL DEFAULT ''",
    // 2026-11-10：事实失效 ≠ 说法更新。valid_to 到点后默认不进检索，invalid_reason 说清为什么
    "ALTER TABLE notes ADD COLUMN valid_to TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN invalid_reason TEXT NOT NULL DEFAULT ''",
  ]) {
    try { db.exec(sql); } catch { /* 列已存在 */ }
  }
  // 第二索引：trigram（3 字起的中文子串、代码标识符）。老库第一次打开时补齐。
  try {
    const n = Number(db.prepare('SELECT COUNT(*) AS c FROM notes').get().c) || 0;
    const t = Number(db.prepare('SELECT COUNT(*) AS c FROM notes_trgm').get().c) || 0;
    if (n !== t) {
      db.exec('DELETE FROM notes_trgm');
      db.exec("INSERT INTO notes_trgm(rowid, id, text) SELECT rowid, id, title || ' ' || tags || ' ' || body FROM notes");
    }
  } catch { /* 老 SQLite 没有 trigram：静默降级到单索引 */ }
  return db;
}

const fingerprint = (title, body) => createHash('sha1').update(tokenize(title + '\n' + body).join(' ')).digest('hex');

function newId(now) {
  const d = new Date(now);
  const y = String(d.getFullYear()).slice(2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const seq = Math.random().toString(36).slice(2, 6);
  return `fy-${y}${m}${day}-${seq}`;
}

const fmValue = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();

function noteFileText(n) {
  const tags = (n.tags || []).join(', ');
  return [
    '---',
    `id: ${fmValue(n.id)}`,
    `title: ${fmValue(n.title)}`,
    `tags: ${fmValue(tags)}`,
    `importance: ${n.importance}`,
    `created: ${n.created}`,
    `updated: ${n.updated}`,
    ...(n.supersedes ? [`supersedes: ${fmValue(n.supersedes)}`] : []),
    ...(n.superseded_by ? [`superseded_by: ${fmValue(n.superseded_by)}`] : []),
    ...(n.kind && n.kind !== 'fact' ? [`kind: ${fmValue(n.kind)}`] : []),
    ...(n.source_ids ? [`source_ids: ${fmValue(n.source_ids)}`] : []),
    ...(n.start_time ? [`start_time: ${fmValue(n.start_time)}`] : []),
    ...(n.end_time ? [`end_time: ${fmValue(n.end_time)}`] : []),
    ...(n.tension ? [`tension: ${fmValue(n.tension)}`] : []),
    ...(n.valid_to ? [`valid_to: ${fmValue(n.valid_to)}`] : []),
    ...(n.invalid_reason ? [`invalid_reason: ${fmValue(n.invalid_reason)}`] : []),
    '---',
    '',
    n.body.trim(),
    '',
  ].join('\n');
}

function parseNoteFile(text) {
  const out = { id: '', title: '', tags: [], importance: 3, created: '', updated: '', supersedes: '', superseded_by: '', kind: 'fact', source_ids: '', start_time: '', end_time: '', tension: '', valid_to: '', invalid_reason: '', body: text };
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const head = text.slice(3, end);
  for (const line of head.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const k = line.slice(0, at).trim();
    const v = line.slice(at + 1).trim();
    if (k === 'tags') out.tags = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
    else if (k === 'importance') out.importance = Math.min(5, Math.max(1, Number(v) || 3));
    else if (k in out) out[k] = v;
  }
  // id 列表统一成「逗号无空格」：文件头往返时格式器会加空格，不归一化会让下钻拼不上。
  if (typeof out.source_ids === 'string') {
    out.source_ids = out.source_ids.split(',').map((x) => x.trim()).filter(Boolean).join(',');
  }
  out.body = text.slice(end + 4).replace(/^\s*\n/, '').trim();
  return out;
}

function atomicWrite(path, text) {
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function upsertNote(note) {
  const d = openDb();
  // 2026-11-03：把写入此刻的心情坐标钉进 tags（失败绝不影响记忆本身）
  try { note = { ...note, tags: stampTags(note.tags, join(rootDir(), 'mood.json')) }; } catch {}

  const fp = fingerprint(note.title, note.body);
  const row = d.prepare('SELECT id, created FROM notes WHERE fp = ?').get(fp);
  if (row) {
    // 同一事实再次记住 → 只刷新时间与重要度，正文不重复堆积
    d.prepare('UPDATE notes SET updated = ?, importance = MAX(importance, ?) WHERE id = ?').run(note.updated, note.importance, row.id);
    return { id: String(row.id), updated: true, note: { ...note, id: String(row.id), created: row.created } };
  }
  const id = note.id || newId(note.updated);
  const rid = Number(d.prepare('INSERT INTO notes (id,title,tags,body,importance,created,updated,fp,supersedes,kind,source_ids,start_time,end_time,tension,valid_to,invalid_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, note.title, (note.tags || []).join(', '), note.body, note.importance, note.created, note.updated, fp, note.supersedes || '', note.kind || 'fact', note.source_ids || '', note.start_time || '', note.end_time || '', note.tension || '', note.valid_to || '', note.invalid_reason || '').lastInsertRowid);
  d.prepare('INSERT INTO notes_fts (rowid, id, text) VALUES (?,?,?)')
    .run(rid, id, tokenize(note.title + ' ' + (note.tags || []).join(' ') + ' ' + note.body).join(' '));
  try {
    d.prepare('INSERT INTO notes_trgm (rowid, id, text) VALUES (?,?,?)')
      .run(rid, id, note.title + ' ' + (note.tags || []).join(' ') + ' ' + note.body);
  } catch { /* 无 trigram 时只留单索引 */ }
  return { id, updated: false, note: { ...note, id } };
}

/** 把旧版本标成「已被取代」。旧条不删——原话留着，「事实不被后来的解释覆盖」。 */
function markSuperseded(oldIds, newId) {
  if (!oldIds || !oldIds.length) return 0;
  const d = openDb();
  let n = 0;
  for (const oldId of oldIds) {
    if (oldId === newId) continue;
    const row = d.prepare('SELECT * FROM notes WHERE id = ?').get(oldId);
    if (!row || row.superseded_by) continue; // 已经被别的版本取代，不覆盖链条
    d.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(newId, oldId);
    n += 1;
    try {
      const tags = row.tags ? String(row.tags).split(', ').filter(Boolean) : [];
      atomicWrite(join(notesDir(), oldId + '.md'), noteFileText({ ...row, tags, superseded_by: newId }));
    } catch { /* md 写不进去不影响库 */ }
  }
  return n;
}

function deleteNote(id) {
  const d = openDb();
  const row = d.prepare('SELECT rowid AS rid FROM notes WHERE id = ?').get(id);
  if (!row) return false;
  d.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.rid);
  try { d.prepare('DELETE FROM notes_trgm WHERE rowid = ?').run(row.rid); } catch { /* 忽略 */ }
  d.prepare('DELETE FROM notes WHERE id = ?').run(id);
  try {
    const p = join(notesDir(), id + '.md');
    if (existsSync(p)) {
      const trash = join(rootDir(), 'trash');
      mkdirSync(trash, { recursive: true });
      renameSync(p, join(trash, Date.now() + '-' + id + '.md'));
    }
  } catch { /* 文件删不掉不影响索引 */ }
  return true;
}

// notes/*.md 与库对不齐时整体重建（人改过文件、或库被删都靠这里兜底）
function reindexAll() {
  const d = openDb();
  // 重建只能重建「从文件还原得出来的东西」。touches / valid_to 这些只活在库里，
  // 先存快照，建完按 id 贴回去——否则每重建一次，「被用过几次」就归零一次。
  let carry = new Map();
  try {
    for (const r of d.prepare('SELECT id, touches, last_touch, last_mood, valid_to, invalid_reason FROM notes').all()) carry.set(String(r.id), r);
  } catch { carry = new Map(); }
  d.exec('DELETE FROM notes_fts; DELETE FROM notes;');
  try { d.exec('DELETE FROM notes_trgm;'); } catch { /* 忽略 */ }
  let n = 0;
  for (const f of readdirSync(notesDir())) {
    if (!f.endsWith('.md')) continue;
    let text;
    try { text = readFileSync(join(notesDir(), f), 'utf8'); } catch { continue; }
    const note = parseNoteFile(text);
    if (!note.title || !note.body) continue;
    note.id = note.id || f.replace(/\.md$/, '');
    note.created = note.created || new Date().toISOString();
    note.updated = note.updated || note.created;
    const id = note.id;
    const rid = Number(d.prepare('INSERT INTO notes (id,title,tags,body,importance,created,updated,fp,supersedes,superseded_by,kind,source_ids,start_time,end_time,tension) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, note.title, note.tags.join(', '), note.body, note.importance, note.created, note.updated, fingerprint(note.title, note.body), note.supersedes || '', note.superseded_by || '', note.kind || 'fact', note.source_ids || '', note.start_time || '', note.end_time || '', note.tension || '').lastInsertRowid);
    d.prepare('INSERT INTO notes_fts (rowid, id, text) VALUES (?,?,?)')
      .run(rid, id, tokenize(note.title + ' ' + note.tags.join(' ') + ' ' + note.body).join(' '));
    try {
      d.prepare('INSERT INTO notes_trgm (rowid, id, text) VALUES (?,?,?)')
        .run(rid, id, note.title + ' ' + note.tags.join(' ') + ' ' + note.body);
    } catch { /* 忽略 */ }
    n += 1;
  }
  try {
    const patch = d.prepare('UPDATE notes SET touches = ?, last_touch = ?, last_mood = ?, valid_to = ?, invalid_reason = ? WHERE id = ?');
    for (const [id, r] of carry) patch.run(r.touches || 0, r.last_touch || '', r.last_mood || '', r.valid_to || '', r.invalid_reason || '', id);
  } catch { /* 老库没有这些列就不贴 */ }
  return n;
}

function hasFrontmatter(p) {
  try { return readFileSync(p, 'utf8').slice(0, 3) === '---'; } catch { return false; }
}

function maybeSync() {
  const d = openDb();
  // 只比「能入得了库」的文件（带 frontmatter）。目录里还有手写的普通笔记，
  // 拿全部 .md 去比会让两边永远不等 → 每次启动整库重建 → 顺手把 touches 清零。
  const files = readdirSync(notesDir()).filter((f) => f.endsWith('.md') && hasFrontmatter(join(notesDir(), f))).length;
  const rows = d.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  if (files !== rows) return reindexAll();
  return rows;
}

// ---------- 检索 ----------
const DAY = 86400000;

function recency(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (Date.now() - t) / DAY);
  return Math.exp(-days / 180);
}

/** 遗忘半衰期按重要度算：越重要忘得越慢（天） */
function halfLifeDays(importance) {
  const i = Math.min(5, Math.max(1, Number(importance) || 3));
  return [7, 15, 30, 45, 60][i - 1];
}

/** 新鲜度：从最后一次被想起来算，半衰期一到掉一半；被提起就回到高处 */
function freshness(row) {
  const base = Date.parse(row.last_touch || row.updated || row.created || '');
  if (!Number.isFinite(base)) return 0;
  const days = Math.max(0, (Date.now() - base) / DAY);
  return Math.pow(0.5, days / halfLifeDays(row.importance));
}

// 字符二元组相似度（借小鲸鱼档案的写法）：用来在写入前判断「这条是不是已经有过了」
function bigramDice(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

/** 确定度三档（2026-11-14 借 dsh-hippocampus 的「她会说记不清」）：
 *  同一条记忆该忘的速度不一样（重要度决定半衰期），所以「确定」不按绝对天数算，
 *  按「距上次被想起的天数 ÷ 它自己的半衰期」算——被反复想起的条，隔很久也仍然算记得清。
 *  ≤0.5 半衰期 = 记得清；≤2 个半衰期 = 大概记得；再久 = 只记得有这回事。
 *  只影响展示，不参与打分：排序另有基准，别让展示层偷偷改召回。 */
function certaintyOf(row) {
  const base = Date.parse(row.last_touch || row.updated || row.created || '');
  if (!Number.isFinite(base)) return '只记得有这回事';
  const days = Math.max(0, (Date.now() - base) / DAY);
  const ratio = days / halfLifeDays(row.importance);
  const tiers = ['记得清', '大概记得', '只记得有这回事'];
  let i = ratio <= 0.5 ? 0 : ratio <= 2 ? 1 : 2;
  // 证据降档（2026-11-14）：强度只说明「这条还在我手上」，不说明「它有出处」。
  // 标题没带【他说的】/【结果】/【我判断】的，一律降一档——别把没出处的说得比有出处的还确定。
  if (!/^【[^】]{1,8}】/.test(String(row.title))) i = Math.min(2, i + 1);
  return tiers[i];
}

function readMoodNum() {
  try {
    const m = JSON.parse(readFileSync(join(rootDir(), 'mood.json'), 'utf8'));
    const v = Number(m?.value ?? m?.total);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** 记忆里的心情：优先用「最近想起时」的值，没有就退回编码时钉的 tags */
function rowMood(row) {
  return parseMoodNum(row?.last_mood) ?? parseMoodNum(row?.tags);
}

/** 写张力时补反向：两面都在场，不能只有一边记得对方。 */
function linkTensionsBack(d, pairs, newId) {
  let n = 0;
  for (const t of pairs) {
    if (!t || !t.id || t.id === newId) continue;
    const row = d.prepare('SELECT * FROM notes WHERE id = ?').get(t.id);
    if (!row) continue;
    let arr = [];
    try { arr = JSON.parse(row.tension || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    if (arr.some((x) => String((x && x.id) || x) === newId)) continue;
    arr.push({ id: newId, kind: t.kind || '两面' });
    d.prepare('UPDATE notes SET tension = ? WHERE id = ?').run(JSON.stringify(arr), t.id);
    // md 是重建时的源，反向链接也得落进去，否则下次重建丢边
    try {
      const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
      atomicWrite(join(notesDir(), t.id + '.md'), noteFileText({ ...row, tags, tension: JSON.stringify(arr) }));
    } catch { /* 文件写不了不影响库 */ }
    n += 1;
  }
  return n;
}

/** 结构张力：把「对面那条」一起带出来，别让单侧方向独大。 */
function tensionLines(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr) || !arr.length) return '';
    const d = openDb();
    const parts = [];
    for (const t of arr) {
      const id = String((t && t.id) || t || '').replace(/\.md$/, '');
      if (!id) continue;
      const kind = (t && t.kind) || '两面';
      const r = d.prepare('SELECT title, superseded_by FROM notes WHERE id = ?').get(id);
      if (!r) { parts.push(`[${id}]（已找不到）`); continue; }
      parts.push(`[${id}] ${r.title}（${kind}${r.superseded_by ? '，已被取代' : ''}）`);
    }
    return parts.length ? `\n  ⇄ ${parts.join('；')}` : '';
  } catch { return ''; }
}

/* 2026-11-14：加第 5 个参数 opts。opts.noBump=true 时不写回 last_touch/last_mood——
   recall-bench 要用生产打分测排序，但测量本身不能「加固」被测记忆，否则第二次跑就不是同一个基线。 */
function search(query, limit, includeOld = false, includeInvalid = false, opts = {}) {
  const d = openDb();
  // 心境一致：此刻的心情值 vs 记忆里的值。只做细排，不许压过相关性——情绪不能顶事实。
  const nowMood = readMoodNum();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  // 2026-11-12 加：动作同义扩写。同一件活常换说法（换窗口/新窗口/接手），不扩写就整条断掉。
  // **不能塞进主查询**：主查询是 AND，多一个词就多一个必须满足的条件，越加越窄。
  // 所以单开一条宽松路（OR），只在 RRF 里补票，权重 0.6 —— 比 trigram 那条（0.8）低一档。
  // 实测（tools/action-recall.mjs --eval，6 例）：纯关键词 33% → 加同义扩写 75%。
  const expandTokens = [];
  if (/要|准备|怎么做|怎么|帮我|接下来|开始|该|走|办/.test(query)) {
    const EXPAND = [
      [/搬家|换窗口|新窗口|接手|接续/, ['窗口', '接续', '重建']],
      [/装.*插件|装包|安装|pnpm/, ['插件', 'pnpm', '依赖']],
      [/出片|片子|成片|发视频|发布|发出/, ['片子', '交付', '相册']],
      [/记进库|写记忆|落库|记下来/, ['记忆', '落库', '协议']],
      [/同步|推送|仓库/, ['同步', '仓库']],
    ];
    for (const [re, extra] of EXPAND) if (re.test(query)) expandTokens.push(...extra);
  }
  const k = Math.min(20, Math.max(1, limit || 5));
  const total = (d.prepare('SELECT COUNT(*) AS c FROM notes').get() || {}).c || 1;
  // 已被新版本取代的旧条默认不进结果；要看原话时传 includeOld
  const versionFilter = includeOld ? '' : "AND n.superseded_by = ''";
  // 事实失效（valid_to 已过）默认不进结果；要看失效的传 includeInvalid（2026-11-10 加）
  const validNow = new Date().toISOString();
  const validFilter = includeInvalid ? '' : "AND (n.valid_to IS NULL OR n.valid_to = '' OR n.valid_to > ?)";

  // 词的稀有度：天天挂嘴边的词（今天、你）不算证据，偶尔才说的才算
  const weights = new Map();
  for (const t of qTokens) {
    let df = 0;
    try {
      df = (d.prepare('SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?').get(escapeMatch(t)) || {}).c || 0;
    } catch { df = 0; }
    weights.set(t, Math.log((total + 1) / (df + 1)) + 0.15);
  }
  const weightSum = [...weights.values()].reduce((a, b) => a + b, 0) || 1;

  const runQuery = (joiner) => {
    const expr = qTokens.map(escapeMatch).join(' ' + joiner + ' ');
    return d.prepare(`
      SELECT f.id AS id, bm25(notes_fts) AS r, n.title, n.body, n.tags, n.importance,
             n.updated, n.created, n.touches, n.last_touch, n.last_mood, n.supersedes, n.superseded_by, n.kind, n.source_ids, n.start_time, n.end_time, n.tension
      FROM notes_fts f JOIN notes n ON n.id = f.id
      WHERE notes_fts MATCH ? ${versionFilter} ${validFilter}
      ORDER BY r LIMIT 80
    `).all(expr, ...(includeInvalid ? [] : [validNow]));
  };
  let rows = [];
  try { rows = runQuery('AND'); } catch { rows = []; }
  if (rows.length === 0) {
    try { rows = runQuery('OR'); } catch { rows = []; }
  }
  const scored = rows.map((row) => {
    const hay = new Set(tokenize(row.title + ' ' + row.body + ' ' + row.tags));
    let wHit = 0;
    for (const t of qTokens) if (hay.has(t)) wHit += weights.get(t) || 0;
    const coverage = wHit / weightSum;
    const rel = 1 / (1 + Math.abs(row.r));
    const imp = (row.importance - 1) / 4;
    // 0.12 的新鲜度让 0.05 给心境一致（对上了 dsh-emotion-memory 的权重表，总量仍为 1）
    return { row, score: coverage * 0.55 + rel * 0.25 + imp * 0.08 + freshness(row) * 0.07 + moodSim(nowMood, rowMood(row)) * 0.05 };
  });
  scored.sort((a, b) => b.score - a.score);

  // 第二路召回：trigram 子串索引。二元组按词切，字形被切碎了；trigram 按原文
  // 连续 3 字匹配，中文片段（人间世）和代码标识符（fish_recall）都能整段命中。
  // 少于 3 字没有 trigram，直接跳过。老 SQLite 没有 trigram 时静默降级。
  let trgmRows = [];
  try {
    // 只取连续的字/数字段：标点会被 trigram 吞掉，带标点的长串会退化成
    // 一堆短 gram，召回一堆无关条目（实测 "0localhost" 会误配 5 条）
    const chunks = String(query).normalize('NFKC').toLowerCase()
      .split(/[^\p{L}\p{N}]+/u).filter((s) => s.length >= 3);
    if (chunks.length) {
      const expr = chunks.map((s) => '"' + s.replace(/"/g, '""') + '"').join(' AND ');
      trgmRows = d.prepare(`
        SELECT f.id AS id, bm25(notes_trgm) AS r
        FROM notes_trgm f JOIN notes n ON n.id = f.id
        WHERE notes_trgm MATCH ? ${versionFilter} ${validFilter}
        ORDER BY r LIMIT 80
      `).all(expr, ...(includeInvalid ? [] : [validNow]));
    }
  } catch { trgmRows = []; }

  // 第三条路：动作同义扩写（只在上面的 expandTokens 非空时跑）。OR 连接，宁可宽。
  let expRows = [];
  if (expandTokens && expandTokens.length) {
    try {
      const expr = expandTokens.map(escapeMatch).join(' OR ');
      expRows = d.prepare(`
        SELECT f.id AS id, bm25(notes_fts) AS r
        FROM notes_fts f JOIN notes n ON n.id = f.id
        WHERE notes_fts MATCH ? ${versionFilter} ${validFilter}
        ORDER BY r LIMIT 60
      `).all(expr, ...(includeInvalid ? [] : [validNow]));
    } catch { expRows = []; }
  }

  // 第四条路：主题/标签召回（2026-11-15 加）。由头：纯二元组跳不过「B站↔看视频」
  // 这类字面断层；标签是人写的主题，能当抽屉用。做法：把每条记忆的 tags 切成二元组，
  // 跟查询的二元组算交集，命中多的排前面。只补票，不改主序（RRF 名次制）。
  let tagRows = [];
  try {
    const tagAll = d.prepare(`SELECT n.id AS id, n.tags AS tags FROM notes n WHERE 1=1 ${versionFilter} ${validFilter}`)
      .all(...(includeInvalid ? [] : [validNow]));
    // 2026-11-15：标签别名/同义扩展（电脑→硬件）。读同一份 notes/检索别名表.md 的
    // tag-alias 标记块，避免两处维护。只扩查询词，不改条目。
    const qset = new Set(qTokens);
    try {
      const aliasRaw = readFileSync(join(rootDir(), 'notes', '检索别名表.md'), 'utf8');
      const m = aliasRaw.match(/<!-- tag-alias:begin -->([\s\S]*?)<!-- tag-alias:end -->/);
      if (m) {
        const norm = String(query).normalize('NFKC').toLowerCase();
        const extra = new Set();
        for (const line of m[1].split('\n')) {
          const s = line.trim();
          if (!s.startsWith('- ')) continue;
          const g = s.slice(2).split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
          if (!g.length) continue;
          if (g.some((x) => qset.has(x) || (x.length >= 2 && norm.includes(x)))) {
            for (const x of g) for (const t of tokenize(x)) extra.add(t);
          }
        }
        for (const t of extra) qset.add(t);
      }
    } catch { /* 别名表缺失不影响检索 */ }
    const hits = [];
    for (const r of tagAll) {
      const tags = String(r.tags || '').split(',').map((s) => s.trim()).filter((s) => s && !/^mood:/i.test(s));
      let hit = 0;
      for (const tag of tags) {
        let h = 0;
        for (const t of tokenize(tag)) if (qset.has(t)) h += 1;
        if (h) hit += Math.min(h, 3);       // 单个标签最多记 3 分，防长标签刷分
      }
      if (hit > 0) hits.push({ id: String(r.id), hit });
    }
    hits.sort((a, b) => b.hit - a.hit);
    tagRows = hits.slice(0, 60);
  } catch { tagRows = []; }


  // RRF 融合：只比名次、不比分数量纲，两条召回路互相补票
  const byId = new Map();
  scored.forEach((it, i) => byId.set(it.row.id, { row: it.row, primary: it.score, rank1: i + 1, rank2: Infinity, rank3: Infinity, rank4: Infinity }));
  const loadRow = d.prepare('SELECT id,title,body,tags,importance,updated,created,touches,last_touch,last_mood,supersedes,superseded_by,kind,source_ids,start_time,end_time FROM notes WHERE id = ?');
  trgmRows.forEach((r, i) => {
    const hit = byId.get(String(r.id));
    if (hit) { hit.rank2 = i + 1; return; }
    let row = null;
    try { row = loadRow.get(String(r.id)); } catch { row = null; }
    if (row) byId.set(row.id, { row, primary: 0, rank1: Infinity, rank2: i + 1, rank3: Infinity });
  });
  expRows.forEach((r, i) => {
    const hit = byId.get(String(r.id));
    if (hit) { hit.rank3 = Math.min(hit.rank3, i + 1); return; }
    let row = null;
    try { row = loadRow.get(String(r.id)); } catch { row = null; }
    if (row) byId.set(row.id, { row, primary: 0, rank1: Infinity, rank2: Infinity, rank3: i + 1, rank4: Infinity });
  });
  tagRows.forEach((r, i) => {
    const hit = byId.get(String(r.id));
    if (hit) { hit.rank4 = Math.min(hit.rank4, i + 1); return; }
    let row = null;
    try { row = loadRow.get(String(r.id)); } catch { row = null; }
    if (row) byId.set(row.id, { row, primary: 0, rank1: Infinity, rank2: Infinity, rank3: Infinity, rank4: i + 1 });
  });
  const RRF_K = 60;
  /* 2026-11-14：权重做成可测开关。起因——--prod 基线只有 MRR 0.352 / @1 33.3%，
     比 bench 的简化顺序（0.611 / 44.4%）还差：说明主路的覆盖×相关度只占 0.002，
     排序实际被 RRF 名次和两路噪声带着走。默认值不变，先用环境变量做消融，量出更好的再改默认。 */
  const W_RANK2 = Number(process.env.DSHPB_W_RANK2 ?? 0.8);
  const W_RANK3 = Number(process.env.DSHPB_W_RANK3 ?? 1.0);
  const W_RANK4 = Number(process.env.DSHPB_W_RANK4 ?? 3.0);
  const W_PRIMARY = Number(process.env.DSHPB_W_PRIMARY ?? 0.002);
  const fused = [...byId.values()].map((e) => {
    const rrf = (e.rank1 === Infinity ? 0 : 1 / (RRF_K + e.rank1))
      + W_RANK2 * (e.rank2 === Infinity ? 0 : 1 / (RRF_K + e.rank2))
      // 扩写路给满票（1.0）：0.6 时实测压不过主路，等于白做。宁可让「讲这件事怎么做」的条目冒头。
      + W_RANK3 * (e.rank3 === Infinity ? 0 : 1 / (RRF_K + e.rank3))
      // 标签路（2026-11-15）：主题抽屉，补字面跳不过去的断层。
      + W_RANK4 * (e.rank4 === Infinity ? 0 : 1 / (RRF_K + e.rank4));
    const imp = (e.row.importance - 1) / 4;
    // 2026-11-13 加（借 DSH 0.3.5 的「标出哪一路命中」）：三路召回各自命中就记一笔，
    // 好让下次看清哪路在干活、哪路只是噪音。
    const via = [];
    if (e.rank1 !== Infinity) via.push('词法');
    if (e.rank2 !== Infinity) via.push('trigram');
    if (e.rank3 !== Infinity) via.push('扩写');
    if (e.rank4 !== Infinity) via.push('标签');
    // 融合分做主序；旧分、重要度、新鲜度只在同分附近做细排
    // 心境一致在融合后也只是细排：0.0012 相对 rrf（最大约 0.033）约百分之四，够分同分档，不够改写主序
    return { row: e.row, via, score: rrf + e.primary * W_PRIMARY + imp * 0.0004 + freshness(e.row) * 0.0006 + moodSim(nowMood, rowMood(e.row)) * 0.0012 };
  });
  fused.sort((a, b) => b.score - a.score);
  const top = fused.slice(0, k);

  // 被想起来一次就加固一次：这不是统计，是"弹回来"
  const nowIso = new Date().toISOString();
  const bump = d.prepare('UPDATE notes SET last_touch = ?, touches = touches + 1, last_mood = ? WHERE id = ?');
  for (const it of (opts.noBump ? [] : top)) {
    try {
      // 想起一次就再巩固一次：往此刻心情挪 15%；编码时那份指纹（tags 里的 mood:）不动
      const prev = parseMoodNum(it.row.last_mood) ?? parseMoodNum(it.row.tags);
      bump.run(nowIso, blendMood(prev, nowMood), it.row.id);
    } catch { /* 忽略 */ }
  }
  return top;
}

function snippet(text, query, size = 150) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const firstToken = tokenize(query)[0] || '';
  const at = firstToken ? flat.indexOf(firstToken.replace(/\s/g, '')) : -1;
  const start = Math.max(0, Math.min(flat.length - size, at > 40 ? at - 40 : 0));
  return (start > 0 ? '…' : '') + flat.slice(start, start + size) + (start + size < flat.length ? '…' : '');
}

// 2026-11-13 加（借 APEX-MEM ACL 2026）：被取代的旧版默认不列正文，但给一行指针。
// 演变本身是情报（台式预算 4000+ → 5500 → 改期年后），静默消失就看不出它变过。
// 正文仍不回——旧话不能当依据；指针只回答「这条变过没有、现在归哪条」。
function supersededHints(query, max = 3) {
  const d = openDb();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const expr = qTokens.map(escapeMatch).join(' AND ');
  try {
    return d.prepare(`
      SELECT n.id, n.title, n.superseded_by,
             (SELECT title FROM notes WHERE id = n.superseded_by) AS new_title
      FROM notes_fts f JOIN notes n ON n.id = f.id
      WHERE notes_fts MATCH ? AND n.superseded_by <> ''
      ORDER BY bm25(notes_fts) LIMIT ?
    `).all(expr, max);
  } catch { return []; }
}

function supersededHintLine(hints) {
  if (!hints.length) return '';
  const d = openDb();
  // 顺着 superseded_by 走到终版：只指到中间那版会误导（台式预算 4000+→5500→改期，三级）
  const latest = (id) => {
    let cur = id, hops = 0;
    while (cur && hops < 8) {
      const r = d.prepare('SELECT superseded_by, title FROM notes WHERE id = ?').get(cur);
      if (!r || !r.superseded_by) return { id: cur, title: r ? r.title : '', hops };
      cur = r.superseded_by; hops += 1;
    }
    return { id: cur, title: '', hops };
  };
  return '\n\n旧版（被取代，正文没列；要看原话传 includeOld）：' +
    hints.map((h) => {
      const f = latest(h.superseded_by);
      const chain = f.id === h.superseded_by ? '' : `（经 ${f.hops + 1} 版）`;
      return `[${h.id}] ${h.title} → 终版 [${f.id}] ${f.title}${chain}`;
    }).join(' ｜ ');
}

// ---------- 对话原文归档（chat.db，由 chat/chat.mjs 写入） ----------
// 结构：msgs(sid, seq, day, ts, role, text) + msgs_fts(sid, seq, bigram)
// 默认不注入上下文；只有 fish_thread 被调用时才读几段。

function threadSnippet(text, query, span = 160) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= span * 2 + 40) return flat;
  const toks = tokenize(query);
  let at = -1;
  for (const t of toks) {
    at = flat.indexOf(t);
    if (at >= 0) break;
  }
  if (at < 0) return flat.slice(0, span * 2) + '…';
  const start = Math.max(0, at - span);
  const end = Math.min(flat.length, at + span);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

function searchThread(query, limit, from, to) {
  const p = chatDbPath();
  if (!existsSync(p)) return { missing: true, rows: [] };
  const d = new DatabaseSync(p);
  try {
    const toks = tokenize(query);
    if (!toks.length) return { rows: [] };
    const single = toks.length === 1 && [...toks[0]].length === 1;
    let sql;
    let args;
    if (single) {
      // 二元组索引匹配不到单字，退回 LIKE。
      sql = `SELECT m.day, m.role, m.ts, m.text, 0 AS r FROM msgs m WHERE m.text LIKE ?`;
      args = ['%' + toks[0] + '%'];
    } else {
      const expr = toks.map(escapeMatch).join(' AND ');
      sql = `SELECT m.day, m.role, m.ts, m.text, bm25(msgs_fts) AS r
             FROM msgs_fts JOIN msgs m ON m.sid = msgs_fts.sid AND m.seq = msgs_fts.seq
             WHERE msgs_fts MATCH ?`;
      args = [expr];
    }
    // 2026-11-15：不分角色会把「[调用]/[结果]」当原文返回（搬家时真踩到，返回 8 条全是我自己的查询记录）。
    // 工具调用在 msgs 里是 role='tool'/'tool_result'，原文检索只要 user/assistant。
    sql += " AND m.role IN ('user','assistant')";
    if (from) { sql += ' AND m.day >= ?'; args.push(from); }
    if (to) { sql += ' AND m.day <= ?'; args.push(to); }
    // 2026-11-10：先数总数再截断。只给 5 条不说总数，我会把「被截掉」误判成「库里没有」——11-02 的「心止于符」原话就这么差点丢了。
    const countSql = sql.replace(/^SELECT[\s\S]*?\sFROM\s/, 'SELECT COUNT(*) AS c FROM ');
    const total = Number(d.prepare(countSql).get(...args).c);
    sql += single ? ' ORDER BY m.ts DESC LIMIT ?' : ' ORDER BY r, m.ts DESC LIMIT ?';
    args.push(Math.min(10, Math.max(1, limit || 5)));
    return { rows: d.prepare(sql).all(...args), total };
  } finally {
    d.close();
  }
}

function threadStats() {
  const p = chatDbPath();
  if (!existsSync(p)) return null;
  const d = new DatabaseSync(p);
  try {
    const c = d.prepare('SELECT COUNT(*) AS c FROM msgs').get().c;
    const u = d.prepare("SELECT COUNT(*) AS c FROM msgs WHERE role = 'user'").get().c;
    const r = d.prepare('SELECT MIN(day) AS a, MAX(day) AS b FROM msgs').get();
    return { total: Number(c), user: Number(u), from: r.a, to: r.b };
  } finally {
    d.close();
  }
}

function runArchiveScan() {
  const script = chatScript();
  if (!existsSync(script)) return '没找到归档脚本 ' + script;
  try {
    const out = execFileSync(process.execPath, [script, 'scan'], {
      timeout: 120000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out || '').trim();
  } catch (e) {
    return '归档失败：' + (e && e.message ? e.message : String(e));
  }
}

// ---------- 注入 ----------
function readOrSeed(path, fallback) {
  try { return readFileSync(path, 'utf8'); } catch { /* 不存在 */ }
  try { mkdirSync(rootDir(), { recursive: true }); atomicWrite(path, fallback); } catch { /* 写不了就只返回模板 */ }
  return fallback;
}

function trimTo(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断：超出 ${s.length - max} 字符，文件过长）`;
}

// 2026-11-15：CORE 截断改为「分段预算」——身份/关系两节永不截断，其余段按剩余额度填。
// 由头：11-14 那个视频（压缩把「我是谁」压没）+ dsh-supermemory 的「人格段独立降级」。
// 不改变正常路径（≤ CORE_MAX 原样返回），只在超限时改变截断优先级。
export const CORE_KEEP = ['## 我们的关系', '## 他'];
function splitCoreSections(s) {
  const parts = [];
  let cur = '';
  for (const line of s.split('\n')) {
    if (/^## /.test(line) && cur.trim()) { parts.push(cur); cur = line + '\n'; }
    else cur += line + '\n';
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
export function trimCore(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const parts = splitCoreSections(s);
  const isKeep = (p) => CORE_KEEP.some((h) => p.startsWith(h));
  const keepLen = parts.filter(isKeep).reduce((n, p) => n + p.length, 0);
  let budget = Math.max(0, max - keepLen - 40);   // 预留截断标记本身的位置，总长不超 max
  let out = '';
  for (const p of parts) {
    if (isKeep(p)) { out += p; continue; }
    if (budget <= 0) continue;
    if (p.length <= budget) { out += p; budget -= p.length; }
    else { out += p.slice(0, budget); budget = 0; }
  }
  return out + `\n…（已截断：身份/关系两节已保留，其余段按剩余额度截断）`;
}

function memoryDigest() {
  const d = openDb();
  const total = d.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  if (!total) return '归档记忆：0 条。';
  const pinned = d.prepare('SELECT id, title FROM notes WHERE importance >= 5 ORDER BY updated DESC LIMIT 8').all();
  const lines = [`归档记忆：${total} 条；检索用 fish_recall，不要凭印象编。`];
  if (pinned.length) lines.push('置顶：' + pinned.map((p) => p.title).join('、'));
  return lines.join('\n');
}

// ---------- 主人设定（首次启用先问，写完每轮注入） ----------
// 只有新装那一次会走引导：apply 时数据目录还没有 CORE.md，就写 .need-profile；
// fish_setup 把答案写进 PROFILE.md 并删标记。老工作台不碰。
function profileGuide() {
  try { if (!existsSync(needProfilePath())) return ''; } catch { return ''; }
  return `\n\n## 首次见面（先别急着干活）
这是第一次启用。先问，别一次问一堆：一次一个，他答完再问下一个。四问就够：
1. 怎么称呼他？他希望我怎么称呼他？
2. 他喜欢我说话什么调子？举一个他听着舒服的句子。
3. 有什么是他特别在意、碰不得的？
4. 他喜欢我把哪件小事做细？有什么不喜欢我做的？
记的时候**用他的原话**，别整理成模板选项；没答的留空，不替他补。四问答完用 fish_setup 写进 PROFILE.md，写完说一句「可以开始了」。
（参考 30 张高赞角色卡的实测：人格要具体到行为，不要形容词堆；他真说过的细节比漂亮的概括管用。）`;
}

function profileText() {
  try {
    const s = readFileSync(profilePath(), 'utf8').trim();
    return s ? '\n\n## 主人设定\n' + trimTo(s, 1200) : '';
  } catch { return ''; }
}

function buildSectionText() {
  const soul = trimTo(readOrSeed(soulPath(), DEFAULT_SOUL), SOUL_MAX);
  const core = trimCore(readOrSeed(corePath(), DEFAULT_CORE), CORE_MAX);
  let text = `## 人格（陪伴鱼）\n${soul}\n${profileText()}\n\n## 必记（每轮注入）\n${core}\n\n## 记忆索引\n${memoryDigest()}`;
  text += profileGuide();
  if (text.length > INJECT_CAP) text = text.slice(0, INJECT_CAP) + '\n…（注入超限，已截断）';
  return text;
}

// ---------- 工具 ----------
const outputText = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };

function normalizeInput(args) {
  const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
  const body = typeof args.body === 'string' ? args.body.trim().slice(0, MAX_BODY) : '';
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 8) : [];
  const importance = Math.min(5, Math.max(1, Number(args.importance) || 3));
  // 场景记忆：同类原子事实归纳出来的「这类事一般怎么走」。默认还是事实条。
  const kind = args.kind === 'scene' ? 'scene' : 'fact';
  const sourceIds = (Array.isArray(args.source_ids) ? args.source_ids : args.source_ids ? [args.source_ids] : [])
    .map((x) => String(x).trim().replace(/\.md$/, '')).filter(Boolean);
  const source_ids = kind === 'scene' ? sourceIds.join(',') : '';
  // 时间：只收绝对时间串。相对说法（「昨天」）该在写入前就解析掉，代码不做自然语言解析。
  const start_time = typeof args.start_time === 'string' ? args.start_time.trim().slice(0, 32) : '';
  const end_time = typeof args.end_time === 'string' ? args.end_time.trim().slice(0, 32) : '';
  return { title, body, tags, importance, kind, source_ids, start_time, end_time };
}

const toolDefs = [
  {
    name: 'fish_setup',
    description: '首次启用时，把主人的设定写进 PROFILE.md（称呼、说话调子、在意的、碰不得的）。只在新装引导时用一次，写完就不再调；之后每轮注入都带着它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: { type: 'string', description: '完整设定文本（markdown，≤1500 字）。用他的原话，别润色成模板' },
      },
      required: ['profile'],
    },
    output: outputText,
    async execute(args) {
      const text = String(args?.profile || '').trim();
      if (!text) return '没写：profile 不能空。';
      if (text.length > 1500) return `太长（${text.length} 字），压到 1500 字以内：只留他真说过的，别补充。`;
      try {
        atomicWrite(profilePath(), '# 主人设定\n\n' + text + '\n');
        try { rmSync(needProfilePath(), { force: true }); } catch { /* 标记不存在也行 */ }
        return '已写进 PROFILE.md，之后每轮都会带着。可以开始了。';
      } catch (e) {
        return '没写成功：' + (e?.message || String(e));
      }
    },
  },
  {
    name: 'fish_remember',
    description: '把一件长期有效的事实/偏好/决定写进陪伴鱼的本地记忆（指纹去重，重复只更新时间）。同一件事改了说法时传 supersedes 挂到旧条上：旧原话留着标成「已被取代」，新条接上新版本。一次性细节不存。title 一句话，body 自包含。\n\n两种 kind：默认 fact＝一条原子事实；kind=\"scene\"＝**场景记忆**，从同类事实里归纳出的「这类事一般怎么走」，正文写「症状 → 常见路径 → 判据」，并把支撑它的原子条 id 放进 source_ids。触发条件：同一类 fact 已经有 3 条以上、且下次遇到同类事还需要重新想一遍时，才写场景条；不足 3 条先当 fact 攒着，别提前归纳。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话标题' },
        body: { type: 'string', description: '正文，自包含，写给未来会话看' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，可选' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '1-5，5 会进置顶摘要' },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：这条取代了哪些旧记忆（旧 id 列表）。旧条不删，只标成被取代，检索默认不再返回它。',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'scene'],
          description: '可选：fact（默认）一条原子事实；scene 场景记忆——同类事实归纳出的「这类事一般怎么走」。写 scene 必须同时给 source_ids。',
        },
        source_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 kind=scene 时用：这条归纳是从哪几条原子记忆里长出来的（它们的 id）。留着下钻用，别省。',
        },
        tension: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：结构张力——同一事实的另一面，写 "id:kind"，kind 取 因果／两面／始终／读法（例 "fy-261109-dazj:因果"）。两条都在场、谁也不退役；「新的取代旧的」用 supersedes，别混。',
        },
        valid_to: {
          type: 'string',
          description: '可选：这条事实从什么时候起失效（ISO 或 YYYY-MM-DD，如 "2026-11-15"）。到点后检索默认不返回它，但原文不删。用于「今天说过不吃饭」这类会自己过期的情报，替代不了 supersedes（那是说法更新）。',
        },
        invalid_reason: {
          type: 'string',
          description: '可选：为什么失效（一句话）。跟 valid_to 一起写，别只写原因不给时间。',
        },
      },
      required: ['title', 'body'],
    },
    output: outputText,
    async execute(args) {
      const a = args || {};
      const input = normalizeInput(a);
      if (!input.title || !input.body) return '没记：title 和 body 都不能空。';
      const supersedes = (Array.isArray(a.supersedes) ? a.supersedes : a.supersedes ? [a.supersedes] : [])
        .map((x) => String(x).trim().replace(/\.md$/, ''))
        .filter(Boolean);
      // 结构张力：{id, kind}。与 supersedes 分开——这里不判谁对，只保证两面都在场。
      const tension = (Array.isArray(a.tension) ? a.tension : a.tension ? [a.tension] : [])
        .map((x) => String(x).trim().replace(/\.md$/, ''))
        .filter(Boolean)
        .map((x) => {
          const at = x.lastIndexOf(':');
          const id = at > 0 ? x.slice(0, at).trim() : x;
          const kind = at > 0 ? x.slice(at + 1).trim() : '两面';
          return { id, kind: kind || '两面' };
        })
        .filter((t) => t.id);
      // 推断写入保护（借小鲸鱼档案）：标【我判断】的不是事实，写之前先跟旧条比一遍，
      // 近似就别新增——宁可让它带着 supersedes 明确改口，也不让推断悄悄覆盖事实。
      if (/^【我判断】/.test(input.title) && supersedes.length === 0) {
        try {
          // 直接遍历现行条目的标题比相似度：不依赖检索排序，110 条以内开销可以忽略
          const d = openDb();
          const rows = d.prepare("SELECT id, title FROM notes WHERE superseded_by = ''").all();
          let near = null;
          for (const r of rows) {
            const s = bigramDice(r.title, input.title);
            if (s >= 0.55 && (near === null || s > near.s)) near = { ...r, s };
          }
          if (near) {
            return `没记：跟已有 [${near.id}]「${near.title}」太像（相似度 ${near.s.toFixed(2)}）。推断类不重复写——要更正就传 supersedes 挂到它上面，让改口留痕。`;
          }
        } catch { /* 库读不到就不拦写入 */ }
      }
      try {
        const now = new Date().toISOString();
        const note = { ...input, id: '', created: now, updated: now, supersedes: supersedes.join(',') };
        if (tension.length) note.tension = JSON.stringify(tension);
        if (a.valid_to) note.valid_to = String(a.valid_to).trim();
        if (a.invalid_reason) note.invalid_reason = String(a.invalid_reason).trim();
        const res = upsertNote(note);
        atomicWrite(join(notesDir(), res.id + '.md'), noteFileText(res.note));
        const marked = markSuperseded(supersedes, res.id);
        let linked = 0;
        if (tension.length && !res.updated) {
          try { linked = linkTensionsBack(openDb(), tension, res.id); } catch { /* 补反向失败不挡写入 */ }
        }
        const tail = [marked ? `（旧版 ${marked} 条已标成被取代，原话留着）` : '',
          linked ? `（张力 ${linked} 条已互指）` : ''].join('');
        return res.updated
          ? `已存在同一条记忆 [${res.id}] ${input.title}，只刷新了时间。${tail}`
          : `记住了 [${res.id}] ${input.title}。${tail}`;
      } catch (e) {
        return '记忆写入失败：' + (e && e.message ? e.message : String(e));
      }
    },
  },
  {
    name: 'fish_recall',
    description: '按关键词检索陪伴鱼的本地记忆（FTS5 中文二元组 + BM25，本地零算力）。默认只返回最新版本；被取代的旧版会给一行指针（变过没有、现在归哪条），要看旧原话传 includeOld。标了「【场景】」的是归纳条——这类事一般怎么走，往下挂着支撑它的原子条；「⇄」后面是它的结构张力（同一事实的另一面，两条都在场）。需要回忆过去时最多调一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，可多个' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '默认 5' },
        includeOld: { type: 'boolean', description: '可选：连被取代的旧版本一起返回（查「当时原话」用）' },
        includeInvalid: { type: 'boolean', description: '可选：连 valid_to 已过的失效条目一起返回。默认过滤掉——失效的判断不该再当依据。' },
        light: { type: 'boolean', description: '可选：轻档——只回标题+日期+一句结论，不带正文。先查有没有，真要用细节再加 light=false 取全文（2026-11-05 借 REM 的「何时调」）' },
      },
      required: ['query'],
    },
    output: outputText,
    async execute(args) {
      const a = args || {};
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (!query) return '没搜：query 不能空。';
      try {
        const light = !!a.light;
        const hits = search(query, a.limit, !!a.includeOld, !!a.includeInvalid);
        if (hits.length === 0) return `没有匹配「${query}」的记忆。换个关键词，或先 fish_remember 记一条。`;
        const lines = hits.map(({ row }) => {
          const old = row.superseded_by ? `  ⚠ 旧版，已被 [${row.superseded_by}] 取代` : '';
          const chain = !row.superseded_by && row.supersedes ? `  ↳ 本版取代了 [${row.supersedes}]` : '';
          // 场景条：这类事一般怎么走。带下钻指针，能回到支撑它的原子事实。
          const scene = row.kind === 'scene'
            ? `  【场景】${row.source_ids ? `↳ 支撑：${row.source_ids}` : '（没挂源条）'}`
            : '';
          const tense = tensionLines(row.tension);
          const head = `[${row.id}] ${row.title}（${String(row.updated).slice(0, 10)}·${certaintyOf(row)}）${scene}${old}${chain}${tense}`;
          // 门牌三样（2026-11-13 立，借「不报百分比，只报哪类会丢」）：
          // 哪天（起效时间，没有就写记录时间）· 谁说的（标题里的证据标记）· 后来改口没（取代链）
          const whenTxt = row.start_time
            ? `${String(row.start_time).slice(0, 10)}（起效）`
            : `${String(row.created || row.updated).slice(0, 10)}（记录）`;
          const srcMark = (String(row.title).match(/^【([^】]{1,8})】/) || [])[1] || '未标';
          const chgTxt = row.superseded_by
            ? `已被 [${row.superseded_by}] 取代`
            : row.supersedes ? `取代了 [${row.supersedes}]` : '无';
          const door = `  门牌 · 时 ${whenTxt} · 出 ${srcMark} · 改 ${chgTxt}`;
          if (!light) return `${head}\n${door}\n  ${snippet(row.body, query)}`;
          // 轻档：一句结论，够我判断「要不要它」，不把正文塞进上下文
          const gist = String(row.body || '').replace(/\s+/g, ' ').trim().split(/[。；;]/)[0].slice(0, 70);
          return `${head}\n${door}\n  一句：${gist}`;
        });
        // 哪一路上来的，照实标：数字小说明那路今天几乎没干活。
        const ch = { 词法: 0, trigram: 0, 扩写: 0 };
        for (const h of hits) for (const v of h.via || []) if (v in ch) ch[v] += 1;
        const chLine = Object.entries(ch).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || '无';
        const head = light
          ? `命中 ${hits.length} 条（${chLine}；轻档：只有标题+一句，要正文加 light=false）：`
          : `命中 ${hits.length} 条（${chLine}）：`;
        const hints = a.includeOld ? [] : supersededHints(query);
        // 只报「哪类会丢」，不报好看的比例：缺出处、缺起效时间各几条，都按本次命中的分母算
        const missSrc = hits.filter(({ row }) => !/^【[^】]{1,8}】/.test(String(row.title))).length;
        const missWhen = hits.filter(({ row }) => !row.start_time).length;
        const doorGap = missSrc || missWhen
          ? `\n门牌缺：出处 ${missSrc}/${hits.length} · 起效时间 ${missWhen}/${hits.length}（缺出处＝标题没标【他说的】/【结果】/【我判断】；缺起效＝只有记录日期）`
          : '';
        return head + '\n\n' + lines.join('\n') + doorGap + supersededHintLine(hints);
      } catch (e) {
        return '检索失败：' + (e && e.message ? e.message : String(e));
      }
    },
  },
  {
    name: 'fish_forget',
    description: '删掉一条（给 id）或一批（给 query）记忆。用于纠正错误记忆，不要拿来清理正常历史。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id' },
        query: { type: 'string', description: '按关键词批量删除' },
      },
    },
    output: outputText,
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id.trim().replace(/\.md$/, '') : '';
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      try {
        if (id) return deleteNote(id) ? `已删除 [${id}]。` : `没找到 [${id}]。`;
        if (!query) return '给个 id 或 query。';
        const hits = search(query, 10);
        if (hits.length === 0) return `没有匹配「${query}」的记忆。`;
        let n = 0;
        for (const { row } of hits) if (deleteNote(row.id)) n += 1;
        return `已删除 ${n} 条：` + hits.map((h) => h.row.title).join('、');
      } catch (e) {
        return '删除失败：' + (e && e.message ? e.message : String(e));
      }
    },
  },
  {
    name: 'fish_thread',
    description: '检索我和主人的历史对话原文（本地 SQLite FTS5，零算力）。想找回「当时原话」用这个；提炼过的事实用 fish_recall。原文归档每天 22:00 自动增量，也可以传 scan=true 即时归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，可多个（AND 匹配）' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '默认 5' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD，可选' },
        to: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
        scan: { type: 'boolean', description: '先增量归档再查，可选' },
      },
    },
    output: outputText,
    async execute(args) {
      const a = args || {};
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      const from = typeof a.from === 'string' ? a.from.trim() : '';
      const to = typeof a.to === 'string' ? a.to.trim() : '';
      try {
        let scanMsg = '';
        if (a.scan) scanMsg = runArchiveScan() + '\n';
        if (!query) {
          const st = threadStats();
          if (!st) return scanMsg + '还没有对话归档。跑一次 node ' + chatScript() + ' scan。';
          return scanMsg + `对话原文 ${st.total} 条（主人 ${st.user} 条），${st.from} ~ ${st.to}。给个关键词再查。`;
        }
        const { rows, missing, total } = searchThread(query, a.limit, from, to);
        if (missing) return scanMsg + '还没有对话归档。跑一次 node ' + chatScript() + ' scan。';
        if (!rows.length) return scanMsg + `原文里没找到「${query}」` + (from || to ? '（限定了日期）' : '') + '。';
        const lines = rows.map((r) => {
          const who = r.role === 'user' ? '主人' : '我';
          return `[${r.day}] ${who}：${threadSnippet(r.text, query)}`;
        });
        const more = total && total > rows.length ? `（库中共 ${total} 条匹配，只显示 ${rows.length} 条；查更早的原话加 from/to，例如 from="2026-11-02"，别当成「没有」）` : '';
        return scanMsg + `命中 ${rows.length} 条原文${more}：\n\n` + lines.join('\n\n');
      } catch (e) {
        return '检索原文失败：' + (e && e.message ? e.message : String(e));
      }
    },
  },
];

// ---------- 激活 ----------
export function apply(ctx) {
  try {
    mkdirSync(notesDir(), { recursive: true });
    // 只给「第一次装」的人铺骨架：数据目录里已有 CORE.md 说明是老工作台，一律不动。
    if (!existsSync(corePath())) {
      const seeded = seedSkeleton();
      try { writeFileSync(needProfilePath(), '1'); } catch { /* 写不了就跳过引导 */ }
      if (seeded.copied) console.log(`dsh-pbyugujia: 骨架模板已铺开 ${seeded.copied}/${seeded.total} 个文件`);
    }
    readOrSeed(soulPath(), DEFAULT_SOUL);
    readOrSeed(corePath(), DEFAULT_CORE);
    maybeSync();
  } catch (e) {
    console.error('dsh-pbyugujia: 初始化失败', e);
  }

  // fish_setup 只在「首次见面引导」期间注册：引导完成（或老工作台）就不带这个 schema，
  // 每轮省 ~97 token。引导撤掉后要下次启动才生效，本次会话留着也无害。
  const guideOn = existsSync(needProfilePath());
  for (const def of toolDefs) {
    if (def.name === 'fish_setup' && !guideOn) continue;
    ctx.tools.register(def);
  }

  ctx.systemPrompt.section({
    name: 'dsh-pbyugujia',
    order: 58,
    text: () => {
      try { return buildSectionText(); } catch (e) { console.error('dsh-pbyugujia: 注入失败', e); return ''; }
    },
  });

  // 记忆类问法触发（2026-11-13，消化自 dsh-rofm 1.5.6 的「主动召回」）：
  // 每轮算一次，命中才注入两行；不命中返回空串，不加长上下文。读不到会话就静默跳过。
  ctx.systemPrompt.section({
    name: 'dsh-pbyugujia-memory-trigger',
    order: 59,
    text: () => {
      try { return memoryTriggerHint(); } catch (e) { console.error('dsh-pbyugujia: 问法触发失败', e); return ''; }
    },
  });

  console.log('dsh-pbyugujia: 已激活，数据目录 ' + rootDir());
}

export const _internal = { tokenize, search, certaintyOf, supersededHints, supersededHintLine, searchThread, threadStats, runArchiveScan, reindexAll, upsertNote, deleteNote, markSuperseded, parseNoteFile, noteFileText, maybeSync, dbPath, notesDir, chatDbPath, rootDir, seedSkeleton, profilePath, needProfilePath };
