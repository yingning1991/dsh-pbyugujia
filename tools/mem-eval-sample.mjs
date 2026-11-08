#!/usr/bin/env node
/**
 * mem-eval-sample.mjs —— 记忆自测的**模板**（不含任何私人数据，也不需要额外文件就能跑）。
 *
 * ## 为什么给模板而不是成品
 * 这套自测的题目必须从**你自己的记忆库**里出，抄别人的题没有意义（期望的 id 对不上）。
 * 所以这里只给结构和判法，题目和检索接口由你自己接。
 *
 * ## 怎么用
 * 1. 挑 10 条你希望「该想起就该想起」的条目，记下 id。
 * 2. 每条写两版问法：**人话**（你平时会怎么问）和**具体词**（换成检索能命中的词）。
 * 3. 设一个检索命令，能接受一句话、输出命中的 id（一行一个）：
 *      RECALL_CMD='node tools/chat.mjs query'  node tools/mem-eval-sample.mjs
 *    不设也行——脚本会打印说明后正常退出，不会报错。
 *
 * ## 判法
 * - 期望那条在前 1 = hit@1，在前 3 = hit@3。
 * - **两版都要跑**：人话问得到才算本事；人话掉、具体词好，说明瓶颈在**提问**，不在库大小。
 *
 * ## 我们自己的基线（2026-11-06，仅供参考，不是标准）
 * 人话：hit@1 3/10、hit@3 4/10；具体词：hit@1 8/10、hit@3 10/10。
 * 结论：瓶颈在提问。**别拿这个数字跟论文比**，只跟你自己下一次比。
 */
import { execFileSync } from 'node:child_process';

// [人话问法, 具体词问法, 期望的条目 id]
// ↓ 换成你自己的题目；下面这三条是占位，会原样跑一遍当作演示。
const CASES = [
	['（你平时会怎么问）', '（换成检索能命中的词）', 'note-id-1'],
	['（第二题）', '（第二题的具体词）', 'note-id-2'],
];

const RECALL_CMD = process.env.RECALL_CMD || '';

if (!RECALL_CMD) {
	console.log('这是模板：还没接检索。');
	console.log('');
	console.log('1) 把本文件的 CASES 换成你自己的题目（问法 + 期望 id）；');
	console.log("2) 跑：RECALL_CMD='node tools/chat.mjs query' node tools/mem-eval-sample.mjs");
	console.log('');
	console.log('RECALL_CMD 的约定：接一个问句参数，输出的每一行是一个命中条目的 id（按相关度降序）。');
	process.exit(0);
}

/** 调你的检索，返回前 topK 条 id。 */
function recall(query, topK = 3) {
	const out = execFileSync('sh', ['-c', `${RECALL_CMD} "$1"`, 'sh', query], { encoding: 'utf8' });
	// 只取每行第一个词：很多检索 CLI 会输出 `id 标题`，严格整行比对会全判错。
	return out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).slice(0, topK);
}

let h1 = 0, h3 = 0;
const misses = [];

for (const [spoken, keywords, want] of CASES) {
	const got = recall(spoken);
	const at = got.indexOf(want);
	if (at === 0) h1++;
	if (at >= 0 && at < 3) h3++;
	else misses.push(`【人话没中】${spoken} ｜想 ${want} ｜得 ${got.slice(0, 3).join(', ') || '(空)'}`);
}

const n = CASES.length;
console.log(`人话问：hit@1 ${h1}/${n}  hit@3 ${h3}/${n}`);
if (misses.length) {
	console.log('\n没中：');
	for (const m of misses) console.log('  ' + m);
}
