// subtitle.mjs —— 给已经出好的片子盖一层「跟语音走」的字幕（2026-11-04 他要求）
// 用法: node tools/subtitle.mjs <spec.json> <in.mp4> <out.mp4>
// spec.subtitle = { font?, size?, color?, maxChars?, bottom? }；旁白取自 spec.narration
// 做法：把旁白按句切分 → 按字数占比分配时长 → 把停顿点吸附到真实静音（差 0.45s 内才吸）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.dsh', 'dafeiyu');
const specPath = process.argv[2];
const inMp4 = process.argv[3];
const outMp4 = process.argv[4];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const cfg = spec.subtitle || {};
const FONT = cfg.font || spec.font || '/system/fonts/SysSans-Hans-Regular.ttf';
const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/%/g, '\\\\%');

const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inMp4], { encoding: 'utf8' }).trim());

// 1) 切句：按 。！？换行切，长句再按 ，、 切
const prose = String(cfg.text || spec.narration || '').replace(/\n+/g, '\n').trim();
let sents = [];
for (const para of prose.split('\n')) {
  for (const s of para.split(/(?<=[。！？])/)) {
    const t = s.trim();
    if (!t) continue;
    if ([...t].length <= 22) sents.push(t);
    else {
      let cur = '';
      for (const piece of t.split(/(?<=[，、；：])/)) {
        if ([...cur + piece].length > 22 && cur) { sents.push(cur.trim()); cur = piece; }
        else cur += piece;
      }
      if (cur.trim()) sents.push(cur.trim());
    }
  }
}
if (!sents.length) { console.log('没有旁白，跳过字幕'); process.exit(0); }

// 2) 静音点
let sil = [];
try {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-i', spec.audio || inMp4, '-af', 'silencedetect=noise=-33dB:d=0.35', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  sil = out;
} catch (e) {
  sil = (e.stderr || '').toString();
}
const pauses = [];
for (const m of sil.matchAll(/silence_end:\s*([\d.]+)/g)) pauses.push(Number(m[1]));

// 3) 按字数分时长，边界吸附静音
const lens = sents.map((s) => [...s].length);
const total = lens.reduce((a, b) => a + b, 0);
let acc = 0;
const bounds = lens.map((n) => (acc += n) / total * dur);
const snapped = bounds.map((b) => {
  const near = pauses.reduce((best, p) => (Math.abs(p - b) < Math.abs(best - b) ? p : best), -99);
  return Math.abs(near - b) <= 0.45 ? near : b;
});
const times = [];
let t0 = 0;
for (let i = 0; i < sents.length; i++) {
  const t1 = i === sents.length - 1 ? dur : snapped[i];
  times.push([t0, Math.max(t0 + 0.5, t1)]);
  t0 = t1;
}

// 4) 分行：按像素宽度折
const W = spec.w || 1280, H = spec.h || 720;
const SIZE = Math.round(cfg.size || Math.min(W, H) * 0.048);
const maxChars = Math.round(cfg.maxChars || (W * 0.78) / SIZE);
const bottom = Math.round(cfg.bottom || H * 0.055);
const COLOR = cfg.color || '0xF2EDE4';
const wrap = (t) => {
  const chars = [...String(t)];
  if (chars.length <= maxChars) return [String(t)];
  // 优先在标点后断开，且两行尽量等长
  const lines = Math.ceil(chars.length / maxChars);
  const per = Math.ceil(chars.length / lines);
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    const isPunc = /[，、：；。]/.test(chars[i]);
    const nextPuncSoon = /[，、：；。]/.test(chars[i + 1] || '');
    if ([...cur].length >= per - 2 && (isPunc || nextPuncSoon || [...cur].length >= Math.round(per * 1.35))) {
      if (out.length < lines - 1) { out.push(cur); cur = ''; }
    }
  }
  if (cur) out.push(cur);
  // 行首不许是标点：把标点挪回上一行行尾
  const PUNC = /^[，、：；。！？）]+/;
  for (let k = 1; k < out.length; k++) {
    const m = out[k].match(PUNC);
    if (m) {
      out[k - 1] += m[0];
      out[k] = out[k].slice(m[0].length);
      if (!out[k]) { out.splice(k, 1); k--; }
    }
  }
  return out;
};

// 5) 一条 filter 链：每条字幕一个 drawtext + enable 时间窗
const dts = [];
times.forEach(([a, b], i) => {
  const lines = wrap(sents[i]);
  lines.forEach((ln, k) => {
    const y = H - bottom - (lines.length - k) * Math.round(SIZE * 1.28) + Math.round(SIZE * 0.2);
    dts.push(`drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${COLOR}@0.95:fontsize=${SIZE}:borderw=2:bordercolor=0x000000@0.45:x=(w-tw)/2:y=${y}:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`);
  });
});
const vf = dts.join(',');
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inMp4, '-vf', vf,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', outMp4]);
console.log(`字幕 ${sents.length} 句 → ${outMp4}`);
