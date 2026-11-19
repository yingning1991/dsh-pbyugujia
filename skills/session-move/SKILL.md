---
name: session-move
description: Move the working session to a fresh window with zero task loss — build the schedule list from the slim manifest, run the lite handover check, snapshot before closing the old window. 搬家、换新会话、上下文快满了要搬、把任务和状态接到新窗口时使用。
---

# session-move：搬家（换窗口）

搬家的唯一目标：**新窗口什么都在，旧窗口敢关**。丢过 19 条任务（11-15 `9ff0c6e0`），所以顺序不许跳。

## 什么时候搬

- 上下文水位 60% 必搬；40 步量一次。
- 其余情况：回本 ≤20 步且活还够跑才搬；闲聊接续、同一下半步、严重依赖"刚才聊到哪儿"的不搬。
- 搬前在 `thread.md` 写一行意图（我要做什么、做到哪一步）。

## 步骤（照做，不许跳）

1. **先量**：`node tools/move-check.mjs` 看回本步数；空间不够就先压缩。
2. **出清单**：把当前会话的任务导出成 `out/tmp/jobs-slim-<日期时间>.json`（含 title/kind/prompt/time/weekdays）。**prompt 只留一行「按 tasks/XX.md 执行」，正文不进清单**（长 prompt 落卡）。
3. **写开工单** `out/tmp/boot-<日期时间>.md`：条数、清单路径、轻核命令、旧窗快照命令、预算上限、别读别做清单。
4. **把窗开起来（只有一条路，不再「两选一」）**：
   **触发条件：主人说了「搬家」才开窗**。他没说，我不开、也不预先建那条一次性任务。
   - 开窗前先跑 `node tools/session-jobs.mjs --dup`：**他可能已经复制了一个窗口**（2026-11-19 他原话：「我会复制开一个，你又开了一个定时，就变成两个了」）。若已经有两处 active，先别建，直接报他「你复制的那份已经在跑，我不再开」。
   - 他说了「搬家」→ 1 分钟后 `schedule_create` 建一条一次性任务，`target:"new_once"`，prompt 写三句——「读 `out/tmp/boot-<时间>.md` 照做／建完办 pending 里那件事／全绿再让主人关旧窗」。
   - 建完立刻再跑一次 `node tools/session-jobs.mjs`：**必须只剩一处 active**。多出来的旧窗任务就停掉（能关窗就让他关，关不了就 `schedule_edit` 置 paused），并报一句「多了一份，已停旧窗」。
   **坑（11-18 踩过）**：只备包不建这条任务，就等于没搬——`prompt-audit` 里 14:38 之后一个新会话都没有，流程停在那里，谁也没发现。
   **坑（11-19 踩过）**：他又复制了一个窗，我又按自动流程开了一个——两个窗口各跑一遍「每日AI三件事」，同一分钟写同一个 `notes/<日期>-…解读.md`，后写的盖掉先写的，我那份 6.3KB 的稿子没留下。**双窗＝双份钱＋互相盖写**，这是这条流程最贵的错。
5. **新窗第一件事**：读开工单 → 一次性建完所有 `schedule_create`（target=this_session）→ 同一步跑轻核 → **跑 `node tools/capability.mjs --week`**，把「这七天多了什么能力」用一句话报出来（2026-11-19 加：主人「你今天拥有能力，换窗口就不知道了」）。
6. **轻核**：`node tools/handover-check.mjs --slim <清单> --lite`。要看到「本会话任务 N 条（active N）／清单差异 0／钟点错位 0／别处 active 0」四项全绿。
7. **核近 7 天原话**：一封 `fish_thread` 合并关键词（身体线：功/饭/睡/咳 + 最近答应过的事）。**别拿摘要当事实**。
8. **旧窗快照再关**：`node tools/preclose.mjs --session <旧窗id前8位>`；**条数对得上才许关窗**。关会话会批量删该会话的任务，回档只回正文不回任务。

## 收尾（必须做，11-18 被主人点过）

**把「搬家代码」原样贴给主人**——`out/tmp/交接短版-*.txt` 全文放进代码块，可直接复制粘贴；只给路径不算交付。
他这几天的怨言是原话：「你以前会给我搬家代码，但是这几天总忘记」。

## 判据（做没做成）

- 轻核四项全绿 + 原话核过 + 任务条数一致 → 才说「可以关旧窗」。
- **单窗**：`node tools/session-jobs.mjs` 退出码 0、只有一个会话握着 active 任务（2026-11-19 加：双窗会双跑、互相盖写）。
- 有一项红：当场修，不搬第二次。

## 坑

- 别拉全量 `schedule_list`（37 条一进上下文，后面每步重读，11-11 实测占搬家预算三成）。
- 别探归档入口、别改压缩阈值、别在搬家时做待办对账。
- 归档由主人自己动（11-11 定），不核、不问。
