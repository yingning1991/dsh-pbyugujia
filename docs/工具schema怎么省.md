# 工具 schema 怎么省：把常驻的挪出去

> 2026-11-06 实测。数字都是本机跑出来的，不是估的。

## 问题

agent 每轮都要重发一遍**所有工具的 schema**。工具越多、描述越长，这部分固定开销越大——而且它不随对话缩短，**每轮都付一次**。

我们这边实测：51 个工具，schema 合计 **29,367 token/轮**。其中三个客户端工具最贵：

| 工具 | description 字数 | schema 字符 | ≈ token |
|---|---|---|---|
| bubble | 18,733 | 32,230 | ~10,000 |
| statusbar | 8,750 | 12,036 | ~3,800 |
| ui | 7,556 | 11,792 | ~3,700 |

这三个加起来约 **17.5k/轮**，占工具开销的六成——而它们一个月被调用不到几次。

## 三个走不通的做法（都试过）

1. **在配置层写 `disabled: true`** —— 被盖。客户端每次冷启动都会重写自己的 patch 文件，且排在用户配置**之后**应用，整行覆盖。
2. **改插件源码加开关** —— 被盖。客户端每次启动重写整个插件目录。
3. **在根 context 调 `ctx.tools.restrict()`** —— 直接抛错：`requires a scoped context (agent.ctx)`，它只接受 agent 作用域。

## 走通的做法

**在 agent 作用域上挂一个遮罩**：

```js
export const name = 'tool-mask';
export const inject = ['tools'];

export function apply(ctx, config) {
  const deny = config?.deny ?? [];
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ deny });   // 只收窄可见集合，工具本身还在跑
  });
}
```

挂在用户自己的 `cordis.patch.yml` 里（那个文件客户端不碰），重启引擎后生效。

## 结果

- 工具数 51 → 48，schema **29,367 → 14,563 token/轮**，净省 **14,804/轮**。
- 判据：看会话日志里 `request/header` 的 `tools` 数组，别信 `tools.schemas()`——`restrict()` 刚调完那一刻它只反映局部层，会给出假阴性（我们踩过，报「21 个、deny 的三个还在」）。

## 能力怎么不丢

摘掉 schema ≠ 摘掉能力。配一个 CLI，**import 插件、捕获它注册的定义、直接调它自己的 `execute`**——不重写校验逻辑，插件以后怎么改都跟着变：

```bash
node tools/toolcli.mjs bubble '{"action":"get"}'
```

实测三个工具摘掉后 CLI 全通（悬浮球拿到原生实时外观、状态栏拿到配色、UI 拿到元素树）。

## 什么时候别用这招

- 工具**常用**——省的那点不如每次多打一次命令的麻烦。
- 工具**改行为**（不是改外观）——CLI 拿不到会话里的上下文时反而危险。
- 没有 CLI 兜底时别摘：**摘 schema 的前提是能力有别的入口**。
