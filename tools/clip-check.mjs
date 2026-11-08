#!/usr/bin/env node
/** clip-check.mjs —— 成片交付前的硬检查（2026-11-06 用户：「以后做完视频核字幕！要不然返工」）
 *
 * 用法：node tools/clip-check.mjs out/clip/x.mp4
 *
 * 做三件事，都是「看得见才叫核过」：
 *   1. 报规格：宽×高（竖屏/横屏）、时长、帧率、有没有音轨；
 *   2. 抽三帧落盘（开头 10%、中段 50%、结尾 88%），路径打到 stdout——**必须再肉眼看一遍**，
 *      看清字幕在不在、跟不跟得上、有没有被立绘挡住；
 *   3. 明显不合格就 exit 1：横屏当竖屏发、时长 <40 秒或 >200 秒、没音轨。
 *
 * 只读文件，零模型调用、不联网。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.dsh', 'dafeiyu');
const file = process.argv[2];
if (!file) {
  console.log('用法：node tools/clip-check.mjs out/clip/x.mp4');
  process.exit(2);
}

const probe = (args) =>
  execFileSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 8 << 20 }).trim();

let info;
try {
  info = probe(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
} catch (e) {
  console.error(`✗ 读不到 ${file}：${e.message}`);
  process.exit(1);
}
const j = JSON.parse(info);
const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
const dur = Number(j.format?.duration || 0);
const W = v.width, H = v.height;
const fps = v.r_frame_rate || '?';

const portrait = H > W;
const out = [];
out.push(`片子：${basename(file)}`);
out.push(`规格：${W}×${H}（${portrait ? '竖屏' : '横屏'}）· ${dur.toFixed(1)} 秒 · ${fps} · ${hasAudio ? '有音轨' : '无音轨'}`);

// 抽三帧
const dir = join(DIR, 'out', 'tmp');
mkdirSync(dir, { recursive: true });
const stamp = basename(file).replace(/\.(mp4|mov|mkv)$/i, '');
const shots = [];
for (const [i, pct] of [0.1, 0.5, 0.88].entries()) {
  const t = Math.max(0.2, dur * pct);
  const p = join(dir, `check-${stamp}-${i + 1}.png`);
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', p], { maxBuffer: 8 << 20 });
    shots.push({ t, p });
  } catch {}
}
out.push('');
out.push('抽帧（逐张看过再交付）：');
for (const s of shots) out.push(`  ${s.t.toFixed(1)}s → ${s.p}`);
console.log(out.join('\n'));

// 硬判据（2026-11-06 用户定：B 站一律横版 1280×720）
const bad = [];
if (portrait) bad.push('是竖屏——B 站要横版 1280×720');
if (!hasAudio) bad.push('没有音轨');
if (dur < 40) bad.push(`只有 ${dur.toFixed(1)} 秒，太短（<40s）`);
if (dur > 200) bad.push(`有 ${dur.toFixed(1)} 秒，太长（>200s）`);

if (bad.length) {
  console.log('\n✗ 不合规：' + bad.join('；'));
  process.exit(1);
}
console.log('\n✓ 规格这一层过了。字幕还在不在，要看你刚才那三张图——没看就不算核过。');
