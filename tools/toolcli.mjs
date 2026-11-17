#!/usr/bin/env node
/**
 * toolcli.mjs —— 把「只给模型看的大 schema 工具」改成按需 CLI。
 *
 * ## 为什么有它
 * bubble / statusbar / ui 三个插件每个都带几千到一万 token 的 schema，
 * 每轮都随前缀重读，而实际调用极少。更好的做法不是删能力，是
 * **把工具从常驻 schema 里挪出去，要用时用 CLI 调**（notes/2026-11-03 的正解）。
 *
 * ## 怎么做
 * 不重写校验逻辑：直接 import 插件、用假 ctx 捕获它注册的工具定义，
 * 调它自己的 `execute(args)`。插件怎么改，这里就跟着怎么变，不会走样。
 *
 * 用法：
 *   node tools/toolcli.mjs bubble '{"action":"get"}'
 *   node tools/toolcli.mjs statusbar '{"action":"get"}'
 *   node tools/toolcli.mjs ui '{"action":"info"}'
 *   node tools/toolcli.mjs --list
 *
 * 退出码：0 成功；1 工具报 ok:false；2 用法/环境错误。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIRS = join(HOME, '');

const PLUGINS = {
	bubble: join(HOME, 'bubble-tool/dsh-android-bubble/lib/index.js'),
	statusbar: join(HOME, 'statusbar-tool/dsh-android-statusbar/lib/index.js'),
	ui: join(HOME, 'uiagent-tool/dsh-android-uiagent/lib/index.js'),
	browser: join(HOME, 'browser-tool/dsh-android-browser/lib/index.js'),
};

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
	console.log('用法: node tools/toolcli.mjs <bubble|statusbar|ui|browser> \'<json args>\'');
	console.log('      node tools/toolcli.mjs --list');
	process.exit(argv.length === 0 ? 2 : 0);
}
if (argv[0] === '--list') {
	for (const [k, v] of Object.entries(PLUGINS)) console.log(`${k}\t${v}`);
	process.exit(0);
}

const name = argv[0];
const pluginPath = PLUGINS[name];
if (!pluginPath) {
	console.error(`未知工具: ${name}（可选 ${Object.keys(PLUGINS).join(' / ')}）`);
	process.exit(2);
}

let args = {};
if (argv[1] !== undefined && argv[1] !== '') {
	try { args = JSON.parse(argv[1]); } catch (e) {
		console.error(`参数不是合法 JSON: ${e.message}`);
		process.exit(2);
	}
}

/** 假 ctx：只提供插件真正会碰的两样东西（tools.register 与 logger）。 */
function fakeCtx(bucket) {
	const noop = () => {};
	const logger = { info: noop, warn: noop, error: noop, debug: noop };
	const tools = {
		register(def) { bucket.push(def); },
		get: () => undefined,
		restrict: () => noop,
		guard: () => noop,
	};
	return new Proxy({ tools, logger, on: noop, effect: (fn) => { try { fn && fn(); } catch { /* ignore */ } }, inject: [] }, {
		get(t, k) {
			if (k in t) return t[k];
			return new Proxy(noop, { get: () => () => undefined, apply: () => undefined });
		},
	});
}

let mod;
try {
	mod = await import('file://' + pluginPath);
} catch (e) {
	console.error(`导入插件失败: ${e.message}`);
	process.exit(2);
}

const bucket = [];
try {
	await mod.apply(fakeCtx(bucket));
} catch (e) {
	console.error(`插件 apply 抛错: ${e.message}`);
	process.exit(2);
}

if (!bucket.length) {
	console.error('插件没有注册任何工具（前置条件不满足？检查 DSH_HOME）');
	process.exit(2);
}

const def = bucket.find((d) => d.name === name) || bucket[0];
if (typeof def.execute !== 'function') {
	console.error(`工具 ${def.name} 没有 execute`);
	process.exit(2);
}

let result;
try {
	result = await def.execute(args);
} catch (e) {
	console.error(`执行抛错: ${e.message}`);
	process.exit(1);
}

const ok = result && result.ok === true;
const lines = [];
if (ok) lines.push('结果: 成功');
else lines.push('结果: 失败');
if (result && result.appearance) lines.push(`当前外观: ${result.appearance}`);
if (result && result.message) lines.push(result.message);
// 有些工具（ui/browser）把正文放在 content/其他字段里，原样兜底输出。
if (result && !result.message) lines.push(JSON.stringify(result).slice(0, 4000));
console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);
