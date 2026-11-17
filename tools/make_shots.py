#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_shots.py —— 把口播稿切成镜头，逐镜渲染真实画面（不留占位图）

读 out/video/timing.json（gen_ass.py 产出，含逐句 start/end/text）
出 out/video/shots/001.png ... 和 out/video/shots.json（给 build_video_shots.py 用）

版式：chapter 章节 / data 大数字 / compare 对比 / quote 引语 / terminal 终端
      paper 论文 / list 清单 / text 大字 / （每 3 镜有 1 镜带立绘）

用法：python3 tools/make_shots.py [--preview]
"""
import argparse
import json
import random
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "out" / "video"
SHOTDIR = OUTDIR / "shots"
CHARDIR = OUTDIR / "chars"
TIMING = OUTDIR / "timing.json"
FONT = ROOT / "assets" / "fonts" / "NotoSansCJK-Regular.ttc"
GIRL = ROOT / "assets" / "yingning-girl.png"

W, H = 1920, 1080
COLD = dict(top=(11, 15, 20), bot=(21, 28, 38), accent=(127, 178, 255),
            title=(232, 237, 245), sub=(120, 136, 158), line=(50, 62, 80))
WARM = dict(top=(23, 15, 8), bot=(45, 29, 14), accent=(255, 176, 32),
            title=(245, 236, 222), sub=(150, 122, 92), line=(78, 58, 36))

# 真实存在、可复验的命令（终端版式只用这些，不编日志）
TERM_LINES = [
    ("node tools/rule-diff.mjs --score", "动作桶 14/14"),
    ("node tools/handover-check.mjs --lite", "5 项全绿"),
    ("node tools/reflex-audit.mjs", "先查再改"),
    ("node tools/memory-lint.mjs --line", "无标条数"),
    ("node tools/reason-first.mjs \"问题\"", "查现成解"),
    ("python3 tools/gen_ass.py", "2032 字 → ASS"),
]


FONT_INDEX = 2   # 这个 ttc 的 0 是日文字面，2 才是简体中文（「令/直/骨」字形不同）


def F(size, index=FONT_INDEX):
    return ImageFont.truetype(str(FONT), size, index=index)


def wrap(draw, text, font, maxw):
    """按像素宽度折行（中文按字断）。"""
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) <= maxw:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    for i in range(1, len(lines)):
        while lines[i] and lines[i][0] in "，。、；：！？）」』":
            lines[i - 1] += lines[i][0]
            lines[i] = lines[i][1:]
    return lines


def gradient(theme):
    """现在是透明画布：底色/纹理交给 assets/bg 的动态视频。"""
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


_PLATE = None


def overlay_texture(img):
    """文字安全区：中间压一层柔和的暗，动态背景下字不飘。"""
    global _PLATE
    if _PLATE is None:
        mask = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(mask)
        d.rounded_rectangle([180, 200, W - 180, 700], radius=80, fill=200)
        _PLATE = mask.filter(ImageFilter.GaussianBlur(70))
    dark = Image.new("RGBA", (W, H), (4, 6, 9, 255))
    dark.putalpha(_PLATE.point(lambda v: int(v * 0.30)))
    return Image.alpha_composite(img.convert("RGBA"), dark)


def header(d, theme, label):
    d.line([(90, 96), (90, 96 + 34)], fill=theme["accent"], width=4)
    d.text((112, 96), label, font=F(28), fill=theme["sub"])


def char_layer(side="right", height=700, alpha=242):
    return paste_girl(Image.new("RGBA", (W, H), (0, 0, 0, 0)), side, height, alpha)


def paste_girl(img, side="right", height=700, alpha=255):
    girl = Image.open(GIRL).convert("RGBA")
    w = int(girl.width * height / girl.height)
    girl = girl.resize((w, height), Image.LANCZOS)
    if side == "left":
        girl = girl.transpose(Image.FLIP_LEFT_RIGHT)
    x = (W - 40 - w) if side == "right" else 40
    y = H - height + 42
    # 柔和落地影
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(shadow)
    ds.ellipse([x + 30, H - 90, x + w - 30, H + 40], fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    img = Image.alpha_composite(img, shadow)
    if alpha < 255:
        a = girl.getchannel("A").point(lambda v: v * alpha // 255)
        girl.putalpha(a)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(girl, (x, y), girl)
    return Image.alpha_composite(img, layer)


def fit_font(draw, text, maxw, start, minimum=48):
    size = start
    while size > minimum and draw.textlength(text, font=F(size)) > maxw:
        size -= 4
    return F(size)


NUM_RE = re.compile(r"[\d一二三四五六七八九十百千万亿.]+\s*(?:token|亿|万|条|%|秒|分钟|字|小时)")


def numbers_in(text):
    """只认硬数字：带阿拉伯数字，或「亿/万」级的中文数。
    「一次」「两处」「一个抽屉」这类不算——那是量词，不是账。"""
    out = []
    for m in NUM_RE.finditer(text):
        s = m.group(0).strip()
        num = re.sub(r"(token|亿|万|条|%|秒|分钟|字|小时)$", "", s).strip()
        if re.search(r"\d", num) or "亿" in s or "万" in s:
            out.append(s)
    return out


def head(text, n=16):
    """取一句里的头一段，太长的在标点处截断。"""
    parts = re.split(r"[，。：；！？、—]", text)
    out = parts[0]
    for p in parts[1:]:
        if len(out) + len(p) <= n:
            out += "，" + p
        else:
            break
    return out[:n]


def load_real():
    """从本地真文件取画面素材：CORE 条文、错误库、journal、脚本头。不编内容。"""
    def read(p, n=6, skip_empty=True):
        try:
            lines = Path(p).read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
        out = [l.rstrip() for l in lines if l.strip()] if skip_empty else [l.rstrip() for l in lines]
        return out[:n]

    docs = []
    core = read(ROOT / "CORE.md", 60)
    if core:
        for i, l in enumerate(core):
            if l.startswith("## 事实是根"):
                docs.append(("CORE.md", [x for x in core[i:i + 5]]))
                break
    err = read(ROOT / "notes" / "错误库触发卡.md", 8)
    if err:
        docs.append(("错误库触发卡.md", err[4:8] or err[:4]))
    jour = sorted((ROOT / "journal").glob("2026-11-*.md"))
    if jour:
        docs.append((jour[-1].name, read(jour[-1], 6)[:4]))
    rule = read(ROOT / "notes" / "规矩-例子库.md", 8)
    if rule:
        docs.append(("规矩-例子库.md", rule[2:6] or rule[:4]))
    docs = [d for d in docs if len(d[1]) >= 3]

    codes = []
    for name in ("rule-diff.mjs", "handover-check.mjs", "reflex-audit.mjs"):
        p = ROOT / "tools" / name
        ls = read(p, 40)
        body = [x for x in ls if x.strip().startswith(("const", "//", "export", "function"))][:6]
        if body:
            codes.append((name, body))
    return docs, codes


def r_doc(theme, title, lines):
    img = gradient(theme)
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    box = [230, 170, W - 230, 730]
    d.rounded_rectangle(box, radius=10, fill=(247, 245, 239, 248))
    d.rounded_rectangle([box[0], box[1], box[2], box[1] + 56], radius=10, fill=(232, 228, 219, 250))
    d.text((box[0] + 28, box[1] + 14), title, font=F(26), fill=(90, 88, 84))
    for k, c in enumerate([(206, 90, 84)]):
        d.ellipse([box[2] - 46, box[1] + 18, box[2] - 26, box[1] + 38], fill=c)
    y = box[1] + 70
    f = F(32)
    for ln in lines[:3]:
        t = re.sub(r"[#*`>_]+", "", ln).strip(" -—")
        if not t:
            continue
        for sub in wrap(d, t, f, box[2] - box[0] - 120)[:2]:
            d.text((box[0] + 60, y), sub, font=f, fill=(44, 42, 40))
            y += 56
        y += 10
    return Image.alpha_composite(img.convert("RGBA"), lay)


def r_code(theme, name, lines):
    img = gradient(theme)
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    box = [180, 180, W - 180, 690]
    d.rounded_rectangle(box, radius=16, fill=(12, 16, 24, 240), outline=(*theme["line"], 255), width=2)
    d.text((box[0] + 34, box[1] + 20), f"{name}", font=F(26), fill=(120, 170, 220))
    y = box[1] + 70
    for i, ln in enumerate(lines):
        d.text((box[0] + 34, y), f"{i + 1:>2}", font=F(26), fill=(70, 84, 104))
        col = (158, 226, 168) if ln.strip().startswith("//") else (214, 222, 235)
        txt, f = ln.strip(), F(30)
        maxw = box[2] - box[0] - 150
        while txt and d.textlength(txt, font=f) > maxw:
            txt = txt[:-1]
        if txt != ln.strip():
            txt = txt[:-1] + "…"
        d.text((box[0] + 96, y), txt, font=f, fill=col)
        y += 58
    return Image.alpha_composite(img.convert("RGBA"), lay)


def r_timeline(theme, ticks, cursor=-1):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "时间线")
    y = 500
    d.line([(180, y), (W - 180, y)], fill=theme["line"], width=4)
    n = max(1, len(ticks))
    for i, (label, tag) in enumerate(ticks):
        x = 180 + (W - 360) * (i / (n - 1) if n > 1 else 0)
        on = (cursor < 0 and i == n - 1) or i == cursor
        r = 14 if on else 9
        d.ellipse([x - r, y - r, x + r, y + r], fill=theme["accent"] if on else theme["line"])
        f = F(32 if not on else 38)
        d.text((x - 40, y + 46), label, font=f, fill=theme["title"] if on else theme["sub"])
        if tag:
            d.text((x - 40, y - 90), tag, font=F(30), fill=theme["accent"] if on else theme["sub"])
    return img


def r_diagram(theme, nodes, title):
    """结构图：三块盒子 + 连线，用来讲骨架/抽屉/断舍离。"""
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, title)
    n = min(3, len(nodes))
    bw, bh, gap = 420, 160, 80
    total = n * bw + (n - 1) * gap
    x0 = (W - total) // 2
    for i, (nt, nt_sub) in enumerate(nodes[:n]):
        x = x0 + i * (bw + gap)
        y = 380
        d.rounded_rectangle([x, y, x + bw, y + bh], radius=14,
                            outline=theme["accent"] if i == 0 else theme["line"], width=3)
        d.text((x + 28, y + 30), nt[:10], font=F(40), fill=theme["title"])
        if nt_sub:
            d.text((x + 28, y + 92), nt_sub[:14], font=F(26), fill=theme["sub"])
        if i < n - 1:
            d.line([(x + bw + 12, y + bh // 2), (x + bw + gap - 12, y + bh // 2)],
                   fill=theme["line"], width=3)
    return img


def r_dots(theme, count, label):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "记忆库")
    d.text((140, 300), f"{count} 条", font=F(96), fill=theme["accent"])
    d.text((146, 420), label, font=F(32), fill=theme["sub"])
    rnd = random.Random(7)
    showing = min(int(count), 140) if count < 1000 else 140
    for i in range(showing):
        cx = 200 + (i % 28) * 58
        cy = 540 + (i // 28) * 58
        rr = 9 + rnd.randint(0, 4)
        col = theme["accent"] if rnd.random() < 0.12 else (*theme["line"], 255)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col)
    return img
def r_chapter(theme, num, title, tag):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    d.text((100, 300), num, font=F(380), fill=(*theme["line"], 1))
    f = F(96)
    d.text((140, 430), title, font=f, fill=theme["title"])
    d.line([(146, 570), (146 + 420, 570)], fill=theme["accent"], width=6)
    d.text((140, 600), tag, font=F(34), fill=theme["sub"])
    return img


def r_data(theme, hero, unit, note):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "大肥鱼 Core")
    f = fit_font(d, hero, 1500, 300, 120)
    tw = d.textlength(hero, font=f)
    d.text((W // 2 - tw / 2, 330), hero, font=f, fill=theme["accent"])
    if unit:
        uf = F(56)
        if unit.strip().lower() == "token":
            try:
                uf = ImageFont.truetype("/system/fonts/DroidSansMono.ttf", 56)
            except Exception:
                pass
        d.text((W // 2 + tw / 2 + 16, 330 + f.size * 0.62), unit, font=uf, fill=theme["sub"])
    d.line([(W // 2 - 160, 650), (W // 2 + 160, 650)], fill=theme["line"], width=3)
    fn = F(44)
    for i, ln in enumerate(wrap(d, note, fn, 1200)[:2]):
        w2 = d.textlength(ln, font=fn)
        d.text((W // 2 - w2 / 2, 690 + i * 56), ln, font=fn, fill=theme["title"])
    return img


CN = {c: i for i, c in enumerate("零一二三四五六七八九")}
UNIT = {"十": 10, "百": 100, "千": 1000, "万": 10000, "亿": 100000000}


def cn2num(s):
    """把「八十亿」「二十二亿」「二十亿三千万」换成数，用来算条形长度。"""
    s = s.replace("token", "").strip()
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in CN:
            num = CN[ch]
        elif ch in UNIT:
            u = UNIT[ch]
            if u >= 10000:
                section = (section + num) * u
                total += section
                section, num = 0, 0
            else:
                section += (num or 1) * u
                num = 0
    return total + section + num or 1


def r_compare(theme, a_label, a_val, a_frac, b_label, b_val, b_frac):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "大肥鱼 Core · 对账")
    for i, (lab, val, frac) in enumerate((("他以为", a_val, a_frac), ("实际跑的", b_val, b_frac))):
        y = 300 + i * 220
        d.text((160, y), lab, font=F(38), fill=theme["sub"])
        fv = fit_font(d, val, 900, 110, 70)
        d.text((160, y + 56), val, font=fv, fill=theme["title"] if i else theme["sub"])
        bw = int(1100 * frac)
        d.rounded_rectangle([160, y + 196, 160 + bw, y + 226], radius=16,
                            fill=theme["line"] if i else theme["accent"])
    return img


def r_quote(theme, quote, who):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "原话")
    d.text((150, 210), "“", font=F(190), fill=theme["accent"])
    f = F(78)
    y = 420
    for ln in wrap(d, quote, f, 1200)[:4]:
        d.text((200, y), ln, font=f, fill=theme["title"])
        y += 108
    d.text((200, y + 40), f"— {who}", font=F(40), fill=theme["sub"])
    return img


def r_terminal(theme, pair):
    img = gradient(theme)
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    box = [180, 190, W - 180, 690]
    d.rounded_rectangle(box, radius=18, fill=(8, 10, 14, 225), outline=(*theme["line"], 255), width=2)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([box[0] + 28 + i * 34, box[1] + 24, box[0] + 46 + i * 34, box[1] + 42], fill=c)
    cmd, note = pair
    d.text((box[0] + 40, box[1] + 90), "$ " + cmd, font=F(40), fill=(158, 226, 168))
    d.text((box[0] + 40, box[1] + 170), "→ " + note, font=F(36), fill=theme["sub"])
    d.line([(box[0] + 40, box[1] + 236), (box[2] - 40, box[1] + 236)], fill=(*theme["line"], 180), width=2)
    d.text((box[0] + 40, box[1] + 270), "全部可复验：跑一次就知道绿不绿", font=F(32), fill=(*theme["sub"], 220))
    return Image.alpha_composite(img.convert("RGBA"), lay)


def r_paper(theme, arxiv_id, claim):
    img = gradient(theme)
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    box = [220, 170, W - 220, 760]
    d.rounded_rectangle(box, radius=8, fill=(248, 246, 241, 250))
    d.text((box[0] + 56, box[1] + 38), "arXiv:" + arxiv_id, font=F(27), fill=(105, 105, 105))
    d.line([(box[0] + 56, box[1] + 92), (box[2] - 56, box[1] + 92)], fill=(210, 205, 195), width=2)
    f = F(44)
    lines = wrap(d, claim, f, box[2] - box[0] - 120)[:5]
    y = box[1] + 120
    for ln in lines:
        d.text((box[0] + 56, y), ln, font=f, fill=(38, 38, 38))
        y += 74
    d.line([(box[0] + 56, box[3] - 96), (box[2] - 56, box[3] - 96)], fill=(222, 217, 208), width=2)
    d.text((box[0] + 56, box[3] - 74), f"arxiv.org/abs/{arxiv_id}", font=F(26), fill=(140, 136, 130))
    d.text((box[2] - 200, box[3] - 74), "preprint", font=F(26), fill=(160, 155, 148))
    return Image.alpha_composite(img.convert("RGBA"), lay)


def r_list(theme, title, items):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, title)
    y = 300
    for i, it in enumerate(items[:4]):
        d.text((170, y), f"{i + 1:02d}", font=F(54), fill=theme["accent"])
        f = F(54)
        for ln in wrap(d, it, f, 1250)[:2]:
            d.text((280, y), ln, font=f, fill=theme["title"])
            y += 74
        y += 56
    return img


def r_text(theme, line):
    img = gradient(theme)
    d = ImageDraw.Draw(img)
    header(d, theme, "大肥鱼 Core")
    # 背景幽灵字：只做质感，不抢字幕
    ghost = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dg = ImageDraw.Draw(ghost)
    kw = line[0]
    fg = F(420)
    dg.text((W - 620, 150), kw, font=fg, fill=(*theme["line"], 20))
    img = Image.alpha_composite(img.convert("RGBA"), ghost)
    d = ImageDraw.Draw(img)
    f = fit_font(d, line, 1200, 110, 56)
    y = 340
    for ln in wrap(d, line, f, 1200)[:3]:
        d.text((150, y), ln, font=f, fill=theme["title"])
        y += int(f.size * 1.35)
    d.line([(154, y + 30), (154 + 120, y + 30)], fill=theme["accent"], width=6)
    return img


def fg_art(theme, text):
    """前景意象层：讲到什么，背景里就有个半透明的线框意象。"""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    line = (*theme["line"], 90)
    acc = (*theme["accent"], 110)
    if "抽屉" in text:
        x0, y0, x1, y1 = int(W * 0.60), int(H * 0.34), int(W * 0.90), int(H * 0.80)
        d.rectangle([x0, y0, x1, y1], outline=line, width=4)
        d.rectangle([x0 + 10, y0 + 10, x1 - 10, y1 - 10], outline=(*line[:3], 50), width=2)
        cy = (y0 + y1) // 2
        d.line([(x0, cy), (x1, cy)], fill=line, width=4)
        d.rounded_rectangle([(x0 + x1) // 2 - 40, cy - 12, (x0 + x1) // 2 + 40, cy + 12],
                            radius=10, outline=acc, width=3)
    elif any(k in text for k in ("报纸", "账单", "账本", "记账")):
        for k, (dx, dy) in enumerate(((0, 0), (36, 26), (72, 52))):
            x0, y0 = int(W * 0.58) + dx, int(H * 0.30) + dy
            d.rectangle([x0, y0, x0 + 320, y0 + 400], outline=(*line[:3], 70 - k * 15), width=3,
                        fill=(255, 255, 255, 6))
            for ln in range(6):
                d.line([(x0 + 24, y0 + 60 + ln * 44), (x0 + 296, y0 + 60 + ln * 44)],
                       fill=(*line[:3], 55), width=2)
    elif any(k in text for k in ("骨架", "结构", "节点", "记忆库", "检索")):
        import math
        cx, cy = int(W * 0.74), int(H * 0.52)
        pts = [(cx + int(190 * math.cos(a)), cy + int(150 * math.sin(a)))
               for a in [i * math.pi / 3 for i in range(6)]]
        for k, (px, py) in enumerate(pts):
            d.line([(cx, cy), (px, py)], fill=line, width=2)
            for j in range(k + 1, len(pts)):
                if (k + j) % 3 == 0:
                    d.line([(px, py), pts[j]], fill=(*line[:3], 40), width=1)
        for px, py in pts:
            d.ellipse([px - 7, py - 7, px + 7, py + 7], fill=acc)
        d.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=(*theme["accent"], 160))
    return img


# ---------- 切镜与指派 ----------
DOC_TAGS = {
    "CORE.md": ["事实", "规矩", "指令", "红线", "判断", "CORE"],
    "错误库触发卡.md": ["错", "坑", "教训", "防", "失败"],
    "规矩-例子库.md": ["例子", "触发", "规矩"],
}
CODE_TAGS = {
    "rule-diff.mjs": ["检验", "回滚", "改动", "差测", "规矩", "改坏"],
    "handover-check.mjs": ["搬家", "核", "交接", "清单"],
    "reflex-audit.mjs": ["查", "错", "第一动作"],
}


def best_match(cands, tags, text):
    best, score = None, 0
    for name, lines in cands:
        key = name if name in tags else next((k for k in tags if k in name), None)
        sc = sum(text.count(t) for t in tags.get(key, []))
        if sc > score:
            best, score = (name, lines), sc
    return best, score


def pick_layout(text, first, section_title, idx):
    if first and idx > 0:
        return "chapter"
    t = text
    if any(k in t for k in ("论文", "arXiv", "文献", "preprint")):
        return "paper"
    nums = numbers_in(t)
    if len(nums) >= 2 and sum(1 for n in nums if "亿" in n) >= 2:
        return "compare"
    if any(k in t for k in ("他说", "他问", "他回", "他答", "只回了我", "他讲")):
        return "quote"
    if any(k in t for k in ("骨架", "结构", "抽屉", "断舍离", "根目录", "目录")):
        return "diagram"
    if re.search(r"(十月|十一月|十二月|今天|那晚|第二天|今年)", t) and re.search(r"(号|天|晚|月)", t):
        return "timeline"
    if any(k in t for k in ("脚本", "代码", "工具", "命令", "审计", "仓库", "配置", "插件")):
        return "code"
    if any(k in t for k in ("记", "账", "写", "标题", "规矩", "文档", "CORE", "本子")):
        return "doc"
    if nums:
        return "data"
    return "text"


HIGHLIGHT_WORDS = ["八十亿", "二十亿", "五十二亿", "八个版本", "14/14", "事实为根",
                   "不返工", "情报不全", "可核可驳", "没验", "主体性", "三条红线",
                   "一次改完", "自己走下一步"]

ARXIV = ["2610.25858", "2602.09789", "2601.06007", "2607.19257", "2610.15093"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="只渲前 12 个镜头看效果")
    args = ap.parse_args()

    tj = json.loads(TIMING.read_text(encoding="utf-8"))
    items = tj["items"]
    sections = tj["sections"]

    def section_of(t):
        for i, s in enumerate(sections):
            if s["start"] - 0.01 <= t < s["end"]:
                return i
        return len(sections) - 1

    shots, cur = [], None
    for it in items:
        sec = section_of(it["start"])
        if cur is None:
            cur = dict(items=[it], start=it["start"], end=it["end"], sec=sec)
            continue
        dur = it["end"] - cur["start"]
        if sec != cur["sec"] or (dur >= 6.4) or (dur >= 5.0 and len(cur["items"]) >= 2):
            shots.append(cur)
            cur = dict(items=[it], start=it["start"], end=it["end"], sec=sec)
        else:
            cur["items"].append(it)
            cur["end"] = it["end"]
    if cur:
        shots.append(cur)

    # 镜头必须首尾相接：句子之间 0.18s 的停顿也算进画面，
    # 否则总时长会比配音短，字幕会后段错位、末尾整个丢。
    for i in range(len(shots) - 1):
        shots[i]["end"] = shots[i + 1]["start"]
    shots[-1]["end"] = tj["total"]

    SHOTDIR.mkdir(parents=True, exist_ok=True)
    for old in list(SHOTDIR.glob("*.png")) + list((OUTDIR / "chars").glob("*.png")):
        old.unlink()

    docs, codes = load_real()
    plan, girl_n, paper_i, term_i, doc_i, code_i, over = [], 0, 0, 0, 0, 0, []
    tl_ticks = [("10-30", "第一次过夜"), ("11-05", "八十亿"), ("11-16", "全权放权"), ("11-17", "出片")]
    for i, s in enumerate(shots):
        text = "".join(x["text"] for x in s["items"])
        sec = s["sec"]
        theme = WARM if sec >= 4 else COLD
        first = i == 0 or shots[i - 1]["sec"] != sec
        headline = s["items"][0]["text"]
        if i == 0:
            text = headline
            layout = "text"
        else:
            layout = pick_layout(text, first, sections[sec]["title"], i)

        if layout == "chapter":
            img = r_chapter(theme, f"0{sec + 1}", sections[sec]["title"],
                            "CORE DOCUMENTARY · 大肥鱼")
        elif layout == "paper":
            m = re.search(r"(?:26\d{2}|24\d{2})\.\d{4,5}", text)
            pid = m.group(0) if m else ARXIV[paper_i % len(ARXIV)]
            claim = re.sub(r"arXiv\s*\d{4}\.\d{4,5}\s*[，,：:]?", "", text).strip()
            img = r_paper(theme, pid, claim)
            paper_i += 1
        elif layout == "compare":
            nums = numbers_in(text)
            a, b = nums[0], nums[1]
            na, nb = cn2num(a), cn2num(b)
            img = r_compare(theme, "", a, na / max(na, nb), "", b, nb / max(na, nb))
        elif layout == "terminal":
            img = r_terminal(theme, TERM_LINES[term_i % len(TERM_LINES)])
            term_i += 1
        elif layout == "code" and codes:
            hit, sc = best_match(codes, CODE_TAGS, text)
            if sc:
                img = r_code(theme, hit[0], hit[1])
            else:
                img = r_text(theme, headline)
            code_i += 1
        elif layout == "doc" and docs:
            hit, sc = best_match(docs, DOC_TAGS, text)
            if sc:
                img = r_doc(theme, hit[0], hit[1])
            else:
                img = r_text(theme, headline)
            doc_i += 1
        elif layout == "diagram":
            nodes = [("抽屉", "空的"), ("账本", "哪一步"), ("结构", "留下")]
            img = r_diagram(theme, nodes, "结构")
        elif layout == "timeline":
            cur = -1
            for k, (lab, _) in enumerate(tl_ticks):
                if lab.replace("-", "")[-2:] in text or lab[3:] in text:
                    cur = k
            img = r_timeline(theme, tl_ticks, cur)
        elif layout == "quote":
            q = headline.split("：")[-1] if "：" in headline else headline
            img = r_quote(theme, q.strip("，。 "), "用户")
        elif layout == "data":
            hero = max(numbers_in(text), key=len)
            num = re.match(r"[^一二三四五六七八九十百千万亿\d.]+", hero)
            unit = num.group(0) if num else ""
            hero_num = hero[:len(hero) - len(unit)] if unit else hero
            img = r_data(theme, hero_num, unit, headline)
        elif layout == "list":
            parts = [p for p in re.split(r"[，、；]", text) if p][:4]
            img = r_list(theme, "清单", parts) if len(parts) >= 2 else r_text(theme, headline)
        else:
            img = r_text(theme, headline)

        pre = img.getbbox()
        img = overlay_texture(img)
        img = Image.alpha_composite(fg_art(theme, text), img)

        char = None
        if not first and layout in ("text", "data", "quote", "list") and i % 3 == 1:
            char = char_layer("right", 620)   # 锚点写死右侧，不再左右乱跑
            girl_n += 1

        out = SHOTDIR / f"{i + 1:03d}.png"
        img.save(out)                      # 文字/面板层（透明底）
        box = pre
        if box and box[3] > 780:
            over.append((i + 1, layout, box[3], headline[:16]))
        if char is not None:
            CHARDIR.mkdir(parents=True, exist_ok=True)
            char.save(CHARDIR / f"{i + 1:03d}.png")
        big = any(k in headline for k in HIGHLIGHT_WORDS)
        plan.append(dict(i=i, big_title=big, start=round(s["start"], 2), end=round(s["end"], 2),
                         dur=round(s["end"] - s["start"], 2), sec=sec, layout=layout,
                         file=str(out.relative_to(ROOT)), text=head(text, 40)))
        if args.preview and len(plan) >= 12:
            break

    (OUTDIR / ("shots-preview.json" if args.preview else "shots.json")).write_text(
        json.dumps(dict(total=tj["total"], shots=plan), ensure_ascii=False, indent=1),
        encoding="utf-8")
    kinds = {}
    for p in plan:
        kinds[p["layout"]] = kinds.get(p["layout"], 0) + 1
    if over:
        print(f"⚠ {len(over)} 镜内容压到字幕区（>780px）：")
        for n, lay, bottom, txt in over[:8]:
            print(f"   #{n} {lay} 到 {bottom}px  {txt}")
    else:
        print("✓ 无内容压字幕区")
    print(f"✓ {len(plan)} 镜，立绘 {girl_n} 镜")
    print("  版式分布：" + "  ".join(f"{k}={v}" for k, v in sorted(kinds.items(), key=lambda x: -x[1])))
    print("  →", OUTDIR / ("shots-preview.json" if args.preview else "shots.json"))


if __name__ == "__main__":
    main()
