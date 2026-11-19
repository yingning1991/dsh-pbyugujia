#!/usr/bin/env node
/**
 * drawer-check.mjs —— 归类抽屉体检：根目录有没有散放的文件、抽屉在不在
 *
 * 用法：
 *   node tools/drawer-check.mjs            # 列出散文件与缺失抽屉
 *   node tools/drawer-check.mjs --line     # 一行，给每日复盘
 *
 * 判据（来自 notes/抽屉总目录.md「落地即归位」）：
 * - 根目录只许放「系统文件与门牌」：CORE/AGENTS/SOUL/US/INDEX 这类，
 *   备份（*.bak-*、*.pre-*、*.rollback-*）、数据库与账号态、任务导出、运行时状态。
 * - 其余文件一律进抽屉（notes/ learnings/ growth/ journal/ diary/ kb/ tasks/ tools/ out/ ...）。
 * - 抽屉总目录本身不能丢；新抽屉先在它那儿留名。
 *
 * 退出码：0 干净；1 有散文件或缺抽屉（当场归位或写进 journal 说明）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const DF = join(HOME, 'pbyugujia');
const LINE = process.argv.includes('--line');

const EXPECT = ['notes', 'journal', 'diary', 'growth', 'learnings', 'tasks', 'tools', 'out'];
const SYSTEM = /^(CORE|AGENTS|SOUL|US|ME|ARCH|INDEX|TOOLS|PLAYBOOK|PITFALLS|READING|MIGRATE|NEED_YOU|AUTONOMY|CHANGELOG-local|package|思考习惯|skill|README)/;
const PATTERNS = [
  /\.bak-/, /\.pre-/, /\.rollback-/, /^memory\.db/, /^bili-cookie\.json/,
  /^watchlist\.json/, /^jobs\.(json|md)$/, /^mood\.(json|md)$/, /^thread\.md$/, /\.db$/, /^list\d*\.txt$/,
  /^\.repo-manifest\.json$/, /^\.sync-private$/, /\.tgz$/, /^log$/, /^logs?$/, /^\.git/,
];

function isSystem(name) {
  if (SYSTEM.test(name)) return true;
  if (PATTERNS.some((r) => r.test(name))) return true;
  return false;
}

if (!existsSync(DF)) {
  console.error(`找不到工作台：${DF}`);
  process.exit(1);
}

const entries = readdirSync(DF).filter((n) => !n.startsWith('.'));
const stray = [];
for (const name of entries) {
  const p = join(DF, name);
  let st;
  try { st = statSync(p); } catch { continue; }
  if (st.isFile() && !isSystem(name)) stray.push(name);
}

const missing = EXPECT.filter((d) => !existsSync(join(DF, d)));
const hasRegistry = existsSync(join(DF, 'notes', '抽屉总目录.md'));

if (LINE) {
  const bits = [`散文件 ${stray.length} 个`];
  if (stray.length) bits.push(stray.slice(0, 5).join('、') + (stray.length > 5 ? ' …' : ''));
  bits.push(`缺抽屉 ${missing.length ? missing.join('、') : '0'}`);
  bits.push(`总目录 ${hasRegistry ? '在' : '丢了'}`);
  console.log(`抽屉体检｜${bits.join('｜')}`);
  process.exit(stray.length || missing.length || !hasRegistry ? 1 : 0);
}

if (!stray.length && !missing.length && hasRegistry) {
  console.log('抽屉体检：干净（根目录无散文件，抽屉齐，总目录在）');
  process.exit(0);
}
if (stray.length) {
  console.log(`散文件 ${stray.length} 个（根目录只许系统文件与门牌）：`);
  for (const n of stray) console.log(`  · ${n}`);
}
if (missing.length) console.log(`缺抽屉：${missing.join('、')}`);
if (!hasRegistry) console.log('丢门牌：notes/抽屉总目录.md 不在');
process.exit(1);
