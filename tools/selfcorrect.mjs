#!/usr/bin/env node
/** selfcorrect.mjs —— 系统级自纠一页纸（2026-11-10 落地，来自 B站 BV1msWM6hEzB）
 *
 * 为什么有它：片子里那句是现象——「AI 有自我反思的能力，但不会主动触发」。
 * 我们的审计器已经有六个（claim / discipline / memory-lint / fail-extract …），
 * 但全挂在我「想起来才跑」上。缺的不是工具，是一个每天必跑、跑完逼我答三问的入口。
 *
 * 补的第二个缺口是「影子对比」：一周前写进库的东西，这周还在不在、被我自己的新说法推翻了几条。
 * 这正是片子里说的「时间周期验证」——单条记得对不对看不出来，一周前后一对比才看得出来。
 *
 * 用法：
 *   node tools/selfcorrect.mjs         # 一页纸
 *   node tools/selfcorrect.mjs --line  # 一行（22:00 复盘用）
 *   node tools/selfcorrect.mjs --json  # 机读
 *
 * 只读，不改库。要改，我自己改。
 */
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), '.dsh', 'pbyugujia');
const DB = join(DIR, 'memory.db');
const now = new Date();
const iso = (d) => d.toISOString();
const d7 = iso(new Date(now - 7 * 864e5));
const d14 = iso(new Date(now - 14 * 864e5));
const today = now.toISOString().slice(0, 10);

