#!/usr/bin/env node
/** market-test.mjs —— 装插件前先核：这个包在我们的宿主版上跑不跑得起来。
 *
 * 2026-11-12 建。由来：dshmarket.com 的 /tested/ 每天把热门插件逐个装一遍（数据在
 * dsh-market 仓库 site/install-tests.json），我们踩过 dsh-ops 那种「装了就废」的坑，
 * 但那页要开浏览器翻。这个工具把那 31KB 数据拉下来，按宿主版本回答一句。
 *
 * 用法：
 *   node tools/market-test.mjs <npm包名>          # 查一个包
 *   node tools/market-test.mjs --all              # 列非 live 的
 *   node tools/market-test.mjs --host 0.2.1-rc.2  # 指定宿主版
 *   node tools/market-test.mjs --update           # 强制刷新缓存
 *
 * 数据：out/tmp/install-tests.json，12 小时内复用；原站路径（raw.githubusercontent）
 * 在本机 TLS 不通，所以走 api.github.com 的 raw accept，别改回去。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pbyugujia');
const CACHE = join(DIR, 'out/tmp/install-tests.json');
const API = 'https://api.github.com/repos/dsh-market/dsh-market/contents/site/install-tests.json';
const TTL = 12 * 3600 * 1000;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

async function update() {
  const r = await fetch(API, { headers: { Accept: 'application/vnd.github.raw' } });
  if (!r.ok) throw new Error(`拉数据失败 HTTP ${r.status}`);
  const text = await r.text();
  writeFileSync(CACHE, text);
  return JSON.parse(text);
}

let data;
if (!has('--update') && existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < TTL) {
  data = JSON.parse(readFileSync(CACHE, 'utf8'));
} else {
  data = await update();
}

// 宿主版：显式指定 > 数据里最新的那个（market 只为它已知的两版测过）
const hosts = Object.keys(data.hosts || {});
const cmp = (a, b) => String(b).localeCompare(String(a), undefined, { numeric: true });
const host = val('--host') || hosts.sort(cmp)[0];
const items = data.hosts?.[host];
if (!items) {
  console.error(`数据里没有宿主 ${host}；可选：${hosts.join(' / ')}`);
  process.exit(2);
}

const fmt = (x) => {
  const bits = [`${x.kind}`, `${x.version}`];
  if (x.sizeKB) bits.push(`${Math.round(x.sizeKB / 1024 * 10) / 10}MB`);
  if (x.secs) bits.push(`${x.secs}s`);
  if (x.requires) bits.push(`宿主需 ${String(x.requires).slice(0, 40)}`);
  return bits.join(' · ');
};

if (has('--all')) {
  console.log(`宿主 ${host} · 测于 ${data.testedAt} · ${items.length} 个`);
  for (const x of items.filter((y) => y.kind !== 'live')) console.log(`  ${x.npm.padEnd(40)} ${fmt(x)}`);
  process.exit(0);
}

const name = argv.find((a) => !a.startsWith('-') && a !== val('--host'));
if (!name) {
  console.error('用法：node tools/market-test.mjs <npm包名> | --all | --update | --host <版本>');
  process.exit(2);
}

const hit = items.find((x) => x.npm === name);
if (!hit) {
  console.log(`没测过：${name}（宿主 ${host}，测于 ${data.testedAt}）——不是坏，是榜上没它，装前自己裸装核一次`);
  process.exit(1);
}
const verdict = hit.kind === 'live' ? '能跑' : hit.kind === 'builds' ? '要构建，可能装不上' : hit.kind === 'restart' ? '装完要重启才生效' : hit.kind === 'host' ? '宿主版本不匹配' : '装得上但报错';
console.log(`${hit.npm} → ${verdict}（${fmt(hit)}；宿主 ${host}，测于 ${data.testedAt}）`);
