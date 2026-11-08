#!/usr/bin/env node
/** watch-along.mjs —— 陪看的最小实现：按时间片增量喂字幕，不截图。
 *
 * 用法：
 *   node tools/watch-along.mjs BV1xxxx            # 第一轮：标题/时长/字幕统计 + 开头一段
 *   node tools/watch-along.mjs BV1xxxx --from 120 # 从第 120 秒接着喂
 *   node tools/watch-along.mjs BV1xxxx --max 600  # 本轮最多喂 600 字（默认 600）
 *   node tools/watch-along.mjs BV1xxxx --plan     # 只看分段计划，不喂正文
 *   node tools/watch-along.mjs BV1xxxx --model small  # 无字幕时换更准（也更慢）的模型
 *
 * 没字幕轨时先本地 ASR 转写（默认 base，带时间码），再退「简介 + 前排评论」，不抽帧。
 * 2026-11-02 实测为什么默认 base 不默认 small：见下面模型那段注释。
 */
import { loadCookie, getSubtitleCues } from './bili.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const bvid = (process.argv[2] || '').match(/BV[0-9A-Za-z]{10}/)?.[0];
if (!bvid) { console.log('用法：node tools/watch-along.mjs BV1xxxx [--from 秒] [--max 字] [--plan]'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const from = arg('--from', 0);
const maxChars = arg('--max', 600);
const planOnly = process.argv.includes('--plan');
const mi = process.argv.indexOf('--model');
const modelName = mi > 0 ? process.argv[mi + 1] : 'base';
// 2026-11-02：B 站字幕会串片，默认不信字幕、走 ASR；确认真字幕再手动 --subs
const useSubs = process.argv.includes('--subs');

const HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dafeiyu');
const ck = loadCookie();
const UA = 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36';
const H = { Cookie: `SESSDATA=${ck.SESSDATA}; bili_jct=${ck.bili_jct || ''}`, 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${bvid}/` };

const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json();
const d = v.data || {};
const dur = d.duration || 0;
const stamp = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const subRes = await getSubtitleCues(bvid, ck);
// 2026-11-01 踩到：B站偶尔返回别条视频的字幕（cues 时长超过本片很多）。
// 用「最后一句的时间 > 片长 + 30 秒」判串片，直接丢弃，走 ASR 兜底。
let cues = subRes.cues;
if (cues.length && cues[cues.length - 1].to > dur + Math.max(30, dur * 0.1)) {
  console.log(`[警告] 字幕轨与本片时长差太多（${Math.round(cues.at(-1).to)}s vs 片长 ${dur}s），判为串片，丢弃。`);
  cues = [];
}
let totalChars = cues.reduce((a, c) => a + c.text.length, 0);

// 2026-11-02 实测：B 站字幕接口会「串片」——同一 BV 号两次调用，一次返回本片字幕，
// 一次返回完全无关的视频（《赛博海马体》拿到「手机镜头膜」、六个插件拿到「锅包肉」）。
// 只看时长判不出来（时间轴往往对得上），必须看内容相不相关：
// 用标题+简介的二元组，算字幕覆盖率；实测串片 0–3.7%，正常字幕远高于此。
// 覆盖 <5% 就判串片、丢字幕走 ASR——宁可慢 30 秒，不能把别人的稿子当本片讲。
function refCoverage(sub) {
  const ref = `${d.title || ''} ${d.desc || ''} ${d.tname || ''}`.replace(/\s+/g, '');
  const g = new Set();
  for (let i = 0; i < ref.length - 1; i++) g.add(ref.slice(i, i + 2));
  if (!g.size) return 1;
  let hit = 0;
  for (const x of g) if (sub.includes(x)) hit++;
  return hit / g.size;
}
if (cues.length && totalChars >= 300) {
  const cov = refCoverage(cues.map((c) => c.text).join(''));
  if (cov < 0.05) {
    console.log(`[警告] 字幕与本片标题几乎不重合（覆盖 ${(cov * 100).toFixed(1)}%），判为串片，丢弃走 ASR。`);
    cues = [];
    totalChars = 0;
  }
}

console.log(`《${d.title}》 ${d.owner?.name} · ${stamp(dur)} · 字幕段 ${cues.length} / ${totalChars} 字`);

if (!useSubs || !cues.length || totalChars < 300) {
  // 兜底一：本地 ASR 转写（whisper.cpp，离线）；失败再退简介+评论
  let heard = '';
  try {
    const wav = join(HOME, 'out', 'asr', `${bvid}.wav`);
    const m4a = join(HOME, 'out', 'asr', `${bvid}.m4a`);
    mkdirSync(join(HOME, 'out', 'asr'), { recursive: true });
    if (!existsSync(m4a)) {
      execFileSync('python3', [join(homedir(), '.dsh', 'dafeiyu', 'chat', '..', '..', '..', '..', '..', 'usr', 'bin', 'yt-dlp'), '-q', '-f', 'bestaudio/best', '-o', m4a, `https://www.bilibili.com/video/${bvid}`], { stdio: 'ignore' });
    }
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', m4a, '-t', '180', '-ar', '16000', '-ac', '1', wav]);
    const BIN = process.env.WHISPER_BIN || join(homedir(), 'whisper.cpp-1.4.2', 'main');
    const MODEL = join(process.env.WHISPER_MODEL_DIR || join(homedir(), 'whisper.cpp-master', 'models'), `ggml-${modelName}.bin`);
    if (existsSync(BIN) && existsSync(MODEL)) {
      // 2026-11-02 实测（60 秒真实人声，8 核、系统 load 13）：
      //   small  89.8s（0.67x 实时）→ 3 分钟片要 4 分半，陪看不可用
      //   base   11.3s（5.3x 实时）→ 3 分钟片 34 秒，文本和 small 几乎一样 ← 默认
      //   tiny   1.9s/12s 音频，但同音字错得多（人名同音字）
      // 要更准再加 --model small，自己承担时间。
      const srtBase = join(HOME, 'out', 'asr', bvid);
      execFileSync(BIN, ['-m', MODEL, '-f', wav, '-l', 'zh', '-t', '4', '-osrt', '-of', srtBase, '--prompt', '以下是普通话的句子。'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // 时间码比纯文本值钱：边看边说的时候要说「第几分钟讲到哪」。
      if (existsSync(srtBase + '.srt')) {
        const srt = readFileSync(srtBase + '.srt', 'utf8');
        heard = srt.split(/\n\n+/).map((blk) => {
          const ls = blk.split('\n').filter(Boolean);
          const tm = ls.find((l) => l.includes('-->'));
          if (!tm) return '';
          const a = tm.split('-->')[0].trim().split(/[:,]/).map(Number);
          const sec = a[0] * 3600 + a[1] * 60 + a[2];
          const txt = ls.filter((l) => !l.includes('-->') && !/^\d+$/.test(l)).join('').trim();
          return txt ? `[${stamp(sec)}] ${txt}` : '';
        }).filter(Boolean).join('\n');
      }
    }
  } catch (e) { heard = ''; }
  // 2026-11-01 踩到：纯音乐/无语音时 whisper 会复读同一句。同一句占三成以上就判无效。
  const parts = heard.split(/[。！？!?\n]/).map((t) => t.trim()).filter((t) => t.length > 4);
  const freq = new Map();
  for (const t of parts) freq.set(t, (freq.get(t) || 0) + 1);
  const topFreq = Math.max(0, ...freq.values());
  const looping = parts.length >= 5 && topFreq / parts.length > 0.3;
  if (looping) console.log(`\n[提示] 转写疑似复读（同一句占 ${(topFreq / parts.length * 100).toFixed(0)}%），判为无效，走简介兜底。`);
  if (heard.length > 40 && !looping) {
    console.log(`\n[本地转写] 前 3 分钟 ${heard.length} 字（字幕不足 ${totalChars} 字）：\n${heard.slice(0, 1500)}`);
    process.exit(0);
  }
  // 兜底二：简介 + 前排评论（零图片 token）
  console.log(`\n[兜底] 本地 ASR 也没出字（字幕 ${totalChars} 字），改读简介与前排评论。`);
  console.log(`简介：${(d.desc || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  const r = await (await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&sort=1&ps=5&pn=1`, { headers: H })).json();
  for (const x of (r.data?.replies || [])) {
    const t = (x.content?.message || '').replace(/\s+/g, ' ').slice(0, 160);
    if (t) console.log(`· [赞${x.like}] ${t}`);
  }
  console.log(`\n本轮约 ${(d.desc || '').length + 400} 字输入；抽帧方案同段约 60 张图（≈7 万 token）。`);
  process.exit(0);
}

// 分段计划：每轮 maxChars，按秒数切
const buckets = [];
let cur = { from: null, to: 0, chars: 0 };
for (const c of cues) {
  if (cur.from === null) cur.from = c.from;
  if (cur.chars > 0 && cur.chars + c.text.length > maxChars) { buckets.push(cur); cur = { from: c.from, to: c.to, chars: 0 }; }
  cur.to = c.to; cur.chars += c.text.length;
}
if (cur.from !== null) buckets.push(cur);
console.log(`分段计划（每段 ≤${maxChars} 字）：` + buckets.map((b, i) => `第${i + 1}段 ${stamp(b.from)}–${stamp(b.to)} ${b.chars}字`).join('；'));
if (planOnly) process.exit(0);

// 本轮增量：from 之后、累计到 maxChars
let out = '', chars = 0, startT = null, endT = 0, nextFrom = null;
for (const c of cues) {
  if (c.from < from) continue;
  if (chars > 0 && chars + c.text.length > maxChars) { nextFrom = c.from; break; }
  if (startT === null) startT = c.from;
  out += c.text;
  chars += c.text.length;
  endT = c.to;
}
const remain = cues.filter((c) => c.from >= (nextFrom ?? Infinity)).reduce((a, c) => a + c.text.length, 0);
console.log(`\n本轮 ${stamp(startT ?? 0)}–${stamp(endT)}，${chars} 字：\n${out}`);
if (nextFrom !== null) console.log(`\n下一轮从 --from ${Math.floor(nextFrom)} 接着喂；剩余约 ${remain} 字。`);
else console.log('\n字幕到头了。');
