#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_ass.py —— 金句镜头：画面里已有大号主标题，底部同句字幕就不再重复（淡出隐藏）

只隐藏「本镜第一句而且画面正把它当主标题」的那一条，不藏别的——静音看的人
在普通叙述段仍然有字幕。由 shots.json 的 big_title 标记驱动。

用法：python3 tools/gen_ass.py && python3 tools/patch_ass.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASS = ROOT / "out" / "video" / "subtitles.ass"
SHOTS = ROOT / "out" / "video" / "shots.json"
HIDE = r"{\alpha&HFF&}"


def t2s(t: str) -> float:
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def main():
    shots = json.loads(SHOTS.read_text(encoding="utf-8"))["shots"]
    hide = {round(s["start"], 2) for s in shots if s.get("big_title")}
    if not hide:
        print("没有需要独占的镜头")
        return
    lines = ASS.read_text(encoding="utf-8").splitlines()
    n = 0
    out = []
    for ln in lines:
        if ln.startswith("Dialogue:"):
            parts = ln.split(",", 9)
            if len(parts) >= 10:
                st = round(t2s(parts[1]), 2)
                if st in hide and HIDE not in parts[9]:
                    parts[9] = HIDE + parts[9]
                    ln = ",".join(parts)
                    n += 1
        out.append(ln)
    ASS.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"✓ 金句独占：{n} 条底部字幕隐去（画面里已有同句主标题）")


if __name__ == "__main__":
    main()
