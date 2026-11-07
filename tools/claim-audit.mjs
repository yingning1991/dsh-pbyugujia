#!/usr/bin/env node
/**
 * claim-audit.mjs —— 把「完成声称」和「证据」对上（2026-11-05 立，借天枢 Evidence 门 + 我们的「写上≠落地」）
 *
 * 动机：一个真实教训——「写上＝落地？」。自检查系统状态，这个查**嘴上说的完成**：
 * 一条消息说「已落地 / 已验证 / 跑通了」，看这一轮（上次用户发言之后）实际跑的是什么——
 * 跑过 bash/shell 才算验证；只有 edit/write 就是「只改字」；什么都没有是「空口」。
 *
 * 用法：
 *   node tools/claim-audit.mjs             # 今天
 *   node tools/claim-audit.mjs 7           # 最近 7 天
 *   node tools/claim-audit.mjs 1 --list    # 列出每一条
 *   node tools/claim-audit.mjs 1 --line    # 只打一行，给 22:00 复盘用
 *
 * 只读 chat.db，零模型调用；可用 CHAT_DB 或 DSH_HOME 指定库位置（同 chat.mjs）。
 *
 * 判据：
 *   强声称（已落地/已验/跑通/全绿/修好了）→ 本轮必须有 run（bash/shell）或 act（排进定时等）；
 *   动作声称（已改/已写/已建/已装/已挂/已清）→ 至少要有写或动作，都没有才标「空口」。
 *   不算证据：同一条消息自己说「跑过了」；同一个命令重复两次也不当两条独立证据。
 *   不算声称：问句（「已落地？」）、代码块、引用行、讨论里的「想干净」这类顺口词。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DB = process.env.CHAT_DB || path.join(HOME, 'dafeiyu', 'chat', 'chat.db');
const days = Number(process.argv[2]) || 1;
const LIST = process.argv.includes('--list');
const LINE = process.argv.includes('--line');

// days<=1 就是「今天」，别把昨天的账混进来
const since = days <= 1
  ? new Date().toISOString().slice(0, 10)
  : new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

const d = new DatabaseSync(DB, { readOnly: true });
const rows = d.prepare(
  "SELECT sid, seq, day, role, text FROM msgs WHERE day >= ? ORDER BY sid, seq"
).all(since);
d.close();

const RUN = new Set(['bash', 'shell']);
const WRITE = new Set(['edit', 'write']);
const ACT = new Set(['schedule_create', 'schedule_update', 'schedule_delete', 'fish_remember', 'memory_write',
  'memory_core', 'generate_image', 'generate_video', 'browser', 'ui', 'present', 'subagent', 'workflow']);

// 只留具体的完成声明；「干净」「通过」「好了」太泛，会把「想干净」「通过了路口」也算进来
const STRONG = /已(?:落地|上线|验证|验过|修复|修好|改好|测过)|验证过了|全部通过|全绿|实测过/;
const ACTION = /已(?:改|写|加|建|装|挂|清|删|移|补|接|存|更新|落库|进相册)/;

const clean = (t) => String(t || '')
  .replace(/```[\s\S]*?```/g, '')      // 代码块
  .replace(/^\s*>.*$/gm, '')           // 引用行
  .replace(/`[^`]*`/g, ' ')           // 行内代码（路径/命令，不是声称）
  .replace(/「[^」]{0,80}」/g, ' ');     // 引用的别人话/计划文案

function toolName(text) {
  const m = String(text || '').match(/^\[调用\]\s+([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

let curSid = null;
let turn = [];   // 本轮（上次 user 发言之后）的工具调用
let strongOk = new Set();  // 本会话里已经被证实过的强声称词，重复提不算新声称
const hits = [];
let claimMsgs = 0;

for (const r of rows) {
  if (r.sid !== curSid) { curSid = r.sid; turn = []; strongOk = new Set(); }
  if (r.role === 'user') { turn = []; continue; }
  if (r.role === 'tool') {
    const n = toolName(r.text);
    if (n) turn.push(n);
    continue;
  }
  if (r.role !== 'assistant') continue;

  const text = clean(r.text);
  const strong = STRONG.exec(text);
  const action = ACTION.exec(text);
  if (!strong && !action) continue;

  const at = (strong || action).index;
  const tail = text.slice(at, at + 12);
  if (/[？?]/.test(tail)) continue;            // 问句不是声称
  const before = text.slice(Math.max(0, at - 30), at);
  if (/(上游|服务端|官方|他们|对方|你那边|别人)/.test(before)) continue;  // 不是我的完成
  if (/^已(?:验证|修复|修好|改好|测过|验过)[^。！？\n]{0,6}的/.test(text.slice(at, at + 12))) continue;  // 「已验证可用的接口」是形容，不是声称
  if (/(上游|服务端|官方)/.test(text.slice(at, at + 30))) continue;  // 后面说的是上游，不是我的完成
  if (/(还没验|未验|没验过)/.test(text.slice(Math.max(0, at - 20), at + 30))) continue;  // 自己都说没验

  // 同一会话里「全绿/已落地」被证实过后，后面再提只是复述，不算新声称
  if (strong && strongOk.has(strong[0])) continue;
  claimMsgs++;
  // 同一工具重复只算一次（天枢的教训：同一验证命令绿两次不是两条独立证据）
  const uniq = new Set(turn);
  const run = [...uniq].filter((n) => RUN.has(n)).length;
  const write = [...uniq].filter((n) => WRITE.has(n)).length;
  const act = [...uniq].filter((n) => ACT.has(n)).length;
  const kind = strong ? '强' : '动作';
  let verdict = '有据';
  if (strong && run === 0 && act === 0) verdict = write ? '只改字' : '空口';
  else if (!strong && run + write + act === 0) verdict = '空口';

  if (strong && verdict === '有据') strongOk.add(strong[0]);
  hits.push({
    sid: String(r.sid).slice(-8), seq: r.seq, day: r.day, kind, verdict,
    run, write, act, snippet: text.slice(Math.max(0, at - 30), at + 60).replace(/[ \t]+/g, ' ').trim(),
  });
}

const bad = hits.filter((h) => h.verdict !== '有据');
if (LINE) {
  const tally = bad.reduce((a, h) => (a[h.verdict] = (a[h.verdict] || 0) + 1, a), {});
  console.log(`完成声称 ${claimMsgs} 条：有据 ${claimMsgs - bad.length}` +
    (bad.length ? `；待核 ${bad.length}（${Object.entries(tally).map(([k, v]) => k + v).join(' / ')}）` : ''));
} else {
  console.log(`完成声称审计（${days <= 1 ? '今天' : `最近 ${days} 天`}）`);
  console.log(`声称 ${claimMsgs} 条：有据 ${claimMsgs - bad.length}，只改字 ${hits.filter(h => h.verdict === '只改字').length}，空口 ${hits.filter(h => h.verdict === '空口').length}`);
  if (LIST) {
    for (const h of hits) {
      const mark = h.verdict === '有据' ? '✓' : h.verdict === '只改字' ? '△' : '✗';
      console.log(`${mark} ${h.day} ${h.sid}#${h.seq} [${h.kind}/${h.verdict}] run${h.run} write${h.write} act${h.act} | ${h.snippet}`);
    }
  }
}
