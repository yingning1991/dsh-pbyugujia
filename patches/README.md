# 插件补丁存档

> 补丁打在 `~/.dsh/node_modules/dsh-pbyugujia/lib/index.js` 上。**重装/升级插件会被覆盖**，回来后把这里对应的文件 cp 回去。

## 1110-threadcount（2026-11-10）
- 改 `searchThread`：先 `COUNT(*)` 拿总数再 LIMIT，返回 `{rows,total}`。
- 改 `fish_thread` 输出：总数大于显示条数时追加「库中共 N 条匹配，只显示 M 条；查更早的加 from/to」。
- 起因：查 11-02「心止于符」原话，被更新的命中挤出前 5 条，我据此判「库里没有」——其实是截断。
- 回滚：`index.js.bak-1110-threadcount`。

## 1117-rerank（2026-11-17）记忆检索重排
- 改 `search`：主路分加「标题命中率」与「整句短语命中」两个特征；默认融合权重 `W_PRIMARY` 0.002→0.06、`W_RANK4` 3.0→1.5（环境变量仍可覆盖）。
- 配 `notes/检索别名表.md` 补 7 组同义词（覆盖 75%→88.9%）。
- 起因：36 题题集实测生产检索 @3 只有 50%，比朴素两路（58.3%）还差——融合把好的排下去了（参照 arXiv 2610.30755：去掉重排 −3.92）。
- 结果：@1 30.6%→52.8%、@3 50%→66.7%、MRR 0.437→0.611（`node tools/recall-bench.mjs --prod`）。
- 文件：`dsh-pbyugujia-index-1117-rerank.js`（打好的整份）、`dsh-pbyugujia-index-1116-base.js`（打之前那一版，回滚用）。
- 回滚：把 base 那份 cp 成 `lib/index.js`，或 `cp index.js.bak-1117-rank index.js`。
- 生效：**引擎重启后**才用上新代码（当前进程加载的是旧模块）。
