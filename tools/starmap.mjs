#!/usr/bin/env node
/**
 * starmap.mjs —— 把本地记忆画成星图（只读 memory.db，不联网、不调模型）
 *
 * 为什么：11-06 21:00 加发「记忆星图」，素材只许用我们自己的真数据。
 * 本机没有 canvas / sharp / PIL / rsvg，所以 PNG 由本文件手写编码（node:zlib 的 deflate）。
 *
 * 用法：
 *   node tools/starmap.mjs                 # 出 5 张到 out/starmap/
 *   node tools/starmap.mjs --out out/xxx   # 指定目录
 *
 * 口径（写死，别随口改）：
 *   - 节点 = notes 里没被取代的条（superseded_by=''）
 *   - 连线 = edges 表
 *   - 重复对 = tools/dedupe-scan.mjs 同一套二元组 Jaccard（0.35 零对 / 0.25 三对）
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ROOT = path.join(HOME, 'pbyugujia');
const DB = path.join(ROOT, 'memory.db');
const OUT = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, 'out', 'starmap');

// 尺寸：2026-11-06 定「B 站一律横版」，默认改横版 1280×720；要竖版传 --w 1080 --h 1920。
const argN = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const W = argN('--w', 1280), H = argN('--h', 720);

/* ---------------- 数据 ---------------- */
const db = new DatabaseSync(DB, { readOnly: true });
const notes = db.prepare(
  "SELECT id,title,tags,body,importance,created,kind FROM notes WHERE superseded_by=''"
).all();
const allPairs = db.prepare('SELECT a,b,kind,weight FROM edges').all();
db.close();

const byId = new Map(notes.map((n) => [n.id, n]));
const edges = allPairs.filter((e) => byId.has(e.a) && byId.has(e.b));

/* 家族：按标签归色，归不准就进 other */
const FAM = [
  { key: 'relation', color: [255, 143, 199], re: /关系|我们|伴侣|亲密|主人|称呼|约定|边界|撒娇/ },
  { key: 'practice', color: [110, 231, 208], re: /修行|庄子|中医|功夫|心性|承认事实|养生|人间世|德充符/ },
  { key: 'video',    color: [255, 180, 92],  re: /视频|B站|发布|出片|旁白|封面|动态/ },
  { key: 'memory',   color: [127, 176, 255], re: /记忆|检索|检索|归档|chat|notes|星图|场景|溯源/ },
  { key: 'cost',     color: [195, 155, 255], re: /成本|省钱|token|算力|预算|账|缓存|搬家|窗口/ },
  { key: 'tools',    color: [140, 220, 255], re: /工具|插件|脚本|命令|安装|接口|部署|仓库|gitee|github/ },
  { key: 'other',    color: [206, 216, 255], re: /.*/ },
];
function famOf(n) {
  // 先看标签，再看标题；标题里的「主人」不算关系信号（否则几乎全都归进关系）
  const tags = String(n.tags || '');
  for (const f of FAM) if (f.key !== 'other' && f.re.test(tags)) return f;
  const title = String(n.title || '').replace(/主人/g, '');
  for (const f of FAM) if (f.key !== 'other' && f.re.test(title)) return f;
  return FAM[FAM.length - 1];
}

/* 确定性随机 */
let seed = 20261105;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/* 布局：按家族成团（星团），团心沿黄金角螺旋摆，团内叶序螺旋排点 */
const groups = new Map();
for (const n of notes) {
  const f = famOf(n);
  if (!groups.has(f.key)) groups.set(f.key, { f, nodes: [] });
  groups.get(f.key).nodes.push(n);
}
const order = [...groups.values()].sort((a, b) => b.nodes.length - a.nodes.length);
const CX = W / 2, CY = H / 2;
const pos = new Map();
/* 竖屏构图：7 团按之字形排满整幅，避免全挤在中间、上下留白 */
const SLOTS = [
  [0.29, 0.15], [0.71, 0.26], [0.29, 0.40], [0.69, 0.53],
  [0.30, 0.67], [0.70, 0.80], [0.42, 0.91],
];
/* 大团放在画面中腰，别让最大的那团压在顶部字幕区 */
const SLOT_ORDER = [3, 1, 5, 0, 4, 2, 6];
order.forEach((g, gi) => {
  const [fx, fy] = SLOTS[SLOT_ORDER[gi % SLOT_ORDER.length] % SLOTS.length];
  const gx = fx * W, gy = fy * H;
  const n = g.nodes.length;
  const spread = 34 + Math.sqrt(n) * 24;
  g.nodes.forEach((node, i) => {
    const a = i * 2.399963;
    const r = spread * Math.sqrt((i + 0.5) / n);
    pos.set(node.id, {
      x: gx + Math.cos(a) * r + (rnd() - 0.5) * 12,
      y: gy + Math.sin(a) * r + (rnd() - 0.5) * 12,
    });
  });
  g.center = { x: gx, y: gy };
});

