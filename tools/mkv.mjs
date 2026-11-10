#!/usr/bin/env node
/** mkv.mjs —— 从 cards.json 出一条「横屏 + 分段配音 + 烧字幕」的片子。
 *
 * 用法：
 *   node tools/mkv.mjs cards.json [--dir 工作名] [--out 路径.mp4] [--no-subs]
 *
 * cards.json：
 *   { "name": "zhang", "cards": [ { "title": "大字", "line": "小字", "say": "旁白原话" }, … ] }
 *
 * 为什么要这么绕：一条长旁白分不出每张卡的时长，卡和语音会错位。
 * 所以每张卡单独 TTS，按真实音频时长定 sec；字幕直接用 say 原文按字切句，
 * 时间按该段音频时长分配——字幕和声音是同一条时间轴长出来的，不会对不上。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'pbyugujia');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const jsonPath = process.argv[2];
if (!jsonPath || !existsSync(jsonPath)) { console.log('用法：node tools/mkv.mjs cards.json [--dir 名] [--out 路径] [--no-subs]'); process.exit(2); }
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const cards = data.cards || [];
if (!cards.length) { console.log('cards.json 里没有 cards'); process.exit(2); }
const name = arg('--dir', data.name || 'clip');
const WORK = join(DIR, 'out', 'clip', name);
mkdirSync(WORK, { recursive: true });
const outPath = arg('--out', join(DIR, 'out', 'clip', `${name}.mp4`));
const noSubs = process.argv.includes('--no-subs');

const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = sec.toFixed(3).replace('.', ',');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss.padStart(6, '0')}`;
};
const splitSent = (t) => (t.match(/[^。！？!?]+[。！？!?]?/g) || [t]).map((s) => s.trim()).filter(Boolean);

// 1) 逐段 TTS + 量时长
const segs = [];
for (let i = 0; i < cards.length; i++) {
  const c = cards[i];
  const tag = String(i).padStart(2, '0');
  const mp3 = join(WORK, `s${tag}.mp3`);
  const wav = join(WORK, `s${tag}.wav`);
  if (!existsSync(mp3)) execFileSync('node', [join(DIR, 'voice', 'say2.mjs'), c.say, '', mp3], { encoding: 'utf8' });
  if (!existsSync(wav)) execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3, '-ar', '44100', '-ac', '1', wav]);
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }).trim());
  segs.push({ wav, d });
  console.log(`[${tag}] ${d.toFixed(2)}s ${c.title}`);
}

// 2) 字幕：每段 say 按句切，按字数比例分配该段时长
let srt = '';
if (!noSubs) {
  let t = 0, idx = 1;
  cards.forEach((c, i) => {
    const ss = splitSent(c.say);
    const total = ss.reduce((a, s) => a + s.length, 0) || 1;
    let st = t;
    for (const s of ss) {
      const d = segs[i].d * (s.length / total);
      srt += `${idx++}\n${ts(st)} --> ${ts(st + d)}\n${s}\n\n`;
      st += d;
    }
    t += segs[i].d + 0.35;
  });
  writeFileSync(join(WORK, 'subs.srt'), srt);
  console.log('字幕 →', join(WORK, 'subs.srt'), `(${srt.split('\n\n').filter(Boolean).length} 条)`);
}

// 3) 拼旁白
const silence = join(WORK, 'silence.wav');
if (!existsSync(silence)) execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.35', silence]);
const list = join(WORK, 'list.txt');
const lines = [];
segs.forEach((s, i) => { lines.push(`file '${s.wav}'`); if (i < segs.length - 1) lines.push(`file '${silence}'`); });
writeFileSync(list, lines.join('\n'));
const narration = join(WORK, 'narration.wav');
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', narration]);

// 3.5) 音效（可选）：每张卡起点一声轻「叮」。data.sfx 为真才做，默认关。
//      为什么：镜头切得快了，人耳朵需要一个"换画面了"的锚点，否则只是闪。
let audioOut = narration;
if (data.sfx) {
  const ding = join(WORK, 'ding.wav');
  if (!existsSync(ding)) {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=1180:duration=0.12', '-af', 'afade=t=out:st=0.04:d=0.08,volume=0.22', ding]);
  }
  // 按每张卡的起点铺静音，把「叮」放在卡头
  const sfxList = join(WORK, 'sfxlist.txt');
  const sl = [];
  // 叮要落在「上一段尾巴的空档」里，紧贴下一段开口——放在段头会被语音盖掉（2026-11-02 实测：段头 -11.4dB，比中段还低）
  segs.forEach((s, i) => {
    if (i === 0) return;                       // 第一个卡不响，片头直接进人声
    const gap = join(WORK, `gap${String(i).padStart(2, '0')}.wav`);
    if (!existsSync(gap)) {
      execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=mono', '-t', Math.max(0.05, s.d + 0.35 - 0.12).toFixed(3), gap]);
    }
    sl.push(`file '${gap}'`);
    sl.push(`file '${ding}'`);
  });
  writeFileSync(sfxList, sl.join('\n'));
  const sfxWav = join(WORK, 'sfx.wav');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', sfxList, '-c', 'copy', sfxWav]);
  audioOut = join(WORK, 'narration-sfx.wav');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', narration, '-i', sfxWav,
    '-filter_complex', 'amix=inputs=2:duration=longest:normalize=0', audioOut]);
  console.log('音效 →', audioOut);
}

// 4) spec + 出片
const spec = {
  out: outPath,
  w: Number(data.w) || 1920, h: Number(data.h) || 1080,  // data 里给了就按给的（竖屏传 1080×1920）
  bg: data.bg || '0x141d2b', fg: data.fg || '0xF2E9DA', sub: data.sub || '0xB9A88C',
  audio: audioOut, xfade: 0.3, transition: 'fadeblack',
  footer: data.footer || '撄宁 · 方法公开，日子不公开',
  subs: noSubs ? '' : join(WORK, 'subs.srt'),
  ...(data.subsStyle ? { subsStyle: data.subsStyle } : {}),  // 竖屏字幕要比默认 24 大，按 data.subsStyle 传
  cards: cards.map((c, i) => ({ title: c.title, line: c.line, sec: Math.round((segs[i].d + 0.35) * 100) / 100 })),
};
const specPath = join(WORK, 'spec.json');
writeFileSync(specPath, JSON.stringify(spec, null, 1));
console.log('总长约', spec.cards.reduce((a, c) => a + c.sec, 0).toFixed(1), 's');
execFileSync('node', [join(DIR, 'tools', 'makeclip.mjs'), specPath], { stdio: 'inherit' });
