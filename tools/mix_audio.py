#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mix_audio.py —— 三层混音（2026-11-18，v18 起接回主链）

为什么要有这一层：v17 的混音链有四个叠加问题（2026-11-18 实测）
  1) amix 默认 normalize 把旁白白压 6dB（voice mean -21.7 → 成片 -27.7）
  2) 粉噪只铺 min(total,120)s，后 7 分钟纯干声
  3) 旁白 24k 单声道、输出也 24k mono（规范 48k/stereo）
  4) 无响度归一（-27.7 LUFS，平台标准 -16~-14）

做法按「stem 分开→合轨→两遍 loudnorm」，每层可单独回听、单独换。
依据：OpenMontage sound-design.md（平台 LUFS/TP 表、TTS 处理链、duck 表）
      remotion sound-design.md（三层电平、钉帧规则、机枪感禁令）
      hkuds cli-anything sound-design.md（分 stem、混音复核要 ebur128+highpass 查嘶声）

用法：
  python3 tools/mix_audio.py --src out/video/Dafeiyu_Core_Documentary_v17.mp4 \
      --out out/video/Dafeiyu_Core_Documentary_v18.mp4
  # 试片（只做前 30 秒，不重编码视频）：
  python3 tools/mix_audio.py --src ...v17.mp4 --dur 30 --out out/video/preview30.mp4
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / "video"
MIX = ROOT / "out" / "tmp" / "mix"
LIB = Path.home() / ".dsh" / "drawai-assets" / "v1" / "media-library" / "lib" / "audio" / "samples"

# 章首卡林巴（音高错开），结尾钟琴
KAL = LIB / "kalimba"
GLO = LIB / "glock"
KAL_FILES = [
    "MBira3_pluck_Main_C#5_k24_50_100_rr2.flac",
    "MBira3_pluck_Main_A#4_k2_50_100_rr2.flac",
    "MBira3_pluck_Main_E5_k25_50_100_rr2.flac",
    "MBira3_pluck_Main_B4_k23_50_100_rr2.flac",
    "MBira3_pluck_Main_C#4_k5_50_100_rr2.flac",
]
GLO_FILE = "glock_medium_C6_01.flac"


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write((r.stderr or "")[-3000:])
        sys.exit(f"✗ 失败：{' '.join(str(c) for c in cmd[:6])}…")
    return r


def dur_of(p):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]
    ).decode().strip())


def mean_db(p):
    """量一段音频的平均电平（volumedetect mean），用于层间相对校准"""
    r = subprocess.run(["ffmpeg", "-nostats", "-i", str(p), "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", r.stderr or "")
    return float(m.group(1)) if m else -99.0


def chapters():
    data = json.loads((OUT / "shots.json").read_text(encoding="utf-8"))
    return [round(float(s["start"]), 2) for s in data["shots"] if s.get("layout") == "chapter"]


def gen_sfx(d):
    """本地合成三种音效（无第三方依赖；参数写成常量，改一处就换性格）"""
    d.mkdir(parents=True, exist_ok=True)
    specs = {
        # 落定：55Hz 低频 + 闷噪声，0.8s 衰减
        "impact.wav": [
            "-f", "lavfi", "-i", "sine=f=52:d=0.9:r=48000",
            "-f", "lavfi", "-i", "anoisesrc=d=0.35:c=brown:r=48000:a=0.6",
            "-filter_complex",
            "[0:a]afade=t=out:st=0.04:d=0.85,volume=0.85[low];"
            "[1:a]lowpass=f=320,afade=t=out:st=0:d=0.30,volume=0.5[noi];"
            "[low][noi]amix=inputs=2:duration=longest:normalize=0,"
            "alimiter=limit=0.68[a]",
            "-map", "[a]",
        ],
        # 转场：粉噪带限 + 15/35 包络，0.6s
        "whoosh.wav": [
            "-f", "lavfi", "-i", "anoisesrc=d=0.60:c=pink:r=48000:a=0.8",
            "-af", "highpass=f=520,lowpass=f=4300,"
                   "afade=t=in:st=0:d=0.16,afade=t=out:st=0.18:d=0.42,volume=0.6",
        ],
        # 起势：1.8s 噪声渐强（t/d 平方曲线）
        "riser.wav": [
            "-f", "lavfi", "-i", "anoisesrc=d=1.80:c=pink:r=48000:a=0.7",
            "-af", "highpass=f=280,lowpass=f=6200,"
                   "volume='(t/1.8)*(t/1.8)':eval=frame,volume=0.75",
        ],
    }
    for name, args in specs.items():
        p = d / name
        if not p.exists():
            run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args + [str(p)])
    return d


