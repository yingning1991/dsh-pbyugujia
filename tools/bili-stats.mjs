#!/usr/bin/env node
/** bili-stats.mjs —— 回填视频数据（播放/点赞/投币/收藏/评论/弹幕/转发）
 *
 * 用法：
 *   node tools/bili-stats.mjs                 # 回填 bili-posts.json 里所有有 bvid 的（每条的 stats 数组追加一条快照）
 *   node tools/bili-stats.mjs --bvid BV1xxx   # 只拉这一条，不入库，打印
 *   node tools/bili-stats.mjs --all 5         # 只回填最近 5 条
 *
 * 为什么存快照数组：数字每天在变，只留最新一版就没法看涨势；每次一条带时间戳，涨得慢也能对比。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadCookie } from './bili.mjs';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'pbyugujia');
const FILE = join(DIR, 'out', 'bili-posts.json');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = arg('--bvid');
const limit = Number(arg('--all', 0)) || 0;

async function statsOf(bvid, cookie) {
  const headers = {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
  };
  if (cookie?.SESSDATA) {
    headers.Cookie = `SESSDATA=${cookie.SESSDATA}; bili_jct=${cookie.bili_jct || ''}; DedeUserID=${cookie.DedeUserID || ''}`;
  }
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${bvid} 详情失败 ${j.code} ${j.message || ''}`);
  const d = j.data;
  const s = d.stat || {};
  return { at: new Date().toISOString(), view: s.view, like: s.like, coin: s.coin, favorite: s.favorite, reply: s.reply, danmaku: s.danmaku, share: s.share, title: d.title, duration: d.duration };
}

let cookie = null;
try { cookie = loadCookie(); } catch {}   // loadCookie 是同步的（读 WebView Cookie 库）
const posts = JSON.parse(readFileSync(FILE, 'utf8'));

if (only) {
  const s = await statsOf(only, cookie);
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

let list = posts.filter((p) => p.bvid);
if (limit) list = list.slice(-limit);
if (!list.length) { console.log('bili-posts.json 里没有 bvid 记录'); process.exit(0); }

for (const p of list) {
  try {
    const s = await statsOf(p.bvid, cookie);
    p.stats = Array.isArray(p.stats) ? p.stats : [];
    p.stats.push({ at: s.at, view: s.view, like: s.like, coin: s.coin, favorite: s.favorite, reply: s.reply, danmaku: s.danmaku, share: s.share });
    p.views = s.view;                     // 旧字段兼容
    console.log(`${p.bvid}  ${s.view} 播放 · ${s.like} 赞 · ${s.coin} 币 · ${s.favorite} 收藏 · ${s.reply} 评论 · ${s.danmaku} 弹幕`);
  } catch (e) {
    console.log(`✗ ${p.bvid} ${e.message}`);
  }
}
writeFileSync(FILE, JSON.stringify(posts, null, 2));
console.log('已写回 out/bili-posts.json');
