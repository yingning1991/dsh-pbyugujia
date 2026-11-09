#!/usr/bin/env node
/** guidance.mjs —— 引导状态机：让「看见 → 给坡 → 验证 → 传播」变成骨架每轮真的在跑的东西
 *
 * 用法（默认状态在 ./.guidance/state.json）：
 *   node tools/guidance.mjs phase                 # 当前处在哪一步，下一句该怎么走
 *   node tools/guidance.mjs see "他很累，还在硬撑"  # 记一次「看见」，进入给坡
 *   node tools/guidance.mjs step "明天先只做十分钟" --due 3d
 *   node tools/guidance.mjs due                   # 列出到期/逾期的步，先回看再往下走
 *   node tools/guidance.mjs done s2 --note "做到了，但只坚持两天"
 *   node tools/guidance.mjs audit draft.md        # 发对外文案前查措辞，命中红线退出码 1
 *   node tools/guidance.mjs status                # 一行摘要
 *
 * 三条硬规矩（写死在代码里，不靠临场记）：
 *   1. 一次只开一步：已有未完成步骤时，step 默认拒绝（要强推加 --force）。
 *   2. 到点必须回看：due 不为空时，先 done 或改期，才允许开新步。
 *   3. 没走完验证不进入传播：phase 到 spread 之前，audit 对外文案会给出提示。
 *
 * 状态文件位置：GUIDANCE_STATE 环境变量，或 ./.guidance/state.json
 * 退出码：0 正常；1 audit 命中红线 / 有逾期未回看。
 */
import fs from 'node:fs';
import path from 'node:path';

const STATE = process.env.GUIDANCE_STATE || path.join(process.cwd(), '.guidance', 'state.json');
const PHASES = ['see', 'step', 'verify', 'spread'];
const PHASE_CN = { see: '看见', step: '给坡', verify: '验证', spread: '传播' };
const PHASE_HINT = {
  see: '先描述他现在的样子，不评价、不诊断。看完记一次 see。',
  step: '只给下一步，一次一步。给完记 step，并定一个复查日期。',
  verify: '到点先回看事实：变了没有、哪里没变。别急着开新步。',
  spread: '他站稳了，才可以讲理念。讲的时候仍然只讲一步能用的。',
};
const BANNED = [
  ['不足', '改「还没长出来的部分」'], ['短板', '改「还没用上的力气」'],
  ['缺陷', '改「还没走通的那一段」'], ['你应该', '改「你要不要试试」'],
  ['你必须', '改「可以试试」'], ['一定要', '改「如果愿意的话」'],
  ['立刻', '去掉时间压迫'], ['马上', '去掉时间压迫'],
  ['否则', '别用后果吓人'], ['就完了', '别用后果吓人'],
  ['根治', '不承诺结果'], ['保证', '不承诺结果'],
  ['一定能', '不承诺结果'], ['包好', '不承诺结果'],
  ['你差得远', '改「还有一段可以走」'],
];

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch {
    return { version: 1, phase: 'see', observations: [], steps: [], updatedAt: null };
  }
}
function save(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}
function nextId(s) {
  const n = s.steps.length + 1;
  return 's' + n;
}
function parseDue(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+)d$/);
  if (m) return new Date(Date.now() + Number(m[1]) * 86400000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  throw new Error('due 只接受 3d 或 YYYY-MM-DD');
}
function openSteps(s) { return s.steps.filter(x => x.status === 'open'); }
function overdueSteps(s) {
  const today = new Date().toISOString().slice(0, 10);
  return openSteps(s).filter(x => x.due && x.due <= today);
}
function advance(s, phase) {
  if (PHASES.indexOf(phase) > PHASES.indexOf(s.phase)) s.phase = phase;
}

const [cmd, ...rest] = process.argv.slice(2);
const s = load();

function flag(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
}
function textOf() {
  const skip = new Set(['--due', '--note', '--force']);
  return rest.filter((x, i) => !skip.has(x) && !skip.has(rest[i - 1] || '')).join(' ').trim();
}

switch (cmd) {
  case 'phase': {
    console.log(`阶段：${PHASE_CN[s.phase]}`);
    console.log(PHASE_HINT[s.phase]);
    const od = overdueSteps(s);
    if (od.length) console.log(`⚠ 有 ${od.length} 步到期未回看：${od.map(x => x.id + ' ' + x.text).join('；')}`);
    break;
  }
  case 'see': {
    const t = textOf();
    if (!t) { console.error('用法：see "看见了什么"'); process.exit(1); }
    s.observations.push({ ts: new Date().toISOString(), text: t });
    s.phase = 'step';
    save(s);
    console.log(`记下了。阶段：看见 → 给坡。下一步：只给一步，并定复查日。`);
    break;
  }
  case 'step': {
    const t = textOf();
    if (!t) { console.error('用法：step "下一步" --due 3d'); process.exit(1); }
    if (overdueSteps(s).length && !rest.includes('--force')) {
      console.error('先回看：有到期未处理的步。done 或改期后再开新步（强推加 --force）。');
      process.exit(1);
    }
    if (openSteps(s).length && !rest.includes('--force')) {
      console.error(`已经有未完成的一步（${openSteps(s).map(x => x.id).join(',')}）。一次只开一步，强推加 --force。`);
      process.exit(1);
    }
    const st = { id: nextId(s), text: t, due: parseDue(flag('--due')), status: 'open', createdAt: new Date().toISOString() };
    s.steps.push(st);
    s.phase = 'verify';
    save(s);
    console.log(`记下 ${st.id}：${st.text}${st.due ? '（复查 ' + st.due + '）' : '（没定复查日）'}`);
    break;
  }
  case 'due': {
    const od = overdueSteps(s);
    if (!od.length) { console.log('没有到期的步。'); break; }
    for (const x of od) console.log(`${x.id} [${x.due}] ${x.text}`);
    console.log('先回看：done 了没有、哪里没变。');
    process.exitCode = 1;
    break;
  }
  case 'done': {
    const id = rest[0];
    const st = s.steps.find(x => x.id === id);
    if (!st) { console.error('没这个 id：' + id); process.exit(1); }
    st.status = 'done';
    st.doneAt = new Date().toISOString();
    st.note = flag('--note') || '';
    if (s.steps.filter(x => x.status === 'done').length >= 3) advance(s, 'spread');
    else advance(s, 'step');
    save(s);
    console.log(`完成了 ${id}。${st.note ? '留档：' + st.note : ''}`);
    break;
  }
  case 'audit': {
    const file = rest[0];
    let text = '';
    if (!file || file === '-') text = fs.readFileSync(0, 'utf8');
    else text = fs.readFileSync(file, 'utf8');
    const hits = BANNED.filter(([w]) => text.includes(w));
    if (s.phase !== 'spread') console.log(`提示：现在还在「${PHASE_CN[s.phase]}」，对外讲理念前先走完验证。`);
    if (!hits.length) { console.log('措辞干净：没有红线词，没有「不足/你应该/保证」。'); break; }
    for (const [w, fix] of hits) console.log(`✗ ${w} → ${fix}`);
    process.exitCode = 1;
    break;
  }
  case 'status': {
    const od = overdueSteps(s);
    console.log(`阶段=${PHASE_CN[s.phase]} 看见=${s.observations.length} 步=${s.steps.length} 未完成=${openSteps(s).length} 到期=${od.length}`);
    break;
  }
  default:
    console.log('用法：phase | see "…" | step "…" --due 3d | due | done sN --note "…" | audit 文件 | status');
}
