#!/usr/bin/env node
// 撄宁酱的对话原文归档：把 DSH 会话日志里的真实对话抽出来，进 SQLite FTS5。
// 用法：
//   node chat.mjs scan            增量归档（只处理变化的会话文件）
//   node chat.mjs scan --all      全量重扫
//   node chat.mjs query "关键词" [--limit 5] [--from 2026-10-01] [--to 2026-10-31]
//   node chat.mjs stats
// 设计：原文全量落盘，检索时才取几段；不注入上下文，零模型调用。

import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'dafeiyu', 'chat');
const DB = process.env.CHAT_DB || join(DIR, 'chat.db');
const SESSIONS = join(HOME, 'sessions');
mkdirSync(DIR, { recursive: true });

const TZ_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function dayOf(ms) {
  const parts = TZ_FMT.formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// 中文按二元组切，其他语言按词。查询和建索引用同一套。
function bigrams(s) {
  const out = [];
  const norm = String(s).replace(/[\s\p{P}\p{S}]+/gu, ' ');
  for (const tok of norm.split(' ')) {
    if (!tok) continue;
    const runs = tok.match(/[\u3400-\u9fff]+/g) || [];
    for (const run of runs) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    }
    for (const w of tok.replace(/[\u3400-\u9fff]+/g, ' ').split(/\s+/)) {
      if (w) out.push(w.toLowerCase());
    }
  }
  return out.join(' ');
}

