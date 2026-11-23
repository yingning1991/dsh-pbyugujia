#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_video.py —— 把「画面 + 配音 + 字幕 + 背景音」拼成 1080P60 成片
用法：
  python3 tools/build_video.py                # 全片（9 分钟）
  python3 tools/build_video.py --preview 20   # 只渲前 20 秒，验证流程

素材命名（放 assets/，缺哪个就自动生成一张占位章节图）：
  01.jpg / 01.mp4 ... 06.*   按 TIMELINE 顺序；视频请给 ≥ 段时长的长度
  voice.mp3                  配音（缺省用静音占位，会打警告）
  bgm_quiet.mp3              0–2 分钟白噪音（缺省自动合成白噪音）
  bgm_piano.mp3              2 分钟以后 Lo-Fi 钢琴（缺省不混，只打提示）

字幕：out/video/subtitles.ass（由 gen_ass.py 生成）
输出：out/video/Dafeiyu_Core_Documentary.mp4
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUTDIR = ROOT / "out" / "video"
ASS = OUTDIR / "subtitles.ass"
FONT = ASSETS / "fonts" / "NotoSansCJK-Regular.ttc"

# (起秒, 止秒, 素材前缀, 章节名)
TIMELINE_DEFAULT = [
    (0, 55, "01", "开篇 · 空抽屉"),
    (55, 145, "02", "第一篇章 · 八十亿的教训"),
    (145, 245, "03", "第二篇章 · 停不下来的八个版本"),
    (245, 330, "04", "第三篇章 · 骨架的断舍离"),
    (330, 405, "05", "第四篇章 · 长出骨头"),
    (405, 540, "06", "结尾 · 不被辜负"),
]
TIMING = OUTDIR / "timing.json"


def load_timeline():
    """有真实配音时长就用它，否则退回默认 9 分钟估算。"""
    if TIMING.exists():
        tj = json.loads(TIMING.read_text(encoding="utf-8"))
        slices = [(s["start"], s["end"], f"{i+1:02d}", s["title"])
                  for i, s in enumerate(tj["sections"])]
        end = tj["total"]
        slices.append((end, end + 2.5, "07", "片尾留白"))   # 给弹幕留 2.5 秒
        return slices, end + 2.5
    # 2026-11-18 改：以前这里静默退回估算——「没跑过」被当成「跑过通过」。
    # 借 dsh-video-studio 的门禁口径：查了没过=失败，没查=跳过，跳过≠通过。
    print("⚠⚠ 没有 timing.json（gen_voice.py 的产物）：退回默认 9 分钟估算。")
    print("   这条不算通过，只算跳过 —— 按估算排的时间轴前面准、后面一定飘。")
    print("   要出片就先跑 gen_voice.py 量真实配音时长。")
    return TIMELINE_DEFAULT, TIMELINE_DEFAULT[-1][1]

W, H, FPS = 1920, 1080, 60


def find_asset(prefix: str):
    for ext in ("mp4", "mov", "jpg", "jpeg", "png"):
        for name in (f"{prefix}.{ext}",):
            p = ASSETS / name
            if p.exists():
                return p
    return None


def make_placeholder(prefix: str, title: str) -> Path:
    """没有素材时生成一张带章节名的深色图，保证流程能跑。"""
    out = ASSETS / f"{prefix}.jpg"
    if out.exists():
        return out
    ASSETS.mkdir(parents=True, exist_ok=True)
    warm = prefix in ("05", "06", "07")
    bg = "0x1E140C" if warm else "0x0D1117"
    fg = "0xD8A46A" if warm else "0x8FA6C0"
    vf = (
        f"drawtext=fontfile={FONT}:text='{title}':fontcolor={fg}:fontsize=64:"
        f"x=(w-tw)/2:y=(h-th)/2-40,"
        f"drawtext=fontfile={FONT}:text='大肥鱼 Core · 占位素材':fontcolor=0x3D4A5C:"
        f"fontsize=32:x=(w-tw)/2:y=(h-th)/2+60"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", f"color=c={bg}:s={W}x{H}",
         "-vf", vf, "-frames:v", "1", str(out)],
        check=True,
    )
    print(f"   · 生成占位素材 {out.name}")
    return out


