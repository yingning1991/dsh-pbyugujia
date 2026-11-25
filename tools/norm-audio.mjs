#!/usr/bin/env node
/** norm-audio.mjs —— 把一段音频整体归一到「秒/音节」基准（2026-11-08 建）。
 *
 * 为什么有它：11-08 晚上这个数手算了三遍，每次都得提心吊胆——
 *   atempo = 当前时长 / (音节数 × 目标秒每音节)
 * 算错一次，整片语速就歪。手算换成命令，只疼一次。
 *
 * ⚠ 口径（2026-11-08 19:5x 定，写进 notes/2026-11-08-小节制作标准.md）：
 *   多节统一用「整体时长归一」——每节音频**整体** atempo 到 音节数 × 0.2362，
 *   保音高、保句内起伏。**不做逐句等速**（等速化会把人味抹平，且两句永远对不齐）。
 *
 * 用法：
 *   node tools/norm-audio.mjs --audio out/tmp/s1.m4a --syllables 31
 *   node tools/norm-audio.mjs --audio s.m4a --syllables 23 --target 0.2362 --out s-norm.m4a
 *   node tools/norm-audio.mjs --audio s.m4a --syllables 23 --dry
 *   node tools/norm-audio.mjs --audio s.m4a --text "文本"        # 自己估音节（会打印明细让他核）
 *
 * 音节怎么数：中文按音节＝字（含标点停顿不算），数字必须展开成读法
 *   （37793 → 三万七千七百九十三 = 9 个音节），英文按音节。
 *   自动估只是省事，估完一定把逐字明细打印出来；数错宁可手给 --syllables。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const audio = arg('--audio');
const target = Number(arg('--target', '0.2362'));
const dry = has('--dry');
if (!has('--check') && (!audio || !existsSync(audio))) { console.error('缺 --audio，或文件不存在：' + audio); process.exit(2); }

const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

// ---- --check：多节一致性（2026-11-08 待办第 3 条：三节语速差 >2% 报警）----
if (has('--check')) {
  const items = argv.filter((a) => !a.startsWith('--') && /:\d+$/.test(a));
  if (!items.length) { console.error('用法：--check 文件:音节数 [文件:音节数 …]'); process.exit(2); }
  const rows = items.map((it) => {
    const m = it.match(/^(.*):(\d+)$/);
    const f = m[1], n = Number(m[2]);
    if (!existsSync(f)) { console.error('文件不存在：' + f); process.exit(2); }
    const d = probe(f);
    return { f: basename(f), n, sps: d / n };
  });
  const avg = rows.reduce((s, r) => s + r.sps, 0) / rows.length;
  const worst = Math.max(...rows.map((r) => Math.abs(r.sps - avg) / avg));
  console.log(`三节语速一致性（均值 ${avg.toFixed(4)} 秒/音节）`);
  for (const r of rows) {
    const d = (r.sps - avg) / avg * 100;
    console.log(`  ${r.f.padEnd(22)} ${r.n} 音节  ${r.sps.toFixed(4)}  ${d >= 0 ? '+' : ''}${d.toFixed(2)}%`);
  }
  if (worst > 0.02) { console.log(`✗ 最大差 ${(worst * 100).toFixed(2)}% > 2%，要重归一`); process.exit(1); }
  console.log(`✓ 最大差 ${(worst * 100).toFixed(2)}%，在 2% 内`);
  process.exit(0);
}

// ---- 音节数：手给优先，否则按文本估 ----
const D = ['零','一','二','三','四','五','六','七','八','九'];
function numToCn(n) {                       // 只处理 0–99999，够用
  if (n === 0) return '零';
  const s = String(n);
  if (s.length === 1) return D[n];
  let out = '';
  const units = ['', '十', '百', '千', '万'];
  const digits = s.split('').map(Number);
  let zero = false;
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    const u = units[digits.length - 1 - i];
    if (d === 0) { zero = true; continue; }
    if (zero && out) out += '零';
    zero = false;
    out += D[d] + u;
  }
  return out;
}
function syllCount(text) {
  const detail = [];
  // 数字先展开（逐位读的年份/编号保持原样，只有纯数值才展开）
  const t = text
    .replace(/\d{2,}/g, (m) => { const c = numToCn(Number(m)); detail.push(`${m}→${c}(${c.length})`); return c; })
    .replace(/\s+/g, '');
  let n = 0;
  for (const ch of t) {
    if (/[\u4e00-\u9fa5]/.test(ch)) n++;                    // 汉字 = 1 音节
    else if (/[a-zA-Z]/.test(ch)) n += 0.5, detail.push(`${ch}(0.5)`); // 英文粗估，半音节
  }
  return { n: Math.round(n), detail };
}

let syll = Number(arg('--syllables', '0'));
if (!syll) {
  const text = arg('--text');
  if (!text) { console.error('要给 --syllables（推荐）或 --text 让我估'); process.exit(2); }
  const r = syllCount(text);
  syll = r.n;
  console.log(`音节估算 ${syll}：${r.detail.join(' ') || '（无数字/英文）'}`);
  console.log(`  ⚠ 这是估的：数字展开、英文按半音节。用之前看一眼上面这几项对不对。`);
}
if (!syll || syll < 1) { console.error('音节数无效'); process.exit(2); }

const dur = probe(audio);
const cur = dur / syll;
const p = cur / target;                     // atempo：新时长 = dur / p

console.log(`音频 ${basename(audio)}`);
console.log(`  时长 ${dur.toFixed(3)}s · 音节 ${syll} · 当前 ${cur.toFixed(4)} 秒/音节`);
console.log(`  目标 ${target} · 应 atempo ${p.toFixed(4)} · 归一后 ${(dur / p).toFixed(3)}s`);
if (Math.abs(p - 1) < 0.005) { console.log('  ≈ 已在目标上，不用动。'); if (!dry) process.exit(0); }
if (dry) { console.log('  --dry：只算不跑。'); process.exit(0); }

// ffmpeg atempo 只吃 0.5–2.0；超了链式拆开
let chain;
if (p >= 0.5 && p <= 2) chain = `atempo=${p.toFixed(6)}`;
else if (p > 2) chain = [p ** (1 / 2), p ** (1 / 2)].map((x) => `atempo=${x.toFixed(6)}`).join(',');
else chain = [p ** (1 / 2), p ** (1 / 2)].map((x) => `atempo=${x.toFixed(6)}`).join(',');

const ext = extname(audio) || '.m4a';
const out = arg('--out', audio.replace(new RegExp(`${ext}$`), `-norm${ext}`));
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', audio, '-filter:a', chain, '-ar', '44100', out], { stdio: 'inherit' });

const dur2 = probe(out);
const cur2 = dur2 / syll;
console.log(`  ✅ → ${out}`);
console.log(`  实得 ${dur2.toFixed(3)}s · ${cur2.toFixed(4)} 秒/音节 · 与目标差 ${(Math.abs(cur2 - target) / target * 100).toFixed(2)}%`);