function openDb() {
  const db = new DatabaseSync(DB);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS msgs (
      sid TEXT NOT NULL, seq INTEGER NOT NULL, day TEXT NOT NULL,
      ts INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (sid, seq)
    );
    CREATE INDEX IF NOT EXISTS msgs_day ON msgs(day);
    CREATE VIRTUAL TABLE IF NOT EXISTS msgs_fts USING fts5(
      sid UNINDEXED, seq UNINDEXED, bigram, tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
      sid TEXT NOT NULL, scanned TEXT NOT NULL
    );
  `);
  return db;
}

function listSessionFiles(dir) {
  const out = [];
  let workspaces = [];
  try { workspaces = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const ws of workspaces) {
    const wsDir = join(dir, ws.name);
    let sessDirs = [];
    try { sessDirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const sd of sessDirs) {
      const sdDir = join(wsDir, sd.name);
      let files = [];
      try { files = readdirSync(sdDir).filter((f) => f.startsWith('session.') && f.endsWith('.jsonl.zstd')); } catch { continue; }
      for (const f of files) out.push({ path: join(sdDir, f), sid: sd.name, dir: sdDir });
    }
  }
  return out;
}

function unzstd(path) {
  return execFileSync('zstd', ['-d', '-c', path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
}

// 落库前脱敏：密码、token、手机号、银行卡这类不该进原文库的东西，一律打码。
// 原则：宁可多码几个字，也不让凭据长期躺在磁盘上。
const SECRET_PATTERNS = [
  // 明确的凭据关键词后面跟的串：密码是 xxx / 密码：xxx / password=xxx
  // 注意别把 "token" 这种技术词算进去——「按 token 差 × 缓存价」不该被码（2026-10-30 踩过）
  [/((?:密码|口令|passwd|password|secret|api[_-]?key)(?:\s*[:：=]|\s*是)\s*)(\S{4,})/gi, '$1***'],
  // 11 位手机号（中国大陆）
  [/(?<!\d)(1[3-9]\d{9})(?!\d)/g, '1**********'],
  // 常见的 key 形态
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***'],
  [/\b([A-Za-z0-9_-]{32,})\b/g, '***'],
];
function redact(text) {
  let t = String(text || '');
  for (const [re, rep] of SECRET_PATTERNS) t = t.replace(re, rep);
  return t;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function extract(file) {
  const raw = unzstd(file.path);
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = ev.type;
    const time = ev.time || ev.data?.time || 0;
    if (!time) continue;
    if (t === 'user/message') {
      if (ev.data?.source?.kind && ev.data.source.kind !== 'user') continue;
      const text = textOf(ev.data?.content);
      if (text) rows.push({ seq: ev.seq, day: dayOf(time), ts: time, role: 'user', text });
    } else if (t === 'assistant/message') {
      const text = textOf(ev.data?.message?.content);
      if (text) rows.push({ seq: ev.seq, day: dayOf(time), ts: time, role: 'assistant', text });
    } else if (t === 'tool/call') {
      const name = ev.data?.name || 'tool';
      const args = String(ev.data?.arguments || '').replace(/\s+/g, ' ').slice(0, 1200);
      if (args) rows.push({ seq: ev.seq, day: dayOf(time), ts: time, role: 'tool', text: `[调用] ${name} ${args}` });
    } else if (t === 'tool/result') {
      const body = textOf(ev.data?.message?.content).replace(/\s+/g, ' ').slice(0, 2000);
      if (body) rows.push({ seq: ev.seq, day: dayOf(time), ts: time, role: 'tool_result', text: `[结果] ${body}` });
    }
  }
  return rows;
}

function scan(all = false) {
  const db = openDb();
  const files = listSessionFiles(SESSIONS);
  let scanned = 0, inserted = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const f of files) {
    let st;
    try { st = statSync(f.path); } catch { continue; }
    const prev = db.prepare('SELECT mtime, size FROM files WHERE path = ?').get(f.path);
    if (!all && prev && prev.mtime === st.mtimeMs && prev.size === st.size) { skipped++; continue; }
    let rows;
    try { rows = extract(f); } catch (e) { console.error(`跳过 ${f.sid}: ${e.message}`); continue; }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM msgs WHERE sid = ?').run(f.sid);
      db.prepare('DELETE FROM msgs_fts WHERE sid = ?').run(f.sid);
      const ins = db.prepare('INSERT OR IGNORE INTO msgs (sid, seq, day, ts, role, text) VALUES (?,?,?,?,?,?)');
      const insF = db.prepare('INSERT INTO msgs_fts (sid, seq, bigram) VALUES (?,?,?)');
      for (const r of rows) {
        const safe = redact(r.text);
        if (ins.run(f.sid, r.seq, r.day, r.ts, r.role, safe).changes === 0) continue;
        insF.run(f.sid, r.seq, bigrams(safe));
        inserted++;
      }
      db.prepare('INSERT OR REPLACE INTO files (path, mtime, size, sid, scanned) VALUES (?,?,?,?,?)')
        .run(f.path, st.mtimeMs, st.size, f.sid, now);
      db.exec('COMMIT');
      scanned++;
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`失败 ${f.sid}: ${e.message}`);
    }
  }
  console.log(`扫描文件 ${scanned}，跳过未变 ${skipped}，新入库 ${inserted} 条`);
  stats(db);
  db.close();
}

function stats(db) {
  const c = db.prepare('SELECT COUNT(*) c FROM msgs').get().c;
  const u = db.prepare("SELECT COUNT(*) c FROM msgs WHERE role='user'").get().c;
  const d = db.prepare('SELECT MIN(day) a, MAX(day) b FROM msgs').get();
  const s = db.prepare('SELECT COUNT(DISTINCT sid) c FROM msgs').get().c;
  const tc = db.prepare("SELECT COUNT(*) c FROM msgs WHERE role='tool'").get().c;
  const tr = db.prepare("SELECT COUNT(*) c FROM msgs WHERE role='tool_result'").get().c;
  console.log(`原文 ${c} 条（你 ${u} 条，工具调用 ${tc} 次 / 结果 ${tr} 条），${s} 个会话，${d.a} ~ ${d.b}`);
}

// 截取关键词前后一段，比整段倒更接近「原话」。
function snippet(text, kw, span = 160) {
  let idx = text.indexOf(kw);
  if (idx < 0) {
    for (const t of bigrams(kw).split(' ')) {
      const i = text.indexOf(t);
      if (i >= 0) { idx = i; break; }
    }
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + kw.length + span);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
}

function query(kw, { limit = 5, from = null, to = null } = {}) {
  const db = openDb();
  const terms = bigrams(kw).split(' ').filter(Boolean);
  if (!terms.length) { console.log('关键词为空'); return; }
  const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
  const singleChar = terms.length === 1 && [...terms[0]].length === 1;
  let sql, args;
  if (singleChar) {
    // 二元组索引匹配不到单字，退回 LIKE（限定近期一万条，够用且不慢）。
    sql = `SELECT m.sid, m.day, m.role, m.ts, m.text, 0 AS r FROM msgs m
           WHERE m.text LIKE ?`;
    args = [`%${terms[0]}%`];
    if (from) { sql += ' AND m.day >= ?'; args.push(from); }
    if (to) { sql += ' AND m.day <= ?'; args.push(to); }
    sql += ' ORDER BY m.ts DESC LIMIT ?';
  } else {
    sql = `SELECT m.sid, m.day, m.role, m.ts, m.text, bm25(msgs_fts) AS r
           FROM msgs_fts JOIN msgs m ON m.sid = msgs_fts.sid AND m.seq = msgs_fts.seq
           WHERE msgs_fts MATCH ?`;
    args = [match];
    if (from) { sql += ' AND m.day >= ?'; args.push(from); }
    if (to) { sql += ' AND m.day <= ?'; args.push(to); }
    sql += ' ORDER BY r, m.ts DESC LIMIT ?';
  }
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  if (!rows.length) { console.log('没找到'); return; }
  for (const r of rows) {
    const who = r.role === 'user' ? (process.env.DSH_HUMAN_NAME || '你') : r.role === 'tool' ? '（我调用）' : r.role === 'tool_result' ? '（工具回）' : '我';
    // 门牌：日期 + 时刻 + 会话号前 8 位。找回原文不用猜是哪个会话、哪一刻。
    const sid8 = String(r.sid || '').replace(/^session-/, '').slice(0, 8);
    const hhmm = new Date(r.ts).toLocaleTimeString('zh-CN', {
      hour12: false, hour: '2-digit', minute: '2-digit', timeZone: process.env.DSH_TZ || 'Asia/Shanghai',
    });
    console.log(`\n[${String(r.day).slice(5)} ${hhmm} · ${sid8}] ${who}：${snippet(r.text, kw)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'scan') scan(rest.includes('--all'));
else if (cmd === 'query') {
  const kw = rest.filter((a) => !a.startsWith('--'))[0] || '';
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  query(kw, {
    limit: Number(opt('--limit') || 5),
    from: opt('--from'),
    to: opt('--to'),
  });
} else if (cmd === 'stats') { const db = openDb(); stats(db); db.close(); }
else console.log('用法：node chat.mjs scan [--all] | query "词" [--limit N] [--from D] [--to D] | stats');
