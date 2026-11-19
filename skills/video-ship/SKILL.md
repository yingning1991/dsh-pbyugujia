---
name: video-ship
description: Ship a finished video — storyboard to shots, mix the audio through the single audio entry point, deliver to the album, verify duration, then keep publishing to the owner. 出片、做视频、交付成片、把片子放进相册、核对成片时长时使用。
---

# video-ship：出片

正文以任务卡为准：`tasks/22-每日出片.md`（今日版）。这里只放**不许忘的门和坑**。

## 顺序

1. **定稿再配音频**：画面、字幕、时长先定。换配音＝重做全片（字幕要重排、要重渲），不是换个音轨的事。
2. **音轨唯一入口**：`tools/mix_audio.py`。三层 stem（vo/amb/sfx）分开落 `out/tmp/mix/`，`amix normalize=0`（默认归一化会白压 6dB），两遍 loudnorm 到 **-16 LUFS / TP -1.5 / 48k stereo**，视频流 `-c:v copy`。旧 `add_texture_sfx.py` 停用。
3. **交付三步**（缺一步都不算进相册）：`deliver.mjs` → `am broadcast` 触发扫描 → `content query` 看到真实 duration。
4. **发布归主人**：B 站发布是红线，先回述、等他点头；仓库/分享可以先做。

## 判据

- 说「成片好了」之前，手上要有：相册里的 MediaStore 记录（含 duration）、文件字节数、电平实测值。
- 没有 `shell`／特权通道时，只能做第一步，**必须标明「未核」**，并说明三条开通路。

## 坑

- 背景音受手机硬件限制做不出好效果（11-18 主人听完 v18 定：这条线先停）。别自己捡回来。
- 叠纹理/图片流要 `trim` + `-t` 双保险，否则无限编码（11-18 踩过）。
- 一条片子过 ¥2 或 30 轮，停下报账。
- 音效、版式规律在 `learnings/视频审美/`；每条规律要能落到 `make_shots.py` 的某一处，落不到就是空话。
