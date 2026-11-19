---
name: rule-change
description: Change my own rule files safely — snapshot, edit one line, run the 14-question difference test with two clean subagents, score the action buckets, record the rollback trail. 修改 CORE.md、AGENTS.md、人格/规矩、加一条判断、改回滚记录时使用。
---

# rule-change：改我自己的规矩

动 CORE / AGENTS 是有流程的，跳一步就等于没改。

## 步骤

1. **快照**：`node tools/rule-diff.mjs --snapshot` → 得到后缀（如 `2026111806270`），CORE 与 AGENTS 各一份 `.pre-`。
2. **只改那一句**：写明「替代谁」，不许只加不减。改完 `node tools/core-budget.mjs` 看余量（硬上限 6000 字符）。
3. **出题**：`node tools/rule-diff.mjs --prepare <后缀>` → 14 题（seed 记下来）。
4. **两个干净子代理**各答一侧：旧侧读 `CORE.md.pre-<后缀>`／`AGENTS.md.pre-<后缀>`，新侧读现行两份。要求严格 14 行 `旧|题号|答案`、`新|题号|答案`，一句话动作、不解释。
5. **评分**：合并成一个文件，`node tools/rule-diff.mjs --score <答案文件>`。
6. **判分歧**（这一步最容易被糊过去）：
   - 同义说法没进词表 → 给评分器补词（先 `cp` 备份 `.bak-日期`），只加词不改判定；
   - **行为真变了** → 问一句：这是我要的改动吗？是，就写清楚「这题是有意不同」，别硬凑 14/14；不是，回滚。
7. **人工核 diff**：`diff CORE.md.pre-<后缀> CORE.md`，确认只动了目标那一段、无文本丢失。
8. **留痕**：`notes/CORE-回滚记录.md` 记——他的原话／改了什么／替代谁／为什么旧条不行／例子／差测结果与 seed／回滚办法；例子补进 `notes/规矩-例子库.md`。

## 判据

- 动作桶一致、或唯一分歧能被解释成「有意改动」；diff 只动目标句。两条都过才说「改好了」。
- **不许为了好看补词凑满分**：假 14/14 比 13/14 加一句解释更坏。

## 坑

- 评分器词表漏词很常见（同义说法），先判「读法差异」再判「文本丢失」。
- 改完别忘配 `notes/规矩-例子库.md`：答不出真例子的规矩就该留在 notes 当候选。
