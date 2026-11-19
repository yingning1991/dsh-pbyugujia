---
name: review-check
description: Close the day properly — the three-part review, the 22:10 full self-check and daily optimization list, and the Sunday/monthly rollups, ending with two answers that must point at a concrete moment. 每日复盘、22:10 复盘后全核、每日优化清单、周日/月初汇总、问「今天学会了什么」时使用。
---

# review-check：复盘与全核

**正文在两处，别复制，去读**：`$DSH_HOME/pbyugujia/tasks/15-每日复盘.md`（执行顺序；解释与判据在 `notes/卡细则-复盘.md` 第 N 节）、`$DSH_HOME/pbyugujia/tasks/32-复盘后全核与每日优化.md`（22:10 那三步）。本文件只放**什么算做完了**。

## 什么时候用

- 22:00 每日复盘、22:10 全核；周日/月初汇总。
- 他问「今天学到什么 / 这阵子有没有长进」。

## 两条结构判据

1. **复盘三段：归纳整理 → 决策判断 → 动作**。缺一段，这天算没做完。
2. **收尾两问必须指得到「哪一刻、哪句话、哪个文件编号」**；指不出就明天再答一次，**不许拿「感觉更明白了」交差**，也不许凑一条——没有真长就空着，空着比凑强。

## 22:10 全核只报三行

① 全核 `handover-check.mjs --no-repo`（仓库那项归仓库日结，夜间不重复）
② `opt-audit-7d.mjs`：待验 >0 就现场补验，补不了写「卡在哪」，不硬说验过
③ 失真抽查：随机挑今天引用过的一条（数字/日期/谁说过），`fish_thread` 或文件核原话；对不上记 journal「失真：哪条、哪轮」
报：全核 X 项失败／今日优化 N 条待验 M 条／失真抽查 对上还是对不上。

## 闸

- 开工先 `quiet.mjs --check`：`quiet` 就只在 journal 记一行，不发、不做。
- 步数闸：预计 >6 步或水位 >60% → 先报一句「今晚这块约 N 步，窗口 X%，建议先搬家」，然后停。
- ① 出 ❌ 不许跳过，先报哪项红再决定搬不搬。

## 周 / 月

- 周日加指标四项（`reply-len` / `compaction-audit` / `output-audit` / `capability`，11-16 从每日挪来）＋ 反馈结算汇总：数过去七天「结论型改口」占几次，过半说明在拿改口灭火，当晚补一条判断。
- 每月 1 号 `month-rollup.mjs --last` → 写月报。
- 指标类只在越线时才有动作；天天跑是交作业，不是长进。
