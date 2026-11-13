#!/usr/bin/env node
/**
 * deliver.mjs —— 片子交付到相册的唯一入口（2026-11-09 建）
 *
 * 为什么要有它：同一件事栽过三次（11-04、11-08 两次、11-09 初稿）。三次都不是不知道，
 * 是「规矩挂在 tasks/22 里，临时加活不走那个任务，规矩没被加载」。
 * 所以：拷贝归这个脚本；扫描与核验必须走 `shell`（应用身份跑 am 会抛 InvocationTargetException），
 * 脚本把该跑的两条命令直接打出来，复制粘贴即可，不再靠回忆。
 *
 * 用法：
 *   node tools/deliver.mjs <本地文件> [--name 文件名]   # 视频、封面都走它（统一放 Movies/大肥鱼，才扫得到）
 *
 * 输出：拷贝到 /sdcard/Movies/大肥鱼/，打印 scan + verify 两条命令。
 * 验收（主理人 11-08 定）：content query 里能看到 duration 才算进相册。
 */
import { copyFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const ALBUM = '/sdcard/Movies/大肥鱼';
const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const ni = args.indexOf('--name');
const name = ni >= 0 ? args[ni + 1] : basename(src || '');

if (!src) {
  console.log('用法：node tools/deliver.mjs <本地文件> [--name 文件名]（视频、封面都行）');
  process.exit(2);
}
if (!existsSync(src)) {
  console.log('✗ 源文件不存在：', src);
  process.exit(1);
}
mkdirSync(ALBUM, { recursive: true });
const dst = join(ALBUM, name);
copyFileSync(src, dst);

const mb = (statSync(dst).size / 1048576).toFixed(2);
console.log(`✓ 已拷进相册目录：${dst}（${mb} MB）`);
console.log('');
console.log('还没交付完——应用身份扫不了媒体库，下面两条必须在 shell 里跑：');
console.log('');
console.log(`  am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${dst}"`);
console.log(`  content query --uri content://media/external/video/media --projection _display_name:duration:_data --where "_display_name LIKE '%${name.replace(/'/g, '')}%'"`);
console.log('');
console.log('看到 duration（毫秒）才算进相册；看到了再跟他说「已进相册」，看不到就换名/换目录再扫。');