// ── 1. 审计器现状（有就报，跑挂就写「没跑成」，不静默降级）──
const audits = [];
// 退出码 1 是这些审计器的正常信号（「有失效」也算跑成了），所以 stdout 要照样吃
const run = (label, cmd) => {
  let out = '', code = 0;
  try {
    out = execSync(cmd, { cwd: DIR, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout || '';
    code = typeof e.status === 'number' ? e.status : 1;
    if (!out.trim()) audits.push({ label, ok: false, code, line: `没跑成（${(e.message || '').split('\n')[0].slice(0, 60)}）` });
  }
  if (!out.trim()) return;
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[stderr]') && !l.startsWith('（判据'));
  audits.push({ label, ok: !/没跑成|not found/.test(lines.join(' ')), code, line: lines.slice(0, 3).join('｜') });
};
run('完成声称', `node tools/claim-audit.mjs 1 --line`);
run('纪律', `node tools/discipline-audit.mjs 1 --line`);
run('记忆路径', `node tools/memory-lint.mjs --line`);

// ── 2. 影子对比：本周 / 上周 / 更早 ──
const db = new DatabaseSync(DB, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).get(...p);
const count = (a, b) => q(`select count(*) c from notes where created >= ? and created < ?`, a, b).c;

const weekNew = count(d7, '9999');
const prevNew = count(d14, d7);
const older = q(`select count(*) c from notes where created < ?`, d14).c;

const weekSuperseded = q(`select count(*) c from notes where created >= ? and superseded_by != ''`, d7).c;
const changedOld = q(`select count(*) c from notes where created < ? and updated >= ?`, d7, d7).c;
const expiredNotRetired = q(`select count(*) c from notes where valid_to != '' and valid_to < ? and superseded_by = ''`, today).c;
const weekScene = q(`select count(*) c from notes where created >= ? and kind='scene'`, d7).c;
const weekImp5 = q(`select count(*) c from notes where created >= ? and importance = 5`, d7).c;
const weekNoSrc = q(`select count(*) c from notes where created >= ? and kind='scene' and source_ids=''`, d7).c;

// ── 3. 三问的候选：本周 importance 最高的一条 ──
const cand = q(`select id, title, importance, created from notes
  where created >= ? and superseded_by = '' order by importance desc, created desc limit 1`, d7);

db.close();

const ratio = weekNew ? weekSuperseded / weekNew : 0;
const flags = [];
if (weekNew < 3) flags.push('这周记得少（<3 条）');
if (ratio > 0.3) flags.push(`自己推翻自己 ${(ratio * 100).toFixed(0)}%（>30% 算冒进）`);
if (expiredNotRetired > 0) flags.push(`失效未退役 ${expiredNotRetired} 条`);
if (weekNoSrc > 0) flags.push(`scene 缺 source_ids ${weekNoSrc} 条`);
// 审计器自己的红字也算触发，别只当一行装饰印出来
for (const a of audits) {
  if (/失效 [1-9]/.test(a.line)) flags.push('记忆路径有失效，当天改那条');
  if (/前台 sleep ≥5s：[1-9]/.test(a.line)) flags.push('前台 sleep ≥5s，该转后台');
  if (/慢命令[^0-9]*[1-9]/.test(a.line)) flags.push('已知慢命令跑在前台，该 run_in_background');
  if (/有据 (\d+)[^0-9]/.test(a.line)) {
    const m = a.line.match(/完成声称 (\d+) 条：有据 (\d+)/);
    if (m && +m[1] > +m[2]) flags.push(`完成声称缺据 ${+m[1] - +m[2]} 条`);
  }
}

const result = {
  date: today,
  audits,
  shadow: { weekNew, prevNew, older, weekSuperseded, changedOld, expiredNotRetired, weekScene, weekImp5, weekNoSrc, ratio: +ratio.toFixed(3) },
  flags,
  candidate: cand ? { id: cand.id, title: cand.title, importance: cand.importance } : null,
};

if (process.argv.includes('--challenge')) {
  // 外部视角闸：不自己评自己。打印一段可直接丢给 subagent 的题面，成本只在真用时发生。
  const i = process.argv.indexOf('--challenge');
  const target = process.argv[i + 1];
  if (!target) {
    console.log('用法：node tools/selfcorrect.mjs --challenge <文件或目录>');
    process.exit(2);
  }
  console.log(`只读 ${target}，做一件事：找「哪里没做到」。`);
  console.log('规矩：不许夸、不许总结全文、不许建议「可以更好」这类空话；每一条必须给证据——文件行号或原文片段。');
  console.log('按这个顺序查，查不到的项直接写「没问题」：');
  console.log('1. 声称 vs 实物：文件里说做完了的，真的在吗？跑过吗？路径/命令对不对？');
  console.log('2. 漏掉的同类：同一批里有没有该改没改的（同目录、同模式、同一句旧说法还留着）？');
  console.log('3. 会变的事：版本/成本/接口这类，是不是拿印象写的、没对过事实？');
  console.log('4. 触发条件：规矩有没有写成无条件的？有没有在它不该生效的场景里生效？');
  console.log('5. 七维（借 Self Reflection skill，改成「哪里没做到」，**不许打分**——自己给自己打 7/10 就是过度自信）：');
  console.log('   正确性=解的是不是那个问题；完整性=边界和假设说了没；清楚=陌生人一眼看懂吗；');
  console.log('   稳健=什么能让它崩；效率=有没有多余复杂度；对得上=是不是他真想要的；署名=换成陌生名字敢不敢签。');
  console.log('6. 可证伪：每条结论能不能说出「什么能驳倒它」？说不出就是还没判断。');
  console.log('输出：一张表「问题 / 证据（行号或原文）/ 严重度 高·中·低」，最后一行只写「共 N 条，其中高 M 条」。');
  process.exit(0);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (process.argv.includes('--line')) {
  const a = audits.map((x) => `${x.label}:${x.ok ? '✓' : '✗'}`).join(' ');
  console.log(`自纠｜${a}｜本周新记 ${weekNew}（自推翻 ${weekSuperseded}）｜上周 ${prevNew}｜改旧条 ${changedOld}｜失效未退役 ${expiredNotRetired}｜${flags.length ? flags.join('；') : '无异常'}`);
} else {
  console.log(`# 系统级自纠 · ${today}\n`);
  console.log('## 一、审计器（每天必跑，不靠我想起来）');
  for (const a of audits) console.log(`- ${a.ok ? '✅' : '❌'} ${a.label}：${a.line}`);
  console.log('\n## 二、影子对比（一周前 vs 现在）');
  console.log(`- 本周新记 ${weekNew} 条；上周同期 ${prevNew} 条；更早 ${older} 条`);
  console.log(`- 本周新记里被自己推翻 ${weekSuperseded} 条${ratio > 0.3 ? '  ⚠️ 冒进' : ''}`);
  console.log(`- 这周回头改的旧条 ${changedOld} 条`);
  console.log(`- 失效未退役 ${expiredNotRetired} 条${expiredNotRetired ? '  ⚠️ 该挂新说法了' : ''}`);
  console.log(`- 本周 scene ${weekScene} 条（缺 source_ids ${weekNoSrc}）；importance=5 的 ${weekImp5} 条`);
  console.log(`\n## 三、三问（对着这一条答，答不出就改条目）`);
  if (cand) {
    console.log(`候选：${cand.id}「${cand.title}」（importance ${cand.importance}）\n`);
    console.log('1. 它现在还成立吗？哪条事实撑着它？');
    console.log('2. 什么时候它会不成立？第三行填得出来吗？');
    console.log('3. 下次遇到同类事，我会不会真调它出来？');
  } else {
    console.log('本周没有新条目，跳过（别为答而编）。');
  }
  if (flags.length) console.log(`\n## 触发（有就今天处理）\n- ${flags.join('\n- ')}`);
}
