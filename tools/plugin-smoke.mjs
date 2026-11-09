#!/usr/bin/env node
/**
 * plugin-smoke.mjs —— 我们自己的插件冒烟测试。
 *
 * ## 借自哪
 * GoDSH（github.com/Mark930209/GoDSH）的 `scripts/validate-plugins.mjs` 思路：
 * 插件在发布前必须先过一道「装得上、起得来」的检查。我们用它的纪律，不搬它的基建。
 *
 * ## 它能防什么
 * **引擎起不来那一类**。cordis 里一个插件在 `apply()` 阶段抛异常，会被判 failed；
 * 真机上出现过「一个可选工具插件把整个 App 启动搞垮 54 次」（见 dsh-android-bubble 注释）。
 * 这类事故只要在本地跑一次 apply 就能拦下。
 *
 * ## 它防不了什么
 * 运行期才暴露的问题。2026-11-06 的 tool-mask 就是例子：`apply()` 一切正常，
 * 直到 `agent/created` 里调 `tools.restrict()` 才抛——冒烟测试测不出来。
 * 那个要靠「真跑一次 + 落状态文件」来验，别指望这里。
 *
 * 用法：node tools/plugin-smoke.mjs
 * 退出码：0 全过；1 有插件没通过。
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const ROOT = join(HOME, 'pbyugujia', 'plugins');

/** 假 ctx：插件碰什么就给什么，碰不到的返回一个万能 no-op（照 measure-schema 的做法）。 */
function fakeCtx() {
	const noop = () => {};
	const logger = { info: noop, warn: noop, error: noop, debug: noop };
	const tools = {
		register: noop,
		get: () => undefined,
		schemas: () => [],
		restrict: () => noop,
		guard: () => noop,
	};
	const base = { tools, logger, on: noop, effect: (fn) => { try { fn && fn(); } catch { /* ignore */ } }, inject: [], systemPrompt: {} };
	return new Proxy(base, {
		get(t, k) {
			if (k in t) return t[k];
			return new Proxy(noop, { get: () => () => undefined, apply: () => undefined });
		},
	});
}

if (!existsSync(ROOT)) {
	console.log(`没有插件目录：${ROOT}`);
	process.exit(0);
}

const dirs = readdirSync(ROOT).filter((n) => {
	try { return statSync(join(ROOT, n)).isDirectory(); } catch { return false; }
});

if (dirs.length === 0) {
	console.log('plugins/ 下没有插件，跳过');
	process.exit(0);
}

let bad = 0;
console.log(`=== 插件冒烟测试（${dirs.length} 个）===`);
for (const d of dirs) {
	const entry = join(ROOT, d, 'index.js');
	if (!existsSync(entry)) {
		console.log(`  ⚠ ${d}：没有 index.js，跳过`);
		continue;
	}
	try {
		const mod = await import(pathToFileURL(entry).href);
		if (typeof mod.apply !== 'function') {
			console.log(`  ⚠ ${d}：没有导出 apply()，跳过`);
			continue;
		}
		await mod.apply(fakeCtx(), {});
		console.log(`  ✅ ${d}：import + apply 正常`);
	} catch (error) {
		bad++;
		console.log(`  ❌ ${d}：${error?.message ?? error}`);
	}
}

console.log(bad === 0 ? '全过。注意：这只证明「起得来」，不证明「跑得对」。' : `有 ${bad} 个插件没过。`);
process.exit(bad === 0 ? 0 : 1);