def run(cmd):
    print("  $", " ".join(str(c) for c in cmd)[:160], "…")
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", type=int, default=0, help="只渲前 N 秒（0=全片）")
    args = ap.parse_args()

    if not ASS.exists():
        sys.exit("缺 out/video/subtitles.ass——先跑 python3 tools/gen_ass.py")
    OUTDIR.mkdir(parents=True, exist_ok=True)

    TIMELINE, total = load_timeline()
    if args.preview:
        total = min(args.preview, total)

    # 1) 素材
    inputs, filters, vlabels = [], [], []
    for i, (t0, t1, prefix, title) in enumerate(TIMELINE):
        if t0 >= total:
            break
        dur = min(t1, total) - t0
        if dur <= 0:
            continue
        p = find_asset(prefix) or make_placeholder(prefix, title)
        is_video = p.suffix.lower() in (".mp4", ".mov")
        if is_video:
            inputs += ["-i", str(p)]
        else:
            inputs += ["-loop", "1", "-t", f"{dur:.2f}", "-i", str(p)]
        vlabels.append(f"[v{i}]")
        filters.append(
            f"[{i}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},setsar=1,format=yuv420p,"
            f"trim=0:{dur:.2f},setpts=PTS-STARTPTS,"
            f"fade=t=in:st=0:d=0.5,fade=t=out:st={max(0,dur-0.5):.2f}:d=0.5[v{i}]"
        )

    n = len(vlabels)
    concat = "".join(vlabels) + f"concat=n={n}:v=1:a=0[cat]"
    filters.append(concat)
    filters.append(
        f"[cat]subtitles=filename={ASS.relative_to(ROOT)}:fontsdir="
        f"{FONT.parent.relative_to(ROOT)}[vout]"
    )

    # 2) 音频：配音 + 背景音
    audio_inputs, audio_filter = [], None
    idx = n
    voice = OUTDIR / "voice.mp3"
    if voice.exists():
        audio_inputs += ["-i", str(voice)]
        has_voice = True
        vidx = idx
        idx += 1
    else:
        has_voice = False
        print("⚠ 没找到 voice.mp3，用静音占位（配音还没生成）")

    # 白噪音：0–120 秒（只用 lavfi 合成，不依赖素材）
    filters.append(
        f"anoisesrc=d={min(total,120):.2f}:c=pink:a=0.02[noise]"
    )
    if has_voice:
        filters.append(
            f"[{vidx}:a]atrim=0:{total:.2f},asetpts=PTS-STARTPTS,volume=1.0[vo]"
        )
        base = "[vo]"
    else:
        filters.append(f"anullsrc=r=48000:cl=stereo:d={total:.2f}[vo]")
        base = "[vo]"
    # 把白噪音接到 0–120s，后面静音
    filters.append(
        f"[noise]apad,atrim=0:{min(total,120):.2f},volume=-25dB,"
        f"aformat=sample_rates=48000:channel_layouts=stereo,"
        f"apad=whole_dur={total:.2f}[bgm]"
    )
    filters.append(f"{base}[bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]")

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning", "-stats"]
    cmd += inputs + audio_inputs
    cmd += ["-filter_complex", ";".join(filters),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-profile:v", "high", "-level", "4.2",
            "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "192k",
            "-t", f"{total:.2f}",
            "-movflags", "+faststart"]
    out = OUTDIR / ("preview.mp4" if args.preview else "Dafeiyu_Core_Documentary.mp4")
    cmd.append(str(out))

    print(f"渲染 {total:.0f}s（{total/60:.1f} 分钟）→ {out}")
    run(cmd)
    size = out.stat().st_size / 1e6
    print(f"✅ {out}  {size:.1f} MB")
    # 出片规矩（11-08 主人定，11-09 三次栽过）：成片自动交付到 /sdcard/Movies/ 根目录，不建子文件夹。
    # 工具自己保证这一步，不再靠我记性；预览段不交付。
    if not args.preview:
        deliver = ROOT / "tools" / "deliver.mjs"
        if deliver.exists():
            print("→ 调 deliver.mjs 交付到相册目录…")
            subprocess.run(["node", str(deliver), str(out)], check=False)
        else:
            print("⚠ 没找到 tools/deliver.mjs，成片还在 out/video，需手动交付")


if __name__ == "__main__":
    main()