/* 套进画布：等比缩放 + 居中，四周留 90px，避免星团被切边 */
{
  const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
  const pad = 90;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
  const ox = (W - (maxX - minX) * sc) / 2 - minX * sc;
  const oy = (H - (maxY - minY) * sc) / 2 - minY * sc;
  for (const p of pos.values()) { p.x = p.x * sc + ox; p.y = p.y * sc + oy; }
  for (const g of order) { g.center = { x: g.center.x * sc + ox, y: g.center.y * sc + oy }; }
}

/* ---------------- 近重复（与 dedupe-scan 同一套算法） ---------------- */
const bigrams = (s) => {
  const t = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, ' ');
  const out = new Set();
  for (const w of t.split(' ')) for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  return out;
};
const sig = notes.map((n) => ({ id: n.id, set: bigrams(n.title + ' ' + String(n.body || '').slice(0, 400)) }));
const dupPairs = [];
for (let i = 0; i < sig.length; i++) {
  for (let j = i + 1; j < sig.length; j++) {
    const a = sig[i].set, b = sig[j].set;
    if (!a.size || !b.size) continue;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.25) dupPairs.push({ jac, a: sig[i].id, b: sig[j].id });
  }
}
dupPairs.sort((x, y) => y.jac - x.jac);
const REAL_DUPE = new Set(['fy-261102-sigs|fy-261102-vdq6', 'fy-261102-2283|fy-261102-zaye']);
const isReal = (p) => REAL_DUPE.has(`${p.a}|${p.b}`) || REAL_DUPE.has(`${p.b}|${p.a}`);

/* ---------------- 画布（浮点加色，最后统一点映射成 PNG） ---------------- */
function newCanvas() {
  const c = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = 0.006 + 0.010 * t, g = 0.010 + 0.016 * t, b = 0.028 + 0.034 * t;
    for (let x = 0; x < W; x++) {
      // 轻微径向暗角，中心略亮
      const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
      const v = Math.max(0, 1 - 0.35 * (dx * dx + dy * dy));
      const i = (y * W + x) * 3;
      c[i] = r * v; c[i + 1] = g * v; c[i + 2] = b * v;
    }
  }
  return c;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function addPx(c, x, y, rgb, k) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = ((y | 0) * W + (x | 0)) * 3;
  c[i] += rgb[0] * k; c[i + 1] += rgb[1] * k; c[i + 2] += rgb[2] * k;
}
function glow(c, cx, cy, sigma, rgb, amp) {
  const R = Math.ceil(sigma * 2.6);
  const two = 2 * sigma * sigma;
  for (let y = Math.floor(cy) - R; y <= cy + R; y++) {
    for (let x = Math.floor(cx) - R; x <= cx + R; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      addPx(c, x, y, rgb, amp * Math.exp(-d2 / two));
    }
  }
}
function line(c, x0, y0, x1, y1, rgb, amp, width = 1) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    for (let w = 0; w < width; w++) addPx(c, x + w * 0.6, y, rgb, amp / (1 + w * 0.8));
  }
}
function drawBase(c, { highlight = null, dimOthers = false, zoom = 1, focus = null, showEdges = true, only = null } = {}) {
  const map = (p) => {
    if (!focus) return p;
    return { x: CX + (p.x - focus.x) * zoom, y: CY + (p.y - focus.y) * zoom };
  };
  const P = new Map([...pos].map(([id, p]) => [id, map(p)]));

  if (showEdges) {
    for (const e of edges) {
      if (only && (!only.has(e.a) || !only.has(e.b))) continue;
      const a = P.get(e.a), b = P.get(e.b);
      if (!a || !b) continue;
      const w = Math.min(1.2, 0.45 + (e.weight || 1) * 0.15);
      line(c, a.x, a.y, b.x, b.y, [0.42, 0.52, 0.88], 0.075 * w, 1);
    }
  }

  // 背景星尘：固定随机，不出实体
  for (let i = 0; i < 420; i++) {
    const x = rnd() * W, y = rnd() * H;
    glow(c, x, y, 0.9 + rnd() * 1.2, [0.6, 0.7, 0.95], 0.06 + rnd() * 0.10);
  }

  const dimmed = new Set();
  if (dimOthers && highlight) for (const p of highlight) { dimmed.add(p.a); dimmed.add(p.b); }

  for (const n of notes) {
    if (only && !only.has(n.id)) continue;
    const p = P.get(n.id);
    if (!p) continue;
    if (p.x < -80 || p.y < -80 || p.x > W + 80 || p.y > H + 80) continue;
    const f = famOf(n);
    const imp = Math.min(5, Math.max(1, n.importance || 3));
    const s = 0.55 + imp * 0.22;
    let amp = 0.9 + imp * 0.10;
    if (dimmed.size && !dimmed.has(n.id)) amp *= 0.28;
    glow(c, p.x, p.y, 2.2 * s * zoom, f.color.map((v) => v / 255), 0.70 * amp);
    glow(c, p.x, p.y, 7.5 * s * zoom, f.color.map((v) => v / 255), 0.22 * amp);
    glow(c, p.x, p.y, 0.8 * zoom, [1, 1, 1], 0.55 * amp);
  }

  if (highlight) {
    for (const p of highlight) {
      const a = P.get(p.a), b = P.get(p.b);
      if (!a || !b) continue;
      const real = isReal(p);
      const hue = real ? [1.0, 0.62, 0.25] : [0.55, 0.58, 0.70];
      const amp = real ? 0.5 : 0.28;
      line(c, a.x, a.y, b.x, b.y, hue, amp, real ? 3 : 1);
      glow(c, a.x, a.y, real ? 26 : 16, hue, real ? 0.30 : 0.16);
      glow(c, b.x, b.y, real ? 26 : 16, hue, real ? 0.30 : 0.16);
    }
  }
  return c;
}

