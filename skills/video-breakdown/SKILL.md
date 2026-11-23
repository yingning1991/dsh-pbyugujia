---
name: video-breakdown
description: Break down a video shot by shot — how each picture was made (filmed / AI-generated / coded / 3D / screen capture / still + motion), what the audio is doing, and how to remake it, in the VIDEO.md style with evidence and confidence. 拆解爆款视频、看一支片子每一镜是怎么做出来的、复刻镜头、逐镜取证、判断是实拍还是 AI 还是代码渲染时使用。
---

# video-breakdown：拆解一支片子，逐镜给证据

目标不是"描述画面"，是回答三个问题：**这一镜怎么做的？凭什么这么说？怎么复刻？**

## 先判断要不要拆

- 要：学爆款结构、判断"这活我能不能做"、复刻某一镜、给成片做体检。
- 不要：只想知道"讲了什么"——那用 `video_storyboard` 的 textOnly 看字幕就够，别上取证。
- 单条片超过 10 分钟，先按窗口拆（`from` + `segment`），别一次全片。

## 步骤

**1. 元数据先看**（免费）：`video_probe` 拿时长、分辨率、帧率、音轨、字幕轨。
帧率是重要证据：生成模型常见 24/25 fps，手机常拍 60 fps。

**2. 要理解内容，先读字不读图**：`video_storyboard({textOnly:true})`。
成本是一段文本，不是图。看完才知道哪几镜值得细看。

**3. 只对需要的窗口抽帧**：`video_zoom({cellId})` 或 `video_storyboard({from,to})`。
默认 `strategy:"auto"`；`full` 是更贵的一档，不是更全的一档。

**4. 逐镜填三栏**（核心产物，缺一栏不算拆完）：

| 帧/时间 | 怎么做的 | 证据（测到的值） | 复刻路线 |
|---|---|---|---|
| 00:12–00:20 | code_render | 平坦块占比 0.7、颜色数 42、无传感器噪点、背景逐帧不变 | Remotion/HTML 重建 |

八类标签：`live_action` / `ai_video` / `avatar` / `cg_3d` / `code_render` / `screen_capture` / `still_motion` / `static_hold`。
**叠加层单列**（字幕、标题、贴片、版式）——同一镜可以是「代码渲染 + 代码字幕」。

**5. 证据优先用可测量的**（ffmpeg 自带，不依赖 Python 库；本机 numpy 是坏的）：
- 切镜：`scdet`；变化面积要够大，元素弹出不算切镜。
- 冻结/一张图推拉：`freezedetect` + `vidstabdetect` 的全局变换；整图刚体推拉**不许**判成实拍。
- 渲染 vs 拍摄：`signalstats`/`entropy` 看噪声与平坦度；画面冻结**不许**判成任何"视频生成"。
- 卡点：切点落在节拍/起音上的比例。

**6. 声音只当线索，不当结论**。实测过的翻车：92 拍被数成 185 拍、0 个音效报成 13 个、7 条字幕按 11 条算。
任何拍数/音效结论都标「工具测 + 待人工听」。

## 三条硬坑

1. **平台下载片会丢证据**：二次压缩抹掉噪点，作者实测准确率降到 88.6%——暴款拆解正好踩这格。结论必须带置信度。
2. **ASR 会把名字听花**（caveman→cvet/cafman）。引用专有名词前，先去仓库/画面上核实；核不到就标「没核实」。
3. **两张图推拉 ≠ 视频生成**；闪烁缺失是 AI 视频的反面证据之一，不是正面证据。

## 收尾

- 产物落盘：`out/tmp/breakdown-<片名>.md`（人看）+ `.json`（机器读），stdout 只回结论行。
- 回复只给：这是什么片／最值得借的一镜／判断置信度／我复刻它缺什么。
- 想改流程先看 `learnings/视频审美/2026-11-18-rea-video-能借什么.md`，别重新发明。