def stem_vo(voice, out, args):
    """旁白链：HPF 80 / 500Hz 去闷 / 3kHz 提清晰 / 3:1 压缩 / 48k stereo"""
    af = (
        "aresample=48000,"
        "highpass=f=80,"
        f"equalizer=f=500:t=q:w=1.0:g={args.eq_mud},"
        f"equalizer=f=3000:t=q:w=1.4:g={args.eq_presence},"
        f"acompressor=threshold={args.comp_thr}dB:ratio=3:attack=6:release=90:makeup=2,"
        "aformat=channel_layouts=stereo"
    )
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(voice), "-af", af, "-c:a", "pcm_f32le", str(out)])
    return out


def stem_amb(total, out, vo_mean, rel_db):
    """底噪：粉噪全片（不再只铺 120s），按「比旁白低 rel_db」自动校准
    （2026-11-18 实测：写死 -33dB 时实际只有 -58.7dB，等于没铺——数字不能拍）"""
    raw = out.with_name(out.stem.replace("amb", "amb-raw") + ".wav")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", f"anoisesrc=d={total:.2f}:c=pink:r=48000:a=0.5",
         "-af", "highpass=f=35,lowpass=f=7000,aformat=channel_layouts=stereo",
         "-c:a", "pcm_f32le", str(raw)])
    g = (vo_mean - rel_db) - mean_db(raw)
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(raw), "-af", f"volume={g:.2f}dB", "-c:a", "pcm_f32le", str(out)])
    print(f"  amb 校准: 裸 {mean_db(raw):.1f}dB + {g:.1f}dB → 目标 {vo_mean - rel_db:.1f}dB")
    return out


def stem_sfx(total, out, sfx_dir, args):
    """音效轨：章节点（riser + 卡林巴）+ 结尾（riser + 钟琴）。全片 SFX 克制，不逐镜打。"""
    marks = chapters()[: len(KAL_FILES)]
    inputs, filters, mix_in = [], [], []
    idx = 0

    def add(src, delay_s, gain_db, fade_in=0.0, fade_out=0.0):
        nonlocal idx
        d = dur_of(src)
        inputs.extend(["-i", str(src)])
        chain = [f"aresample=48000", "aformat=channel_layouts=stereo"]
        ms = max(0, int(round(max(0.0, delay_s) * 1000)))
        if fade_in:
            chain.append(f"afade=t=in:st=0:d={fade_in}")
        if fade_out:
            chain.append(f"afade=t=out:st={max(0.0, d - fade_out):.3f}:d={fade_out}")
        chain.append(f"volume={gain_db}dB")
        chain.append(f"adelay={ms}|{ms}")
        filters.append(f"[{idx}:a]" + ",".join(chain) + f"[s{idx}]")
        mix_in.append(f"[s{idx}]")
        idx += 1

    riser = sfx_dir / "riser.wav"
    impact = sfx_dir / "impact.wav"
    for i, m in enumerate(marks):
        add(riser, m - 1.8, args.sfx_db - 4, 0.0, 0.0)
        add(KAL / KAL_FILES[i], m, args.sfx_db, 0.0, 1.2)
    # 结尾：riser → 钟琴
    add(riser, max(0, total - 2.0 - 1.8), args.sfx_db - 4, 0.0, 0.0)
    add(GLO / GLO_FILE, max(0, total - 2.0), args.sfx_db - 2, 0.0, 2.0)

    n = len(mix_in)
    filters.append("".join(mix_in) +
                   f"amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0,"
                   f"apad,atrim=0:{total:.2f}[sfx]")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + inputs + [
        "-filter_complex", ";".join(filters), "-map", "[sfx]",
        "-c:a", "pcm_f32le", str(out)]
    run(cmd)
    return out


