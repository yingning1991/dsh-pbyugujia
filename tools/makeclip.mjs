#!/usr/bin/env node
/** makeclip.mjs —— 一条命令出一条竖屏/横屏短片：TTS 旁白 + 纯色卡 + 烧字幕。
 *
 * 用法：node tools/makeclip.mjs spec.json
 * spec: { "out": "out/clip/a.mp4", "narration": "旁白文字", "w":1280, "h":720,
 *         "bg":"0x1b2a41", "fg":"0xF2E9DA", "sub":"0xB9A88C",
 *         "cards": [{"title":"…","line":"…","sec":0}, …] }   // sec=0 表示按旁白时长均分
 * 只依赖 ffmpeg + say2.mjs，不联网（除 TTS）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ffmpeg 的报错默认是 Buffer，看不懂；统一转成可读文本再抛（2026-11-04 加）
process.on('uncaughtException', (e) => {
  const st = e && e.stderr ? e.stderr.toString() : '';
  console.error('\n✗ ' + (e && e.message ? e.message : e));
  if (st) console.error(st.trim());
  process.exit(1);
});

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'dafeiyu');
const specPath = process.argv[2];
if (!specPath) { console.log('用法：node tools/makeclip.mjs spec.json'); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const W = spec.w || 1280, H = spec.h || 720;
const FONT = spec.font || '/system/fonts/SysSans-Hans-Regular.ttf';
const BG = spec.bg || '0x1b2a41', FG = spec.fg || '0xF2E9DA', SUB = spec.sub || '0xB9A88C';
const cards = (spec.cards || []).filter((c) => c && (c.title || c.line));
if (!cards.length) { console.log('spec 里没有 cards'); process.exit(2); }
mkdirSync(join(DIR, 'out', 'clip'), { recursive: true });

// 1) 旁白
let audio = null, dur = cards.reduce((a, c) => a + (Number(c.sec) || 0), 0);
// 2026-11-02：支持 spec.audio 直接给一条已经拼好的旁白（分段 TTS 后拼起来用），
// 这样每张卡的 sec 可以严格等于那一段旁白的真实时长，卡和语音不会错位。
if (spec.audio && existsSync(spec.audio)) {
  audio = spec.audio;
  dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { encoding: 'utf8' }).trim()) || dur;
}
if (spec.narration) {
  const p = execFileSync('node', [join(DIR, 'voice', 'say2.mjs'), spec.narration], { encoding: 'utf8' }).trim().split('\n').pop().trim();
  if (existsSync(p)) {
    audio = p;
    dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim()) || dur;
  } else console.log('TTS 没出文件，走静音版');
}
if (!dur) dur = cards.length * 4;
// 没写 sec 的卡按均分
const fixed = cards.filter((c) => Number(c.sec) > 0);
const rest = dur - fixed.reduce((a, c) => a + Number(c.sec), 0);
const auto = cards.length - fixed.length;
for (const c of cards) if (!Number(c.sec)) c.sec = auto > 0 ? Math.max(1.2, rest / auto) : 2.5;

// 2) 逐卡建片段
const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/%/g, '\\\\%');
// 按字数自动断行（drawtext 不会自己换行）：中文一行 14 字，英文按 26 字符
const wrap = (t, n = 14) => {
  const s = String(t || '').trim();
  if (!s) return [''];
  const chars = [...s];
  const out = [];
  let cur = '';
  for (const ch of chars) {
    cur += ch;
    const limit = /[\u3400-\u9fff]/.test(ch) ? n : Math.round(n * 1.9);
    if ([...cur].length >= limit) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  // 2026-11-04：别留孤字——末行只剩 1~2 个字就重新均分（「…都在报」+「数」这种最难看）
  if (out.length > 1) {
    const last = [...out[out.length - 1]].length;
    if (last <= 2) {
      const all = [...s];
      const lines = out.length;
      const per = Math.ceil(all.length / lines);
      const bal = [];
      for (let k = 0; k < lines; k++) bal.push(all.slice(k * per, (k + 1) * per).join(''));
      return bal.filter(Boolean);
    }
  }
  return out;
};
const parts = [];
const xfd = Math.max(0, Math.min(1.2, Number(spec.xfade ?? 0.45)));  // 卡间交叉淡入秒数，0 关闭
// 字号按短边自适应：1080×1920 竖屏 95/47，1280×720 横屏仍是 63/32（保持原来的观感）
const base = Math.min(W, H);
const TITLE = Math.round(Number(spec.titleSize) || base * 0.088);
const LINE = Math.round(Number(spec.lineSize) || TITLE * 0.5);
const TL_GAP = Math.round(TITLE * 1.19), LL_GAP = Math.round(LINE * 1.25);
const FOOT = spec.footer ? wrap(spec.footer, 20) : [];

// 渐变底图：纯色太死，改用上下渐变；ffmpeg 这版没有 gradients 滤镜，用 geq 画一张复用
const BGIMG = join(DIR, 'out', 'clip', `.bg-${W}x${H}-${BG.replace(/^0x/, '')}.png`);
if (!existsSync(BGIMG)) {
  const hex = BG.replace(/^0x/, '');
  const r0 = parseInt(hex.slice(0, 2), 16), g0 = parseInt(hex.slice(2, 4), 16), b0 = parseInt(hex.slice(4, 6), 16);
  // 顶部只提亮 22 级，往下回到本色——保持深底，不要发灰
  const lift = (v) => Math.min(255, v + 22);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=${BG}:s=${W}x${H}:d=1`, '-vf',
    `geq=r='${lift(r0)}-${lift(r0) - r0}*(Y/H)':g='${lift(g0)}-${lift(g0) - g0}*(Y/H)':b='${lift(b0)}-${lift(b0) - b0}*(Y/H)',noise=alls=6:allf=t+u`,
    '-frames:v', '1', BGIMG]);
}
// 2026-11-04 他定：画面要「有形象、有层次」，别只有一屏大字（参考 大肥鱼日记 Day 0 的观感）
// spec.avatar = 透明 PNG 立绘；给了才走「立绘版式」：左对齐标题 + 竖条 + 顶部系列条 + 右下立绘
const AV = spec.avatar ? join(DIR, spec.avatar) : null;
const AVH = AV ? Math.round(H * Number(spec.avatarHeight || (W < H ? 0.66 : 0.95))) : 0;
const ACCENT = spec.accent || '0x7FA3C9';
const OCEAN = spec.bgImage ? join(DIR, spec.bgImage) : null;
const PINK = spec.pink || '0xF7C3D0';
const BGIN = OCEAN || BGIMG;
const TXT_X = Math.round(W * (OCEAN ? 0.395 : W < H ? 0.075 : 0.06));
const MAXW = AV ? Math.round(OCEAN ? W - TXT_X - Math.round(W * 0.055) : W * (W < H ? 0.86 : 0.60)) : 0;
const GOLD = spec.gold || '0xE9BC77';
const TOPL = spec.top ? String(spec.top) : '';
const TOPR = spec.ep ? String(spec.ep) : '';
const STRIP = Math.max(20, Math.round(base * 0.028));
const FOOT_SZ = Math.max(20, Math.round(base * 0.026));

cards.forEach((c, i) => {
  const seg = join(DIR, 'out', 'clip', `.seg${i}.mp4`);
  const dur = c.sec + (i < cards.length - 1 ? xfd : 0);  // 前 n-1 张多留 xfd，交叉时被吃掉
  // 2026-11-04：标题能一行放下就别断行——先缩字号（不低于 0.62 倍），缩不下才均衡断行
  const tRaw = [...String(c.title || '')].length;
  const fitSize = Math.floor(MAXW / Math.max(1, tRaw) * 0.96);
  const TITLE_C = AV ? Math.min(TITLE, Math.max(Math.round(TITLE * 0.62), fitSize)) : TITLE;
  const nT = AV
    ? Math.max(8, Math.floor(MAXW / TITLE_C * 1.02))
    : Math.max(8, Math.round(W / TITLE * 1.5));
  const nL = AV ? Math.max(10, Math.floor(MAXW / LINE * 1.05)) : Math.max(10, Math.round(W / LINE * 1.1));
  const tl = wrap(c.title || '', nT);
  const ll = wrap(c.line || '', nL);
  const TL_GAP_C = Math.round(TITLE_C * 1.16);
  const tlH = tl.length * TL_GAP_C, llH = ll.length * LL_GAP;
  const top = AV
    ? Math.round(H * 0.165)
    : Math.round((H - tlH - llH - Math.round(LINE * 0.75)) / 2);
  const xT = AV ? TXT_X : '(w-tw)/2';
  const vfArr = [];
  if (OCEAN && spec.notebook) {
    // —— 2026-11-04 他定：长方形本子 + 粉色回形针别着 + 账本卡压右下角，纸内文案居中 ——
    const nb = spec.notebook === true ? {} : spec.notebook;
    const nbW = Math.round(nb.w || W * 0.49);
    const nbH = Math.round(nb.h || H * 0.55);
    const nbX = Math.round(nb.x || W * 0.355);
    const nbY = Math.round(nb.y || H * 0.16);
    const inPad = Math.round(nbW * 0.075);
    const innerW = nbW - inPad * 2;
    // 纸影 + 纸 + 细边
    vfArr.push(`drawbox=x=${nbX + 8}:y=${nbY + 10}:w=${nbW}:h=${nbH}:color=0x000000@0.28:t=fill`);
    vfArr.push(`drawbox=x=${nbX}:y=${nbY}:w=${nbW}:h=${nbH}:color=0xF4EFE6@0.96:t=fill`);
    vfArr.push(`drawbox=x=${nbX}:y=${nbY}:w=${nbW}:h=${nbH}:color=${PINK}@0.45:t=2`);
    // 粉色回形针：别在纸的左上角，像一个 U 形夹子跨过纸边
    const cwid = Math.max(5, Math.round(nbW * 0.009));   // 夹子线宽
    const clen = Math.round(nbH * 0.20);                 // 夹子长度
    const cgap = Math.round(cwid * 4);                   // 两根竖线的间距
    const cx = nbX + nbW - Math.round(nbW * 0.13) - Math.round(cwid * 5);
    const cy = nbY - Math.round(clen * 0.45);
    vfArr.push(`drawbox=x=${cx}:y=${cy}:w=${cwid}:h=${clen}:color=${PINK}@0.98:t=fill`);
    vfArr.push(`drawbox=x=${cx + cgap}:y=${cy + Math.round(cwid * 0.4)}:w=${cwid}:h=${clen - Math.round(cwid * 1.4)}:color=${PINK}@0.98:t=fill`);
    vfArr.push(`drawbox=x=${cx}:y=${cy}:w=${cgap + cwid}:h=${cwid}:color=${PINK}@0.98:t=fill`);
    vfArr.push(`drawbox=x=${cx + cgap}:y=${cy + clen - Math.round(cwid * 1.4)}:w=${cgap + cwid - cgap}:h=${cwid}:color=${PINK}@0.98:t=fill`);
    // 横线纹理
    for (let k = 1; k * Math.round(LINE * 1.35) < nbH - inPad; k++) {
      const ly = nbY + inPad + k * Math.round(LINE * 1.35);
      vfArr.push(`drawbox=x=${nbX + inPad}:y=${ly}:w=${innerW}:h=1:color=0x9A8F86@0.26:t=fill`);
    }
    // 文案：纸内垂直居中
    const iw = innerW;
    // 2026-11-04 他：标题字号必须整片一致，不许一句大一句小——固定字号，长了就折两行
    const TSZ = Math.round(base * 0.078);
    const nT2 = Math.max(6, Math.floor(iw / TSZ * 1.02));
    // 标题允许写成数组，指定在哪断行（避免把词拆开，如「复/盘」）
    const tl2 = Array.isArray(c.title) ? c.title.map(String) : wrap(c.title || '', nT2);
    // 补充行：折行用的字号必须等于实际绘制字号（11-04 修：原来按 26 算、按 37 画，字会出纸）
    const LL2 = Math.round(TSZ * 0.46 * 1.42);
    const nL2 = Math.max(8, Math.floor(iw / LL2 * 1.02));
    const ll2 = wrap(c.line || '', nL2);
    const gap2 = Math.round(TSZ * 0.35);
    const innerH2 = tl2.length * Math.round(TSZ * 1.16) + (ll2.join('') ? gap2 + ll2.length * Math.round(LL2 * 1.3) : 0);
    const ty = nbY + Math.round((nbH - innerH2) / 2);
    vfArr.push(...tl2.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=0xB9781F:fontsize=${TSZ}:x=${nbX + inPad}:y=${ty + k * Math.round(TSZ * 1.16)}`));
    vfArr.push(...ll2.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=0x5E5348:fontsize=${LL2}:x=${nbX + inPad}:y=${ty + tl2.length * Math.round(TSZ * 1.16) + gap2 + k * Math.round(LL2 * 1.3)}`));
    if (TOPL) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPL)}':fontcolor=${SUB}@0.92:fontsize=${STRIP}:x=w-tw-${Math.round(W * 0.035)}:y=${Math.round(H * 0.045)}`);
    if (TOPR) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPR)}':fontcolor=${SUB}@0.62:fontsize=${Math.round(STRIP * 0.82)}:x=w-tw-${Math.round(W * 0.035)}:y=${Math.round(H * 0.045) + Math.round(STRIP * 1.35)}`);
    // 账本卡：压到画面最右下角
    const lg2 = spec.ledger;
    if (lg2) {
      const lw = Math.round(W * 0.145), lh = Math.round(H * 0.13);
      const m = Math.round(W * 0.016);
      const lx = W - lw - m, ly = H - lh - m;
      const idx = String(i + 1).padStart(2, '0');
      vfArr.push(`drawbox=x=${lx}:y=${ly}:w=${lw}:h=${lh}:color=${PINK}@0.16:t=fill`);
      vfArr.push(`drawbox=x=${lx}:y=${ly}:w=${lw}:h=${lh}:color=${PINK}@0.72:t=2`);
      vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(lg2.label || '今日账本')}':fontcolor=${PINK}:fontsize=${Math.round(base * 0.023)}:x=${lx + Math.round(lw * 0.1)}:y=${ly + Math.round(lh * 0.14)}`);
      if (cards.length > 1) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(idx + ' / ' + String(cards.length).padStart(2, '0'))}':fontcolor=0xF2EDE4:fontsize=${Math.round(base * 0.036)}:x=${lx + Math.round(lw * 0.1)}:y=${ly + Math.round(lh * 0.4)}`);
      if (lg2.value) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(lg2.value)}':fontcolor=${GOLD}:fontsize=${Math.round(base * 0.024)}:x=${lx + Math.round(lw * 0.1)}:y=${ly + Math.round(lh * 0.72)}`);
    }
  } else if (OCEAN) {
    const pad = Math.round(H * 0.055);
    const boxY = Math.round(H * 0.19);
    const boxW = MAXW + pad * 2;
    const boxH = tlH + pad * 2;
    vfArr.push(`drawbox=x=${TXT_X - pad}:y=${boxY}:w=${boxW}:h=${boxH}:color=${PINK}@0.18:t=fill`);
    vfArr.push(`drawbox=x=${TXT_X - pad}:y=${boxY}:w=${boxW}:h=${boxH}:color=${PINK}@0.88:t=2`);
    vfArr.push(`drawbox=x=${TXT_X - pad}:y=${boxY}:w=${Math.round(boxW * 0.22)}:h=${Math.max(3, Math.round(H * 0.006))}:color=${GOLD}@0.95:t=fill`);
    vfArr.push(...tl.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${FG}:fontsize=${TITLE_C}:x=${TXT_X}:y=${boxY + pad + k * TL_GAP_C}`));
    // 顶部两个小字都靠右：左上被鱼占住了，别往里塞
    // 小账本卡（他 11-04 要的第 2 种）：右下角，粉色细框，序号会变，配字幕读
    const lg = spec.ledger;
    if (lg) {
      const lw = Math.round(W * 0.155), lh = Math.round(H * 0.135);
      const lx = W - lw - Math.round(W * 0.035), ly = H - lh - Math.round(H * 0.175);
      const idx = String(i + 1).padStart(2, '0');
      vfArr.push(`drawbox=x=${lx}:y=${ly}:w=${lw}:h=${lh}:color=${PINK}@0.14:t=fill`);
      vfArr.push(`drawbox=x=${lx}:y=${ly}:w=${lw}:h=${lh}:color=${PINK}@0.7:t=2`);
      vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(lg.label || '今日账本')}':fontcolor=${PINK}:fontsize=${Math.round(base * 0.024)}:x=${lx + Math.round(W * 0.015)}:y=${ly + Math.round(H * 0.018)}`);
      vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(idx + ' / ' + String(cards.length).padStart(2, '0'))}':fontcolor=${FG}:fontsize=${Math.round(base * 0.038)}:x=${lx + Math.round(W * 0.015)}:y=${ly + Math.round(H * 0.052)}`);
      if (lg.value) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(lg.value)}':fontcolor=${GOLD}:fontsize=${Math.round(base * 0.026)}:x=${lx + Math.round(W * 0.015)}:y=${ly + Math.round(H * 0.098)}`);
    }
    if (TOPL) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPL)}':fontcolor=${SUB}@0.92:fontsize=${STRIP}:x=w-tw-${Math.round(W * 0.035)}:y=${Math.round(H * 0.045)}`);
    if (TOPR) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPR)}':fontcolor=${SUB}@0.62:fontsize=${Math.round(STRIP * 0.82)}:x=w-tw-${Math.round(W * 0.035)}:y=${Math.round(H * 0.045) + Math.round(STRIP * 1.35)}`);
    // 金色字幕：贴底、居中，上方一条细金线
    const gsz = Math.round(base * 0.062);
    const gtxt = (c.line || '').trim();
    if (gtxt) {
      const gl = wrap(gtxt, Math.max(10, Math.floor((W * 0.92) / gsz)));
      const gh = gl.length * Math.round(gsz * 1.3);
      // 2026-11-04：字幕原来贴底被切，抬到安全区内（距底 9%）
      const gy = H - gh - Math.round(H * 0.09);
      vfArr.push(`drawbox=x=${Math.round(W / 2) - 130}:y=${gy - Math.round(H * 0.035)}:w=260:h=${Math.max(2, Math.round(H * 0.004))}:color=${GOLD}@0.5:t=fill`);
      vfArr.push(...gl.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${GOLD}:fontsize=${gsz}:x=(w-tw)/2:y=${gy + k * Math.round(gsz * 1.3)}`));
    }
  } else {
    if (AV) {
      if (TOPL) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPL)}':fontcolor=${SUB}@0.75:fontsize=${STRIP}:x=${TXT_X}:y=${Math.round(H * 0.055)}`);
      if (TOPR) vfArr.push(`drawtext=fontfile=${FONT}:text='${esc(TOPR)}':fontcolor=${SUB}@0.75:fontsize=${STRIP}:x=w-tw-${TXT_X}:y=${Math.round(H * 0.055)}`);
    }
    vfArr.push(
      ...tl.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${FG}:fontsize=${TITLE_C}:x=${xT}:y=${Math.round(top + k * TL_GAP_C)}`),
      ...ll.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${SUB}:fontsize=${LINE}:x=${xT}:y=${Math.round(top + tlH + LINE * 0.75 + k * LL_GAP)}`),
    );
  }
  if (AV && !OCEAN) {
    vfArr.push(`drawbox=x=${TXT_X}:y=${Math.round(top + tlH + Math.round(TITLE_C * 0.12))}:w=${Math.round(base * 0.16)}:h=${Math.max(3, Math.round(base * 0.004))}:color=${ACCENT}@0.9:t=fill`);
  }
  // 落款：有立绘时挪到左下，别压住角色；没有立绘仍是右下（识别体系里的那一行小字）
  vfArr.push(...(OCEAN ? [] : FOOT.map((ln, k) => AV
    ? `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${SUB}@0.55:fontsize=${FOOT_SZ}:x=${TXT_X}:y=${H - Math.round(base * 0.055) - (FOOT.length - 1 - k) * Math.round(base * 0.036)}`
    : `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${SUB}@0.55:fontsize=${FOOT_SZ}:x=w-tw-${Math.round(W * 0.05)}:y=${H - Math.round(base * 0.055) - (FOOT.length - 1 - k) * Math.round(base * 0.036)}`)));
  // 第一张不做淡入：否则第 0 帧全黑，相册/B站抽缩略图就是一片黑（2026-11-01 他报的）
  if (xfd > 0 && i > 0) vfArr.push('fade=t=in:st=0:d=0.35');
  if (AV) {
    const axx = OCEAN ? -Math.round(W * 0.004) : W - Math.round(W * 0.05) - 0;
    const fc = `[0:v]scale=${W}:${H}[bg];[1:v]scale=-1:${AVH}[av];[bg][av]overlay=x=${OCEAN ? axx : W - W * 0.05}[base];[base]${vfArr.join(',')}[v]`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-i', BGIN, '-loop', '1', '-i', AV,
      '-filter_complex', fc, '-map', '[v]', '-t', dur.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg]);
  } else {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', BGIN,
      '-t', dur.toFixed(2), '-vf', vfArr.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg]);
  }
  parts.push(seg);
});

// 3) 拼接（xfade 交叉淡入）或直拼，再加混音
const out = spec.out || join(DIR, 'out', 'clip', 'clip.mp4');
let args;
if (xfd > 0 && parts.length > 1) {
  const fc = [];
  let prev = '[0:v]', off = 0;
  for (let i = 1; i < parts.length; i++) {
    off += cards[i - 1].sec;
    const lbl = i === parts.length - 1 ? '[vout]' : `[vx${i}]`;
    const trans = spec.transition || 'fade';  // 文字卡建议 fadeblack：两张卡的字在交叉时会重影
    fc.push(`${prev}[${i}:v]xfade=transition=${trans}:duration=${xfd}:offset=${off.toFixed(3)}${lbl}`);
    prev = lbl;
  }
  args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const p of parts) args.push('-i', p);
  if (audio) args.push('-i', audio);
  // 2026-11-02：可选烧字幕（spec.subs 指向 .srt），底部一行，方便听不清时看。
  // original_size 必须给：libass 默认按 384×288 排版，不然字会被放大到溢出画面。
  let mapOut = '[vout]';
  if (spec.subs && existsSync(spec.subs)) {
    const style = spec.subsStyle || 'FontName=Noto Sans CJK SC,Fontsize=24,PrimaryColour=&H00F2E9DA,OutlineColour=&H00141D2B,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=36';
    fc.push(`[vout]subtitles='${spec.subs}':original_size=${W}x${H}:force_style='${style}'[vsub]`);
    mapOut = '[vsub]';
  }
  args.push('-filter_complex', fc.join(';'), '-map', mapOut);
  if (audio) args.push('-map', `${parts.length}:a`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
  args.push(out);
} else {
  const list = join(DIR, 'out', 'clip', '.list.txt');
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  if (audio) args.push('-i', audio);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
  args.push(out);
}
execFileSync('ffmpeg', args);
// 2026-11-05 修：单卡走 concat 分支时，原来在调 ffmpeg 之前就把 .list.txt 删了，
// 导致单卡永远出不了片（多卡走 xfade 不受影响，所以一直没露）。清理由这里统一做。
try { execFileSync('rm', ['-f', join(DIR, 'out', 'clip', '.list.txt')]); } catch {}
for (const p of parts) try { execFileSync('rm', ['-f', p]); } catch {}
const d2 = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
console.log(`成片 ${out}  时长/字节 ${d2}`);

// 4) 封面图（有 spec.cover 才出）：1280×720 16:9，B 站投稿用
if (spec.cover) {
  const cv = typeof spec.cover === 'object' ? spec.cover : {};
  const cw = 1280, ch = 720;
  const cAV = cv.avatar ? join(DIR, cv.avatar) : AV;   // 封面默认沿用正片的立绘
  const cT = Math.round(cv.titleSize || 96), cL = Math.round(cT * 0.42);
  const X = Math.round(cw * 0.055);
  const MAXT = cAV ? Math.round(cw * 0.56) : cw - X * 2;
  const ctl = wrap(cv.title || cards[0].title || '', Math.max(6, Math.floor(MAXT / cT * 1.02)));
  const cll = wrap(cv.line || cards[0].line || '', Math.max(10, Math.floor(MAXT / cL * 1.02)));
  const tH = ctl.length * Math.round(cT * 1.16);
  const card = cv.card || null;
  const CW = Math.round(cw * 0.375), CH = Math.round(ch * 0.24);
  const cardY = Math.round(ch * 0.155);
  const titleY = card ? cardY + CH + Math.round(ch * 0.075) : Math.round((ch - tH) / 2);
  const cvf = [];
  // 顶部系列条：左系列名、右期号
  if (cv.series || spec.top) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(cv.series || spec.top)}':fontcolor=${SUB}@0.8:fontsize=28:x=${X}:y=${Math.round(ch * 0.05)}`);
  if (cv.ep || spec.ep) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(cv.ep || spec.ep)}':fontcolor=${SUB}@0.8:fontsize=28:x=w-tw-${X}:y=${Math.round(ch * 0.05)}`);
  // 信息卡：奶白底 + 顶部一条强调色（借 Day 0 那个「10 硬币 = ¥1」的卡）
  if (card) {
    cvf.push(`drawbox=x=${X}:y=${cardY}:w=${CW}:h=${CH}:color=0xE8E2D6@0.28:t=2`);
    cvf.push(`drawbox=x=${X}:y=${cardY}:w=${Math.round(CW * 0.18)}:h=${Math.max(3, Math.round(ch * 0.005))}:color=${ACCENT}@0.95:t=fill`);
    if (card.label) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(card.label)}':fontcolor=0xC9C3B6:fontsize=24:x=${X + Math.round(CW * 0.07)}:y=${cardY + Math.round(CH * 0.18)}`);
    if (card.value) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(card.value)}':fontcolor=0xE0A45C:fontsize=${Math.round(ch * 0.082)}:x=${X + Math.round(CW * 0.07)}:y=${cardY + Math.round(CH * 0.34)}`);
    if (card.note) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(card.note)}':fontcolor=0x8E8779:fontsize=24:x=${X + Math.round(CW * 0.07)}:y=${cardY + Math.round(CH * 0.78)}`);
  }
  // 主标题：左对齐 + 左侧竖条
  cvf.push(`drawbox=x=${X - 22}:y=${titleY + Math.round(cT * 0.08)}:w=8:h=${Math.max(40, tH - Math.round(cT * 0.16))}:color=${ACCENT}@0.9:t=fill`);
  cvf.push(...ctl.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${FG}:fontsize=${cT}:x=${X}:y=${Math.round(titleY + k * cT * 1.16)}`));
  cvf.push(...cll.map((ln, k) => `drawtext=fontfile=${FONT}:text='${esc(ln)}':fontcolor=${SUB}:fontsize=${cL}:x=${X}:y=${Math.round(titleY + tH + cL * 0.5 + k * cL * 1.3)}`));
  // 底部字幕条：黑底白字，压住画面下沿（Day 0 的钩子就挂在这条上）
  if (cv.bar) {
    const barH = Math.round(ch * 0.125), barY = ch - barH - Math.round(ch * 0.045);
    const barTxt = String(cv.bar);
    const bs = Math.round(ch * 0.062);
    cvf.push(`drawbox=x=${X}:y=${barY}:w=${Math.round(cw * 0.9)}:h=${Math.max(2, Math.round(ch * 0.003))}:color=0xE8E2D6@0.45:t=fill`);
    cvf.push(`drawtext=fontfile=${FONT}:text='${esc(barTxt)}':fontcolor=F2EDE4:fontsize=${bs}:x=${X}:y=${barY + Math.round(barH * 0.42)}`);
  }
  if (cv.footer || spec.footer) cvf.push(`drawtext=fontfile=${FONT}:text='${esc(cv.footer || spec.footer)}':fontcolor=${SUB}@0.55:fontsize=22:x=w-tw-${X}:y=${ch - Math.round(ch * 0.05)}`);
  const cout = cv.out || join(DIR, 'out', 'clip', 'cover.png');
  if (cAV) {
    const cvh = Math.round(ch * Number(cv.avatarHeight || 0.96));
    const fc = `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0x0B1622@0.55:t=fill[bgv];[1:v]scale=-1:${cvh}[av];[bgv][av]overlay=x=${cw}-w+${Math.round(cw * 0.015)}:y=${ch}-h[base];[base]${cvf.join(',')}[v]`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      ...(OCEAN ? ['-loop','1','-i',OCEAN] : ['-f','lavfi','-i', `color=c=${BG}:s=${cw}x${ch}:d=1`]),
      '-i', cAV, '-filter_complex', fc, '-map', '[v]', '-frames:v', '1', cout]);
  } else {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=${BG}:s=${cw}x${ch}:d=1`, '-vf', cvf.join(','), '-frames:v', '1', cout]);
  }
  console.log(`封面 ${cout}`);
}

