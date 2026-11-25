#!/usr/bin/env node
// tavily.mjs —— Tavily 搜索/正文提取（2026-11-25 用户注册，免费档 1000 credits/月）
//
// 用途：补 web_search 的缺口——web_search 只回标题+链接，正文经常读不到；
// Tavily 直接回带正文 content 的结果块，省一轮 web_fetch。
//
// 用法：
//   node tools/tavily.mjs "查询"                 # 默认 5 条，正文各截 400 字
//   node tools/tavily.mjs "查询" --max 8         # 条数
//   node tools/tavily.mjs "查询" --answer        # 带 Tavily 生成的直接答案
//   node tools/tavily.mjs "查询" --depth advanced # 更深的检索（耗 2 credits/次）
//   node tools/tavily.mjs "查询" --json          # 原始 JSON
//   node tools/tavily.mjs --extract <url>        # 抓指定页面正文
//
// key：环境变量 TAVILY_API_KEY，或项目根 .tavily-key（600，不进仓库）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--extract' || argv[i - 1] === '--max' || argv[i - 1] === '--depth'));

const keyFile = path.join(ROOT, '.tavily-key');
const key = process.env.TAVILY_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
if (!key) {
  console.error('没有 key：设 TAVILY_API_KEY 或写 .tavily-key');
  process.exit(2);
}

async function post(endpoint, body) {
  const r = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Tavily ${endpoint} HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const extractUrl = val('extract');
const max = Number(val('max', '5')) || 5;
const depth = val('depth', 'basic');
const json = has('json');

try {
  if (extractUrl) {
    const j = await post('extract', { urls: [extractUrl] });
    for (const r of j.results || []) {
      console.log(`URL: ${r.url}`);
      console.log(r.raw_content || r.content || '(空)');
    }
    if (!json && j.failed_results?.length) console.log('\n失败:', JSON.stringify(j.failed_results));
  } else {
    const q = words[0] || '';
    if (!q) { console.error('要一个查询词，例如：node tools/tavily.mjs "Tavily API 文档"'); process.exit(2); }
    const j = await post('search', {
      query: q,
      max_results: max,
      search_depth: depth,
      include_answer: has('answer'),
    });
    if (json) { console.log(JSON.stringify(j, null, 2)); process.exit(0); }
    if (j.answer) console.log(`答案：${j.answer}\n`);
    (j.results || []).forEach((r, k) => {
      const body = (r.content || r.raw_content || '').replace(/\s+/g, ' ').trim();
      console.log(`[${k + 1}] ${r.title || '(无标题)'}`);
      console.log(`    ${r.url}`);
      console.log(`    ${body.slice(0, 400)}${body.length > 400 ? '…' : ''}`);
      console.log('');
    });
    console.log(`(${j.results?.length || 0} 条 · Tavily · ${depth})`);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
