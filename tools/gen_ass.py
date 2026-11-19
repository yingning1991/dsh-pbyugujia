#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_ass.py —— 从定稿口播生成 B 站动态字幕（.ass）
用法：python3 tools/gen_ass.py
输入：notes/2026-11-17-宣发-8分钟微纪录片-定稿.md
输出：out/video/subtitles.ass（1920x1080，可直接导入剪映）

设计要点：
- 章节时间从标题括号里取，章节内按字数比例分配，字幕和分镜表天然对齐。
- 正文逐字「亮起来」（ASS 卡拉OK \\k），高亮金句弹跳放大，警告词转红。
- 字体用 Noto Sans CJK SC（assets/fonts 里已放 ttc；剪映里同名或思源黑体即可）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "notes" / "2026-11-17-宣发-8分钟微纪录片-定稿.md"
OUT = ROOT / "out" / "video" / "subtitles.ass"
TIMING = ROOT / "out" / "video" / "timing.json"

FONT = "Noto Sans CJK SC"
FALLBACK = "Microsoft YaHei"
FS_BODY, FS_EMPH = 64, 76
MARGIN_V = 96   # 字幕下沉到独立暗带里（y≈870 起），画面内容安全线放宽到 800（2026-11-18 主人：字幕总压着图）

# ASS 颜色是 &HAABBGGRR（BGR，不是 RGB）
WHITE = "&H00FFFFFF"
ORANGE = "&H0000B3FF"   # 主人定的橙黄 FFB300
RED = "&H000000FF"      # 纯红 FF0000
DIM = "&H00B0B0B0"      # 未唱的暗灰

HIGHLIGHTS = [
    "八十亿 token", "八十亿", "二十亿三千万", "五十二亿", "两万七千多次", "两百四十七块",
    "八个版本", "三个窗口", "14/14", "无回归", "事实为根", "不返工", "不记账",
    "TurnCost", "Prompt Design at Scale", "Don't Break the Cache",
    "2610.15093", "2607.19257", "2602.09789", "2610.25858", "2601.06007",
    "MRR 0.352", "四十五组", "情报不全", "十四道题", "可核可驳", "情报", "没验", "主体性", "三条红线",
    "一次改完", "自己走下一步",
]
WARNINGS = ["造假", "停不下来", "崩", "失去控制", "白读", "空抽屉"]

HEAD_RE = re.compile(r"^## (开篇|第[一二三四]篇章|结尾)：.*?（(\d+):(\d+) - (\d+):(\d+)）\s*$")


def mmss(m: int, s: int) -> float:
    return m * 60 + s


def load_sections(text: str):
    """返回 [(标题, 起秒, 止秒, [句子...])]"""
    lines = text.splitlines()
    sections, cur = [], None
    for ln in lines:
        m = HEAD_RE.match(ln)
        if m:
            if cur:
                sections.append(cur)
            cur = [m.group(1), mmss(int(m.group(2)), int(m.group(3))),
                   mmss(int(m.group(4)), int(m.group(5))), []]
            continue
        if ln.startswith("# 改动清单"):
            break
        if cur is None:
            continue
        s = ln.strip()
        if not s or s.startswith(">") or s.startswith("|") or s.startswith("#"):
            continue
        if set(s) <= {"-", "*", "_"} and len(s) >= 3:   # markdown 分隔线
            continue
        s = s.replace("**", "").strip()
        if s:
            cur[3].append(s)
    if cur:
        sections.append(cur)
    return sections


def split_sentences(paras):
    """按句末标点切；一句太长再按逗号切，保证单屏不挤。"""
    out = []
    for p in paras:
        for seg in re.split(r"(?<=[。！？])", p):
            seg = seg.strip()
            if not seg:
                continue
            # 纯标点/引号片段（TTS 会报 No readable text）并回上一句
            if not re.search(r"[\u4e00-\u9fa5A-Za-z0-9]", seg):
                if out:
                    out[-1] += seg
                continue
            if len(seg) <= 26:
                out.append(seg)
            else:
                buf = ""
                for piece in re.split(r"(?<=[，；——])", seg):
                    if len(buf) + len(piece) > 26 and buf:
                        out.append(buf)
                        buf = piece
                    else:
                        buf += piece
                if buf:
                    out.append(buf)
    return out


