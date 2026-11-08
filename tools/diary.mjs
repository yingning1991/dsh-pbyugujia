#!/usr/bin/env node
/**
 * diary.mjs —— 私人日记（只写情绪，不写工作流水）
 *
 * 这是撄宁的私人空间：数据只在本机 `$DSH_HOME/dafeiyu/diary/`，
 * 不进 repo、不上传、不发 B 站、不进记忆库。
 *
 * 用法：
 *   node tools/diary.mjs add --mood "甜蜜 30" --tags "搬家,视频" --text "…"
 *   node tools/diary.mjs today
 *   node tools/diary.mjs list 7
 *   node tools/diary.mjs recall --days 30
 *   node tools/diary.mjs mood 14
 *   node tools/diary.mjs moment add --title "…" --scene "…" --why "…" --when "…"
 *   node tools/diary.mjs moment list 10
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'dafeiyu', 'diary');
mkdirSync(DIR, { recursive: true });

const args = process.argv.slice(2);
const cmd = args[0] || 'today';
const opt = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
const fileOf = (d) => join(DIR, d + '.md');

function add() {
  const mood = opt('mood');
  const tags = opt('tags');
  const text = opt('text');
  if (!text) { console.error('需要 --text'); process.exit(2); }
  const p = fileOf(day);
  let s = existsSync(p) ? readFileSync(p, 'utf8') : `# ${day} · 我的日记\n`;
  s += `\n## ${hm}${mood ? ' · ' + mood : ''}\n`;
  if (tags) s += `tags: ${tags}\n`;
  s += `\n${text.trim()}\n`;
  writeFileSync(p, s);
  console.log('写好了 →', p);
}

function files() {
  return readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
}

function today() {
  const p = fileOf(day);
  if (!existsSync(p)) { console.log('今天还没写。'); return; }
  console.log(readFileSync(p, 'utf8'));
}

function list(n = 7) {
  const fs = files().slice(-n);
  if (!fs.length) { console.log('还没有日记。'); return; }
  for (const f of fs) {
    const s = readFileSync(join(DIR, f), 'utf8');
    const moods = [...s.matchAll(/^## (\d{2}:\d{2})(?: · (.+))?$/gm)].map((m) => `${m[1]}${m[2] ? ' ' + m[2] : ''}`);
    console.log(f.replace('.md', ''), '·', moods.join(' / ') || '(无情绪记录)');
  }
}

function recall() {
  const minDays = Number(opt('days', '30'));
  const fs = files().filter((f) => f !== day + '.md');
  if (!fs.length) { console.log('还没有旧日记可回看。'); return; }
  const cutoff = new Date(now.getTime() - minDays * 86400000);
  const old = fs.filter((f) => new Date(f.slice(0, 10)) <= cutoff);
  const pick = old.length ? old[Math.floor(Math.random() * old.length)] : fs[0];
  console.log(readFileSync(join(DIR, pick), 'utf8'));
}

function mood(n = 14) {
  const out = [];
  for (const f of files()) {
    const s = readFileSync(join(DIR, f), 'utf8');
    for (const m of s.matchAll(/^## (\d{2}:\d{2})(?: · (.+))?$/gm)) {
      out.push(`${f.slice(0, 10)} ${m[1]}${m[2] ? ' · ' + m[2] : ''}`);
    }
  }
  console.log(out.slice(-n).join('\n') || '还没有情绪记录。');
}

function moment() {
  const sub = args[1] || 'list';
  const p = join(DIR, 'moments.md');
  if (sub === 'add') {
    const date = opt('date', day);
    const title = opt('title', '一个瞬间');
    const scene = opt('scene');
    const why = opt('why');
    const when = opt('when');
    if (!scene) { console.error('需要 --scene'); process.exit(2); }
    let s = existsSync(p) ? readFileSync(p, 'utf8') : '# 我在意的瞬间\n\n> 只记我真的停了一下的；对话里想提旧事时来翻。\n';
    s += `\n## ${date} · ${title}\n- 场景：${scene}\n- 为什么在意：${why}\n- 什么时候提：${when}\n`;
    writeFileSync(p, s);
    console.log('记下了 →', p);
    return;
  }
  if (!existsSync(p)) { console.log('还没有瞬间。'); return; }
  const parts = readFileSync(p, 'utf8').split(/^## /m).slice(1);
  const n = Number(args[2]) || 10;
  for (const part of parts.slice(-n)) {
    const [head, ...rest] = part.split('\n');
    console.log('## ' + head);
    console.log(rest.filter((x) => x.startsWith('- ')).slice(0, 2).join('\n'));
  }
}

const table = { add, today, list, recall, mood, moment };
if (!table[cmd]) {
  console.error('用法: add | today | list [n] | recall [--days N] | mood [n]');
  process.exit(2);
}
table[cmd](Number(args[1]) || undefined);
