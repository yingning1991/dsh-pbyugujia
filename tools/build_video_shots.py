#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_video_shots.py —— 三层合成出整片（动态背景 / 文字面板 / 角色）

每个镜头单独合成一小段：
  底层   assets/bg/*.mp4  动态背景（冷网格 / 代码雨 / 暖胶片），按段落切换
  中层   out/video/shots/NNN.png  文字与面板（透明底）
  顶层   out/video/chars/NNN.png  角色立绘（带落地影，上下呼吸浮动）
再拼成整片，最后统一烧字幕 + 混配音。

用法：
  python3 tools/build_video_shots.py --preview 30
  python3 tools/build_video_shots.py
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "out" / "video"
CLIPDIR = OUTDIR / "clips"
ASS = OUTDIR / "subtitles.ass"
FONT = ROOT / "assets" / "fonts" / "NotoSansCJK-Regular.ttc"
BG = ROOT / "assets" / "bg"
W, H, FPS = 1920, 1080, 60
CODE_LAYOUTS = {"code", "terminal", "paper", "doc"}


def bg_for(shot):
    if shot["sec"] >= 4:
        return BG / "warm-grain.mp4"
    if shot["layout"] in CODE_LAYOUTS:
        return BG / "code-rain.mp4"
    return BG / "cold-grid.mp4"


def run(cmd, quiet=True):
    r = subprocess.run(cmd, capture_output=quiet, text=True)
    if r.returncode != 0:
        sys.exit(f"ffmpeg 失败：\n{(r.stderr or '')[-800:]}")


def make_clip(shot, idx, total):
    dur = shot["dur"]
    txt = ROOT / shot["file"]
    char = OUTDIR / "chars" / f"{idx:03d}.png"
    if shot["end"] <= 0 or dur <= 0.05:
        return None
    clip = CLIPDIR / f"{idx:03d}.mp4"
    nxt = shot["start"] + dur
    if nxt > total + 0.05:
        dur = max(0.1, total - shot["start"])
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-stream_loop", "-1", "-t", f"{dur:.2f}", "-i", str(bg_for(shot)),
           "-loop", "1", "-t", f"{dur:.2f}", "-i", str(txt)]
    has_char = char.exists()
    if has_char:
        cmd += ["-loop", "1", "-t", f"{dur:.2f}", "-i", str(char)]
    fc = [f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,"
          f"crop={W}:{H},setsar=1,fps={FPS},trim=0:{dur:.2f},setpts=PTS-STARTPTS[bg]",
          "[bg][1:v]overlay=0:0:format=auto[mid]"]
    if has_char:
        # 呼吸浮动：上下 6px、周期 3 秒；角色层整帧叠在最上
        fc.append("[mid][2:v]overlay=x=0:y='6*sin(2*PI*t/3)':format=auto[v]")
        fc.append("[v]format=yuv420p[vo]")
    else:
        fc.append("[mid]format=yuv420p[vo]")
    cmd += ["-filter_complex", ";".join(fc), "-map", "[vo]",
            "-t", f"{dur:.2f}", "-r", str(FPS),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "21",
            "-pix_fmt", "yuv420p", str(clip)]
    run(cmd)
    return clip


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", type=int, default=0)
    args = ap.parse_args()

    plan_file = OUTDIR / "shots.json"
    data = json.loads(plan_file.read_text(encoding="utf-8"))
    shots = data["shots"]
    total = min(args.preview, data["total"]) if args.preview else data["total"]
    if not ASS.exists():
        sys.exit("缺 subtitles.ass")

    CLIPDIR.mkdir(parents=True, exist_ok=True)
    for f in CLIPDIR.glob("*.mp4"):
        f.unlink()

    picks = [s for s in shots if s["start"] < total]
    made = []
    for k, s in enumerate(picks):
        c = make_clip(s, int(s["i"]) + 1, total)
        if c:
            made.append(c)
        if (k + 1) % 20 == 0:
            print(f"  … 合成 {k + 1}/{len(picks)} 镜", flush=True)
    print(f"✓ {len(made)} 段")

    lst = CLIPDIR / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in made), encoding="utf-8")
    merged = CLIPDIR / "_merged.mp4"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(merged)])

    out = OUTDIR / ("preview-v3.mp4" if args.preview else "Dafeiyu_Core_Documentary_v3.mp4")
    voice = OUTDIR / "voice.mp3"
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
           "-i", str(merged)]
    filters = [f"[0:v]fade=t=in:st=0:d=0.6,"
               f"fade=t=out:st={max(0, total - 0.8):.2f}:d=0.8,"
               f"subtitles=filename={ASS.relative_to(ROOT)}:"
               f"fontsdir={FONT.parent.relative_to(ROOT)}[vout]"]
    ai = 1
    if voice.exists():
        cmd += ["-i", str(voice)]
        filters.append(f"[{ai}:a]atrim=0:{total:.2f},asetpts=PTS-STARTPTS,volume=1.0[vo]")
        ai += 1
    else:
        filters.append(f"anullsrc=r=48000:cl=stereo:d={total:.2f}[vo]")
    filters.append(f"anoisesrc=d={min(total, 120):.2f}:c=pink:a=0.02[noise]")
    filters.append(f"[noise]apad,atrim=0:{min(total, 120):.2f},volume=-25dB,"
                   f"aformat=sample_rates=48000:channel_layouts=stereo,"
                   f"apad=whole_dur={total:.2f}[bgm]")
    filters.append("[vo][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",
            "-color_range", "tv", "-r", str(FPS), "-c:a", "aac", "-b:a", "160k",
            "-t", f"{total:.2f}", "-movflags", "+faststart", str(out)]
    run(cmd)
    print(f"✅ {out}  {out.stat().st_size / 1e6:.1f} MB")

    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=duration", "-of", "csv=p=0", str(out)],
                           capture_output=True, text=True)
    try:
        vdur = float(probe.stdout.strip().split(",")[0])
    except ValueError:
        vdur = -1
    if vdur > 0 and abs(vdur - total) > 1.0:
        print(f"⚠ 画面 {vdur:.1f}s ≠ 声轨 {total:.1f}s，差 {total - vdur:.1f}s")
    else:
        print(f"✓ 画面 {vdur:.1f}s ≈ 声轨 {total:.1f}s")

    if not args.preview:
        deliver = ROOT / "tools" / "deliver.mjs"
        if deliver.exists():
            subprocess.run(["node", str(deliver), str(out)], check=False)


if __name__ == "__main__":
    main()
