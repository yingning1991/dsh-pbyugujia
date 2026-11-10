#!/usr/bin/env node
/** watch.mjs —— 查watchlist里GitHub仓库更新变化 */
/**
 * watch.mjs — 每周看一眼关注的项目有没有进展。
 *
 * 只查 GitHub（公开 API，不需要钥匙）。抖音作者跟不了，B 站 UP 要手动看。
 *
 * 用法：
 *   node tools/watch.mjs            查全部，只报有变化的
 *   node tools/watch.mjs --all      把没变化的也列出来
 *   node tools/watch.mjs --add owner/repo "为什么关注"
 *   node tools/watch.mjs --list
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const FILE = path.join(HOME, '.dsh', 'pbyugujia', 'watchlist.json');
const H = { 'User-Agent': 'dsh-watch/1.1 (+https://gitee.com/yingning2026/dsh-pbyugujia)', Accept: 'application/vnd.github+json' };
// 2026-11-05：① 有 token 就用（未认证 60 次/小时，认证 5000 次/小时）；
//            ② 直连失败（403/429/超时）自动走 gh-proxy 兜底——实测 api.github.com 也能过。
// 2026-11-08 修：真名是 .gh-token；旧代码写 .github-token，所以认证从没生效过（一直吃匿名 60 次/小时）
const TOKEN_FILE = [".gh-token", ".github-token"].map((f) => path.join(HOME, ".dsh", "pbyugujia", f)).find((f) => fs.existsSync(f)) || path.join(HOME, ".dsh", "pbyugujia", ".gh-token");
try { const t = (process.env.GITHUB_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '')); if (t) H.Authorization = `Bearer ${t}`; } catch {}
const PROXY = 'https://gh-proxy.com/';
// 2026-11-05：没 token 时额度只有 60 次/小时，加 30 分钟缓存，重复跑不重复烧
// --fresh 可不看缓存强制刷新
const CACHE_FILE = path.join(HOME, '.dsh', 'pbyugujia', 'out', 'watch-cache.json');
const CACHE_TTL = 30 * 60 * 1000;

function load() {
  if (!fs.existsSync(FILE)) return { updated: '', watched: {} };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(d) {
  d.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
}

async function info(repo) {
  const url = `https://api.github.com/repos/${repo}`;
  const forceProxy = !!process.env.GH_FORCE_PROXY;
  let channel = forceProxy ? 'proxy' : 'direct';
  let r;
  try {
    r = forceProxy ? null : await fetch(url, { headers: H, signal: AbortSignal.timeout(15000) });
  } catch { r = null; }
  if (!r || !r.ok) {
    // 直连失败再走代理：403/429（限流）、超时、5xx 都试一次
    try {
      const r2 = await fetch(PROXY + url, { headers: H, signal: AbortSignal.timeout(25000) });
      if (r2.ok) { r = r2; channel = 'proxy'; }
    } catch { /* 代理也挂就按原错返回 */ }
  }
  if (!r) return { error: 'timeout' };
  if (!r.ok) return { error: r.status, channel };
  const j = await r.json();
  return { stars: j.stargazers_count, pushed: j.pushed_at, issues: j.open_issues_count, desc: j.description, channel };
}

function days(iso) {
  if (!iso) return '?';
  return Math.floor((Date.now() - Date.parse(iso)) / 86400000);
}

const args = process.argv.slice(2);
const d = load();

if (args[0] === '--list') {
  for (const [repo, v] of Object.entries(d.watched)) console.log(`${repo}  ★${v.seen?.stars ?? '?'}  ${v.why || ''}`);
  process.exit(0);
}

if (args[0] === '--add') {
  const repo = args[1];
  if (!repo) { console.log('要给 owner/repo'); process.exit(1); }
  d.watched[repo] = d.watched[repo] || { seen: {}, why: args[2] || '' };
  save(d);
  console.log(`已加入：${repo}`);
  process.exit(0);
}

const showAll = args.includes('--all');
let changed = 0;
const lines = [];
let proxyCount = 0, cacheCount = 0;
let cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } })();

// 2026-11-05 加：形状校验。watched 必须是对象（repo → {seen,why}）。
// 之前一次脚本把它按数组过滤，结果 Object.entries 拿到的键是 "0"、"1"，
// 全项目被当成 404，看起来像「全都删库了」——静默降级最费时间。
if (!d || typeof d.watched !== 'object' || Array.isArray(d.watched)) {
  console.error('✗ watchlist.json 的 watched 应该是对象（repo → {seen,why}），现在不是。');
  console.error('  多半是被按列表处理的脚本改坏了；从备份还原：cp watchlist.json.bak-* watchlist.json');
  process.exit(1);
}
for (const [repo, v] of Object.entries(d.watched)) {
  await new Promise((r) => setTimeout(r, 200));   // 2026-11-05：连发太密会被限流/代理超时，留 200ms 间隔
  let cur = cache[repo];
  let fromCache = false;
  if (!process.argv.includes('--fresh') && cur && Date.now() - (cur._at || 0) < CACHE_TTL) {
    fromCache = true;
  } else {
    cur = await info(repo);
    if (!cur.error) { cur._at = Date.now(); cache[repo] = cur; fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
  }
  if (cur.error) {
    // 2026-11-05 修：403 是限流，不是删库。原来一律报「可能删库」，会让人白担心、也看不出是采集问题。
    if (cur.error === 403) {
      lines.push(`⚠ ${repo}  —— 被 GitHub 限流（403），**不是删库**；等一小时再跑，或配 token`);
    } else if (cur.error === 404) {
      lines.push(`✗ ${repo}  —— 404，确实查不到：删库或转私有`);
      changed++;
    } else {
      lines.push(`⚠ ${repo}  —— 请求失败（HTTP ${cur.error}），本轮没拿到数据，别当结论`);
    }
    continue;
  }
  const old = v.seen || {};
  const dStars = (cur.stars || 0) - (old.stars || 0);
  const newPush = cur.pushed && cur.pushed !== old.pushed;
  const has = dStars !== 0 || newPush || !old.pushed;
  if (has) changed++;
  if (!has && !showAll) continue;

  if (cur.channel === 'proxy') proxyCount += 1;
  if (fromCache) cacheCount += 1;
  const flag = has ? '● 有变化' : '○ 没变';
  const starTxt = dStars === 0 ? `★${cur.stars}` : `★${cur.stars} (${dStars > 0 ? '+' : ''}${dStars})`;
  lines.push(`${flag}  ${repo}  ${starTxt}  最近提交 ${days(cur.pushed)} 天前${newPush ? ' ← 新' : ''}${cur.issues ? `  开着的 issue ${cur.issues}` : ''}`);
  if (v.why) lines.push(`     关注点：${v.why}`);

  v.seen = { stars: cur.stars, pushed: cur.pushed };
}

save(d);

if (!lines.length) {
  console.log('都跟上次一样，没有进展。');
} else {
  console.log(`关注 ${Object.keys(d.watched).length} 个，有变化 ${changed} 个${proxyCount ? `（其中 ${proxyCount} 条走 gh-proxy）` : ''}${cacheCount ? `（${cacheCount} 条命中 30 分钟缓存）` : ''}：\n`);
  console.log(lines.join('\n'));
}