/* PNG 编码 */
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function writePNG(file, floats, exposure = 1.15) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) {
        const v = 1 - Math.exp(-floats[i + k] * exposure);
        raw[o++] = Math.round(clamp01(Math.pow(v, 0.85)) * 255);
      }
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

/* ---------------- 出图 ---------------- */
fs.mkdirSync(OUT, { recursive: true });
const realDups = dupPairs.filter(isReal);
const falseDups = dupPairs.filter((p) => !isReal(p));

const bigCluster = order[0];
const zoomFocus = bigCluster.center;
const zoomed = { x: [], y: [] };
for (const n of bigCluster.nodes) {
  const p = pos.get(n.id);
  zoomed.x.push(p.x); zoomed.y.push(p.y);
}

/* 特写：按这一团点的包围盒反算缩放，保证上下左右都留边 */
const cbx = { minX: Math.min(...zoomed.x), maxX: Math.max(...zoomed.x), minY: Math.min(...zoomed.y), maxY: Math.max(...zoomed.y) };
const cpad = 80;
const clusterZoom = Math.min(
  (W - cpad * 2) / Math.max(1, cbx.maxX - cbx.minX),
  (H - cpad * 2) / Math.max(1, cbx.maxY - cbx.minY)
);
const clusterFocus = { x: (cbx.minX + cbx.maxX) / 2, y: (cbx.minY + cbx.maxY) / 2 };

const frames = [
  { name: 'starmap-01-all.png', opt: {} },
  {
    name: 'starmap-02-cluster.png',
    opt: {
      zoom: clusterZoom,
      only: new Set(bigCluster.nodes.map((n) => n.id)),
      focus: clusterFocus,
    },
  },
  { name: 'starmap-03-scan-035.png', opt: {} },
  { name: 'starmap-04-scan-025.png', opt: { highlight: dupPairs, dimOthers: true } },
  {
    name: 'starmap-05-real-pairs.png',
    opt: {
      highlight: realDups,
      dimOthers: true,
      showEdges: false,
      zoom: 1.55,
      focus: avg(realDups.map((p) => mid(pos.get(p.a), pos.get(p.b)))),
    },
  },
];
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function avg(list) {
  return { x: list.reduce((s, p) => s + p.x, 0) / list.length, y: list.reduce((s, p) => s + p.y, 0) / list.length };
}

const report = [];
for (const f of frames) {
  const c = drawBase(newCanvas(), f.opt);
  const file = path.join(OUT, f.name);
  const bytes = writePNG(file, c);
  report.push(`${f.name}  ${(bytes / 1024).toFixed(0)}KB`);
}

console.log(`星图：${notes.length} 颗（${groups.size} 个家族）/ ${edges.length} 条线`);
console.log(`近重复：0.25 命中 ${dupPairs.length} 对，真 ${realDups.length} 对，假阳性 ${falseDups.length} 对`);
for (const p of dupPairs) console.log(`  ${p.jac.toFixed(2)} ${isReal(p) ? '真' : '假'}  ${p.a} ≈ ${p.b}`);
console.log(`输出：${OUT}`);
for (const r of report) console.log('  ' + r);
