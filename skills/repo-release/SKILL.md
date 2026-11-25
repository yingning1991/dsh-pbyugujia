---
name: repo-release
description: Ship a version to both mirrors — decide whether today's change is worth a version, split private from public, sanitize, bump the changelog, push Gitee and GitHub, publish the Release, and verify both sides green. 推仓库、发版、判够不够一版、双镜像同步、发 Release、仓库日结时使用。
---

# repo-release：仓库日结 / 发版

**正文在 `$DSH_HOME/pbyugujia/tasks/24-仓库日结.md`——照那张卡一步一步走，本文件只放判据与红线。**
卡已取消定时（11-17 主人定：硬核攒够再出，不按天），要跑就是手动照卡跑。

## 什么时候用

- 他说「推一下仓库 / 发个版」，或攒够一版要上线。
- 复核远端绿不绿（`repo-check` / `gh-verify`）。

## 先判够不够（不够就不发版）

读者能读到的东西变了 · 修了读者会踩的坑 · 口径/约定变了——**任意一条**才算够。
不够就一句「今天不够一版」，别为产出凑版本。

## 三条硬顺序

1. **先分私人用 / 大众用**：离开我们的定时任务、私有数据、习惯还站得住吗？站不住的不进 `repo/`、不升版本号、不写 repo 的 CHANGELOG（只记 `CHANGELOG-local.md`）。判错就会让本地版和远端 Release 对不上——11-13 `gold.mjs` 混进 v0.1.32/33 红过一次。
2. **脱敏后排**：功能改动照抄，姓名/本机路径必须脱敏；`sanitize-check.mjs repo --allow repo/allow.txt` 必须「✅ 干净」，不干净就停。
3. **仓库先上线，视频后发**。当天 18:10 已推过，出片任务只复核不重推。

## 命令链（2026-11-19 主人定「以后发布就是这个流程」）

0. **先对照基线**：`node tools/plugin-baseline.mjs --diff` —— 逐条报「新增/删除/改动」，不凭印象说这版加了什么。
1. `sync-audit` → 搬进 `repo/tools/` 并脱敏 → `sanitize-check`（必须「✅ 干净」）。
2. 写 `CHANGELOG`（+1 版本号）、把新文档/技能拷进 `repo/`、`build-plugin-skeleton`（--check 报一致）。
3. `make-release-zip` → `gitee-push` + `gitee-release` → `gh-push --sync` + `gh-release`。
4. `repo-check` + `gh-verify` 两边三样全绿；**不绿就停，报哪一项，不试第三次**。
5. 回填：`notes/仓库待更新账本.md` 待发行改「已发 vX.Y.Z」→ `plugin-baseline --save` 更新基线 → `CHANGELOG-local.md` 与 journal 各一行。
令牌走 `.gitee-token` / `.gh-token`，不进库、不进回话。

## 每次发版必带三处介绍（2026-11-19 定）

1. **CHANGELOG**：仓库里跟版本走，写「改了什么 / 为什么 / 怎么回滚」。
2. **Release 说明**：读者视角——这版为什么值得升、怎么用。
3. **回话三句**：版本号 + 带了哪三样 + 两边绿不绿（附两个 Release 链接）。只报「发了」算没交。

## 红线

- **不绿就别说「已上线」**：宁可说「没推成，差哪一样」。
- `CORE.md` / `US.md` / `diary/` / `journal/` / `memory.db` / `chat.db` 永不进 repo；姓名、私聊原话、本机路径不带进去。
- 报给主人的只有一句：版本号 + 两边绿不绿 + 带了哪几条。
