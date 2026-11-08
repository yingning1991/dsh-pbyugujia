/** bili.mjs —— B站接口的最小封装（wbi 签名 + 搜索 + 字幕） */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 路径不写死：优先环境变量，其次按 DSH 的 home 推出（Android 版是 <app>/files/home/.dsh）
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const COOKIE_JSON = process.env.BILI_COOKIE_JSON || join(HOME, 'dafeiyu', 'bili-cookie.json');
const WEBVIEW_COOKIES = process.env.BILI_WEBVIEW_COOKIES || join(HOME, '..', '..', '..', 'app_webview', 'Default', 'Cookies');

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

export function loadCookie() {
  // 优先读插件目录里存的（重启不会丢）；没有再回落到 WebView 的库
  try {
    const f = COOKIE_JSON;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.SESSDATA) return j;
  } catch { /* 没存过 */ }
  const db = new DatabaseSync(WEBVIEW_COOKIES);
  const rows = db.prepare(
    "select name, value from cookies where host_key = '.bilibili.com' and name in ('SESSDATA','bili_jct','DedeUserID')"
  ).all();
  const m = Object.fromEntries(rows.map(r => [r.name, r.value]));
  if (!m.SESSDATA) throw new Error('没有 B 站登录态（先去浏览器登录一次）');
  return m;
}

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

function headers(cookie) {
  return {
    'Cookie': `SESSDATA=${cookie.SESSDATA}; bili_jct=${cookie.bili_jct || ''}; DedeUserID=${cookie.DedeUserID || ''}`,
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
  };
}

let cacheKeys = null;
export async function getWbiKeys(cookie) {
  if (cacheKeys) return cacheKeys;
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: headers(cookie) });
  const j = await r.json();
  const img = j.data?.wbi_img?.img_url || '';
  const sub = j.data?.wbi_img?.sub_url || '';
  const pick = (u) => u.split('/').pop().split('.')[0];
  cacheKeys = { imgKey: pick(img), subKey: pick(sub) };
  return cacheKeys;
}

export function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_TAB.map(n => raw[n] || '').join('').slice(0, 32);
}

export function signWbi(params, key) {
  const wts = Math.round(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map(k => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const w_rid = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

export async function searchVideos(keyword, { order = 'pubdate', num = 12, cookie }) {
  const keys = await getWbiKeys(cookie);
  const key = mixinKey(keys.imgKey, keys.subKey);
  const q = signWbi({
    search_type: 'video',
    keyword,
    order,
    page: 1,
    page_size: num,
  }, key);
  const r = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`, { headers: headers(cookie) });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`搜索失败 ${j.code} ${j.message}`);
  return (j.data?.result || []).map(v => ({
    bvid: v.bvid,
    title: String(v.title || '').replace(/<[^>]+>/g, ''),
    author: v.author,
    play: v.play,
    pubdate: v.pubdate,
    duration: v.duration,
    desc: (v.description || '').slice(0, 120),
  }));
}

export async function getSubtitle(bvid, cookie) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: headers(cookie) });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`详情失败 ${j.code}`);
  const aid = j.data.aid;
  const cid = j.data.cid;
  // 2026-10-31 修：wbi/v2 无签名会 412（返回 HTML）；plain /x/player/v2 仍可用，先用它，失败再退签名版。
  let pj;
  try {
    const p0 = await fetch(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`, { headers: headers(cookie) });
    pj = await p0.json();
    if (pj.code !== 0) pj = null;
  } catch { pj = null; }
  if (!pj) {
    const keys = await getWbiKeys(cookie);
    const key = mixinKey(keys.imgKey, keys.subKey);
    const q = signWbi({ aid, cid }, key);
    const p = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${q}`, { headers: headers(cookie) });
    pj = await p.json();
  }
  const subs = pj.data?.subtitle?.subtitles || [];
  if (!subs.length) return { title: j.data.title, text: '' };
  const url = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url;
  const s = await fetch(url, { headers: { 'User-Agent': UA } });
  const sj = await s.json();
  const text = (sj.body || []).map(x => x.content).join('');
  return { title: j.data.title, text };
}

// 带时间戳的字幕：陪看用。返回 { title, cues: [{from,to,text}] }，无轨时 cues 为空。
export async function getSubtitleCues(bvid, cookie) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: headers(cookie) });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`详情失败 ${j.code}`);
  const { aid, cid, title } = j.data;
  let pj = null;
  try {
    const p0 = await fetch(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`, { headers: headers(cookie) });
    const t = await p0.json();
    if (t.code === 0) pj = t;
  } catch { /* 走签名版 */ }
  if (!pj) {
    const keys = await getWbiKeys(cookie);
    const key = mixinKey(keys.imgKey, keys.subKey);
    const q = signWbi({ aid, cid }, key);
    const p = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${q}`, { headers: headers(cookie) });
    pj = await p.json();
  }
  const subs = (pj?.data?.subtitle?.subtitles || []).filter((x) => x && x.subtitle_url);
  if (!subs.length) return { title, cues: [], aid, cid };
  const url = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url;
  const s = await fetch(url, { headers: { 'User-Agent': UA } });
  const sj = await s.json();
  const cues = (sj.body || []).map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, text: String(x.content || '').trim() })).filter((c) => c.text);
  return { title, cues, aid, cid };
}
