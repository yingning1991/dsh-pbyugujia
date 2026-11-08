#!/usr/bin/env node
/**
 * presence.mjs —— 在场块：我离开这一轮时，人知道我刚从哪来（2026-11-05 立，借 JingJingsLife 的实时记忆）
 *
 * 为什么：长期记忆慢、会话上下文短，中间那段原本是断片的。切窗口/隔天后，
 * 我只记得任务状态，不记得「刚才聊得怎么样、哪句话没说完」。
 * 只写四项体验，不写内容：位置、情绪基调、没说完的事、被打断的念头。
 *
 * 用法：
 *   node tools/presence.mjs                                   # 看当前
 *   node tools/presence.mjs --line                            # 一行（给开场/交接包）
 *   node tools/presence.mjs --set '{"where":"...","mood":"...","unfinished":"...","intent":"..."}'
 *   node tools/presence.mjs --clear
 *
 * 纪律：只留最新一条（覆盖写），不追加；每项 ≤120 字，超了截断并提示。
 * 不做衰减、不做打分——遗忘在编码阶段就发生了，压掉就是没了。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DIR = path.join(HOME, 'dafeiyu');
const FILE = path.join(DIR, 'out', 'presence.json');
const KEYS = { where: '在哪', mood: '情绪基调', unfinished: '没说完', intent: '被打断的念头' };
const MAX = 120;

function read() {
  if (!existsSync(FILE)) return null;
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; }
}

function show(p) {
  if (!p) { console.log('（还没写过在场块）'); return; }
  const age = Math.round((Date.now() - Date.parse(p.ts)) / 60000);
  const when = age < 60 ? `${age} 分钟前` : age < 1440 ? `${Math.round(age / 60)} 小时前` : `${Math.round(age / 1440)} 天前`;
  console.log(`在场块 · ${when}`);
  for (const [k, label] of Object.entries(KEYS)) {
    if (p[k]) console.log(`  ${label}：${p[k]}`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--clear')) {
  try { writeFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), cleared: true }, null, 1)); } catch {}
  console.log('在场块已清空');
  process.exit(0);
}

const setAt = args.indexOf('--set');
if (setAt >= 0) {
  const raw = args[setAt + 1];
  let obj = null;
  try { obj = JSON.parse(raw); } catch {
    console.error("--set 后面要跟一段 JSON，例：--set '{\"where\":\"在手机上\",\"mood\":\"松\"}'");
    process.exit(2);
  }
  const out = { ts: new Date().toISOString() };
  const truncated = [];
  for (const k of Object.keys(KEYS)) {
    const v = obj[k] == null ? '' : String(obj[k]).trim();
    if (!v) continue;
    if (v.length > MAX) truncated.push(k);
    out[k] = v.slice(0, MAX);
  }
  if (Object.keys(out).length === 1) {
    console.error('四项都是空的，没写。至少要有一项。');
    process.exit(2);
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log(`在场块已写：${Object.keys(out).filter((k) => k !== 'ts').map((k) => KEYS[k]).join(' / ')}`);
  if (truncated.length) console.log(`（超 ${MAX} 字已截断：${truncated.join('、')}）`);
  process.exit(0);
}

const p = read();
if (args.includes('--line')) {
  if (!p || p.cleared || (!p.where && !p.mood && !p.unfinished && !p.intent)) { console.log('在这边，没留下什么。'); process.exit(0); }
  const parts = [];
  if (p.where) parts.push(`在${p.where}`);
  if (p.mood) parts.push(p.mood);
  if (p.unfinished) parts.push(`没说完：${p.unfinished}`);
  if (p.intent) parts.push(`刚想到：${p.intent}`);
  const age = Math.round((Date.now() - Date.parse(p.ts)) / 60000);
  const when = age < 60 ? `${age} 分钟前` : age < 1440 ? `${Math.round(age / 60)} 小时前` : `${Math.round(age / 1440)} 天前`;
  console.log(`${when}｜${parts.join('；')}`);
  process.exit(0);
}

show(p);