def mixdown(vo, amb, sfx, total, out):
    """合轨：normalize=0（这是 v17 掉 6dB 的根因）"""
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(vo), "-i", str(amb), "-i", str(sfx),
         "-filter_complex",
         f"[0:a]apad,atrim=0:{total:.2f}[v];"
         f"[1:a]atrim=0:{total:.2f}[b];"
         f"[2:a]atrim=0:{total:.2f}[s];"
         f"[v][b][s]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[a]",
         "-map", "[a]", "-c:a", "pcm_f32le", str(out)])
    return out


def measure_loud(mix_wav, args):
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(mix_wav),
         "-af", f"loudnorm=I={args.lufs}:TP={args.tp}:LRA={args.lra}:print_format=json",
         "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        sys.exit("✗ loudnorm 第一遍没拿到 JSON")
    return json.loads(m.group(0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--voice", default=str(OUT / "voice.mp3"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--dur", type=float, default=0, help="只做前 N 秒（试片）")
    ap.add_argument("--lufs", default="-16")
    ap.add_argument("--tp", default="-1.5")
    ap.add_argument("--lra", default="9")
    ap.add_argument("--amb-rel", type=float, default=20.0, help="底噪比旁白低多少 dB")
    ap.add_argument("--sfx-db", type=float, default=-16.0)
    ap.add_argument("--eq-mud", default="-2.0")
    ap.add_argument("--eq-presence", default="2.5")
    ap.add_argument("--comp-thr", default="-18")
    ap.add_argument("--no-sfx", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_absolute():
        src = ROOT / args.src
    voice = Path(args.voice)
    if not voice.is_absolute():
        voice = ROOT / args.voice
    for p in (src, voice):
        if not p.exists():
            sys.exit(f"✗ 没有文件：{p}")

    total = dur_of(src)
    if args.dur:
        total = min(total, args.dur)
    MIX.mkdir(parents=True, exist_ok=True)
    tag = "pilot" if args.dur else "full"

    sfx_dir = gen_sfx(ROOT / "out" / "tmp" / "sfx")

    v = stem_vo(voice, MIX / f"vo-{tag}.wav", args)
    b = stem_amb(total, MIX / f"amb-{tag}.wav", mean_db(v), args.amb_rel)
    if args.no_sfx:
        s = MIX / f"sfx-silent-{tag}.wav"
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={total:.2f}",
             "-c:a", "pcm_f32le", str(s)])
    else:
        s = stem_sfx(total, MIX / f"sfx-{tag}.wav", sfx_dir, args)
    m = mixdown(v, b, s, total, MIX / f"mix-{tag}.wav")

    meas = measure_loud(m, args)
    ln = (f"loudnorm=I={args.lufs}:TP={args.tp}:LRA={args.lra}:"
          f"measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:"
          f"measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:"
          f"offset={meas['target_offset']}:print_format=summary")

    # 视频流直接 copy，不重编码；只换音轨
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", str(src), "-i", str(m), "-map", "0:v:0", "-map", "1:a:0",
           "-c:v", "copy", "-af", ln, "-c:a", "aac", "-b:a", "192k",
           "-ar", "48000", "-ac", "2"]
    if args.dur:
        cmd += ["-t", f"{total:.2f}"]
    cmd += ["-movflags", "+faststart", str(ROOT / args.out if not Path(args.out).is_absolute() else args.out)]
    run(cmd)

    # 复核（交付前必看这三条）
    out_p = Path(args.out) if Path(args.out).is_absolute() else ROOT / args.out
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(out_p),
                        "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    tail = (r.stderr or "").strip().splitlines()[-6:]
    print("stem:", v.name, b.name, s.name)
    print("mix 前:", meas["input_i"], "LUFS /", meas["input_tp"], "dBTP")
    print("\n".join(tail))
    print(f"✅ {out_p}  {out_p.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
