---
name: memory-maintain
description: Maintain the persistent memory — write self-contained facts with source markers, check for missing or superseded entries, run the daily lint and the weekly re-check, and repair the index safely. 写记忆、查记忆、核记忆、改口挂 supersedes、每日 lint、周日记忆回查、重建记忆索引时使用。
---

# memory-maintain：记忆维护

**正文不在本文件**：写入三行、来源标记、检索五步都在 `~/.dsh/AGENTS.md` 的「记忆操作手册」一节；回查命令在 `notes/2026-11-12-每周记忆回查清单-草案.md`；判断走哪条检索路见 `CORE.md`「记忆判断」。本文件只放**什么算写完**和**踩过的坑**。

## 什么时候用

- 要写、改、删一条长期记忆；他说过的话要落库。
- 他问「之前做过没／讲过没」，或我想不起是哪一回。
- 周日记忆回查、重建索引、感觉记性和事实对不上。

## 写完的判据（三问，答不出就先别写）

1. **三行齐**：是什么 · 什么撑着 · 何时不成立。第三行填不出，说明还没想清，留在 notes。
2. **来源先定**：标题带【他说的】/【结果】/【我判断】/【资料转述】；推断一律【我判断】。无标不落库。
3. **自含**：未来会话看不到当前对话——写清背景、日期、为什么。原文/原件不进库（视频只记「哪支片、什么结论、哪天验过」）。

## 顺序（一步不跳）

1. 查过再说：口语问句先 `node tools/rewrite.mjs`；扫 `notes/记忆总账.md` 选路——事实/经历 `fish_recall`（先 `light:true`），原话/先后 `fish_thread`，方法/笔记 `kb.mjs`。
2. 冲突以原话为准：记忆条与原话打架 → 原话为准，改条挂 `supersedes`，旧原话留着。
3. 检索回来的只当线索：成本、配置、版本、数字一律跑工具核，不拿记忆条当事实。**判断/结论类同理**（2026-11-19 加）：一条被命中只说明「我可能缺这块」，不等于它成立——先看正文有没有原文/出处，没有就标「线索，不当依据」；**不因为「被查到很多次」给它加权**。来历：dsh-soul 2.2.0 把「检索命中自动强化节点」改成「按证据缺口回查原文」，跟 my `touches-1110` 要验的是同一件事。
4. 落地后带 id 回话；说「记了」前同一轮要有 id 或路径。

## 每日 / 每周

- 每天：`node tools/memory-lint.mjs --line` 报无标条数。
- 每天复盘里：`mem-arb.mjs`（只报不改，挑 1–2 对判）、`core-budget.mjs`（🔴 或余量 <600 才列候选）。
- 周日：`mem-review` / `mem-score` / `mem-conflict` 三步。

## 坑（踩过，别再踩）

- **不许直接调 `reindexAll`**：方向是「文件→库」，旧文件会静默覆盖库里的新更正（11-17 踩过）。重建一律先 `node tools/mem-sync-safe.mjs --dry`，有差异再 `--apply`（自带备份＋双向对齐＋复核）。
- **`touches=0` 不是删条依据**（`fy-261112-rynd`，11-12 实测）：认得出、想不起来是两件事，先标「只认得、没想起」，两周还这样再说。
- 一条改口必须带新证据（新数据/新路径/新原话）；没有就是谄媚，不是修正。