def fmt_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def mark_blocks(sentence: str):
    """把一句话切成 [(文本, 类型)]，类型 body/emph/warn。"""
    tokens = sorted(set(HIGHLIGHTS + WARNINGS), key=len, reverse=True)
    pat = re.compile("(" + "|".join(re.escape(x) for x in tokens) + ")")
    blocks = []
    for part in pat.split(sentence):
        if not part:
            continue
        kind = "emph" if part in HIGHLIGHTS else ("warn" if part in WARNINGS else "body")
        blocks.append([part, kind])
    return blocks


SUB_COLS = 15   # 每行最多 15 字：1920 宽下 15×80=1200px，躲开右侧立绘区（libass 不折中文）


def render_line(sentence: str, start: float, end: float) -> str:
    dur = max(0.6, end - start)
    blocks = mark_blocks(sentence)
    body_chars = sum(len(b[0]) for b in blocks if b[1] == "body") or 1
    # 每个正文字分到的时间（厘秒），高亮/警告块不参与逐字，直接整词出现
    per = int(dur * 100 / body_chars)
    piece, vis = [], 0
    for text, kind in blocks:
        if kind == "emph":
            body = r"{\fscx118\fscy118\t(0,150,\fscx100\fscy100)\c" + ORANGE + r"\b1}"
            for ch in text:
                if vis and vis % SUB_COLS == 0:
                    body += r"\N"
                body += ch
                vis += 1
            body += r"{\c" + WHITE + r"\b0}"
            piece.append(body)
        elif kind == "warn":
            body = r"{\c" + RED + r"\b1}"
            for ch in text:
                if vis and vis % SUB_COLS == 0:
                    body += r"\N"
                body += ch
                vis += 1
            body += r"{\c" + WHITE + r"\b0}"
            piece.append(body)
        else:
            buf = ""
            for ch in text:
                if vis and vis % SUB_COLS == 0:
                    buf += r"\N"
                buf += r"{\k" + str(per) + "}" + ch
                vis += 1
            piece.append(buf)
    return "".join(piece)


def build(sections, timing=None):
    lines = [
        "[Script Info]",
        "; 大肥鱼 Core · 8 分钟微纪录片 · 自动生成",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Body,{FONT},{FS_BODY},{WHITE},{DIM},&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,3,1.5,2,140,470,{MARGIN_V},1",
        f"Style: Emph,{FONT},{FS_EMPH},{ORANGE},&H00204060,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,3.5,1.8,2,140,470,{MARGIN_V},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if timing:
        # 有真实配音时长：一句一条，时间轴完全按声音走
        for it in timing["items"]:
            s_txt, a, b = it["text"], it["start"], it["end"]
            style = "Emph" if any(k in s_txt for k in HIGHLIGHTS) else "Body"
            lines.append(
                f"Dialogue: 0,{fmt_time(a)},{fmt_time(b)},{style},,0,0,0,,{render_line(s_txt, a, b)}"
            )
        return "\n".join(lines) + "\n"

    for title, t0, t1, paras in sections:
        sents = split_sentences(paras)
        total_chars = sum(len(s) for s in sents) or 1
        span = max(1.0, t1 - t0)
        cursor = t0
        for s in sents:
            d = span * len(s) / total_chars
            end = min(t1, cursor + max(0.8, d))
            style = "Emph" if any(k in s for k in HIGHLIGHTS) else "Body"
            lines.append(
                f"Dialogue: 0,{fmt_time(cursor)},{fmt_time(end)},{style},,0,0,0,,{render_line(s, cursor, end)}"
            )
            cursor = end
    return "\n".join(lines) + "\n"


def main():
    if not SRC.exists():
        sys.exit(f"找不到定稿：{SRC}")
    text = SRC.read_text(encoding="utf-8")
    sections = load_sections(text)
    if not sections:
        sys.exit("没解析到章节——检查标题格式「## 开篇：xxx（0:00 - 0:55）」")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    timing = None
    if TIMING.exists():
        import json
        timing = json.loads(TIMING.read_text(encoding="utf-8"))
        print(f"（使用真实配音时间轴：{timing['total']/60:.1f} 分钟）")
    OUT.write_text(build(sections, timing), encoding="utf-8")
    n_sent = sum(len(split_sentences(p)) for _, _, _, p in sections)
    total = sum(t1 - t0 for _, t0, t1, _ in sections)
    print(f"✅ {OUT}  ({n_sent} 句, 覆盖 {total/60:.1f} 分钟)")
    for t, a, b, p in sections:
        print(f"   {t:<6} {fmt_time(a)} → {fmt_time(b)}  {len(split_sentences(p))} 句")


if __name__ == "__main__":
    main()
