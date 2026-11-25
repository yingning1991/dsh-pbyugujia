#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_cover.py —— 用 PIL 直接渲染 B 站封面 1146x717（不依赖浏览器截图）"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
FONT_TTC = ROOT / "assets" / "fonts" / "NotoSansCJK-Regular.ttc"
OUT = ROOT / "assets" / "cover.png"
W, H = 1146, 717

BG = (30, 30, 30)
CODE = (107, 122, 143)
ERR = (255, 59, 59)
WARN = (255, 179, 0)
OK = (34, 197, 94)
WHITE = (255, 255, 255)
ORANGE = (255, 179, 0)


def font(size, index=0):
    return ImageFont.truetype(str(FONT_TTC), size, index=index)


def radial_glow(size, color, alpha=255):
    """小图径向渐变再放大，比逐像素快。"""
    s = 160
    g = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(g)
    for r in range(s // 2, 0, -1):
        a = int(alpha * (1 - r / (s / 2)) ** 2.2)
        d.ellipse([s/2 - r, s/2 - r, s/2 + r, s/2 + r], fill=a)
    g = g.resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(8))
    layer = Image.new("RGBA", (size, size), color + (0,))
    layer.putalpha(g)
    return layer


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 右侧暖光
    glow = radial_glow(760, (255, 170, 80), alpha=170)
    img.paste(glow, (W - 520, -190), glow)

    # 小鱼（半透明，朝右游向暖光）
    fish = Image.new("RGBA", (380, 240), (0, 0, 0, 0))
    # 渐变鱼身
    mask = Image.new("L", (380, 240), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([60, 60, 330, 200], fill=255)
    grad = Image.new("RGBA", (380, 240), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for x in range(380):
        t = x / 380
        gd.line([(x, 0), (x, 240)], fill=(int(255 - 40 * t), int(170 + 60 * t), int(90 + 60 * t), int(60 + 90 * t)))
    fish.paste(grad, (0, 0), mask)
    fd = ImageDraw.Draw(fish)
    # 尾鳍（两片，柔和）
    fd.polygon([(70, 130), (8, 86), (30, 130), (8, 174)], fill=(255, 200, 140, 110))
    # 背鳍
    fd.polygon([(170, 64), (215, 30), (255, 62)], fill=(255, 210, 160, 90))
    # 眼睛
    fd.ellipse([292, 106, 318, 132], fill=(25, 22, 20, 220))
    fd.ellipse([303, 112, 311, 120], fill=(255, 255, 255, 235))
    # 鳃线
    fd.arc([250, 92, 300, 168], 250, 320, fill=(255, 220, 175, 90), width=2)
    img.paste(fish, (W - 440, 168), fish)

    # 左上暗角
    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.rectangle([0, 0, W, H], fill=0)
    for i in range(200):
        vd.rectangle([i, i, W - i, H - i], outline=int(140 * (i / 200)), width=1)

    # 左侧代码
    code_lines = [
        ("$ node tools/core-budget.mjs", CODE),
        ("CORE 5220/6000 (87%, 余 780)", WARN),
        ("[warn] 43 条规矩没有触发条件", WARN),
        ("[error] 冲突裁决 0 与事实为根重复", ERR),
        ("[error] 亲密条被外部建议覆盖", ERR),
        ("$ git log --oneline -3", CODE),
        ("a1b2c3d  回滚 4304 → 5261，重判采纳 3 驳回 4", OK),
        ("9f8e7d6  rule-diff 14/14 无回归", OK),
        ("5c4b3a2  记忆五代，从搬箱子到自己查架", OK),
        ("$ python3 tools/build_video.py", CODE),
        ("✓ 1080P60 · 9:00 · 字幕自动烧录", OK),
        ("", CODE),
        ("—— 骨架不是人设，是每次改动都算数 ——", WARN),
    ]
    f_code = font(14)
    y = 42
    for text, color in code_lines:
        d.text((34, y), text, font=f_code, fill=color)
        y += 24

    # 主标题 + 副标题
    f_h1 = font(74)
    f_sub = font(26)
    d.text((34, 486), "52亿token，", font=f_h1, fill=WHITE, stroke_width=2, stroke_fill=WHITE)
    d.text((34, 572), "长出不返工的", font=f_h1, fill=WHITE, stroke_width=2, stroke_fill=WHITE)
    w2 = d.textlength("长出不返工的", font=f_h1)
    d.text((34 + w2, 572), "骨架", font=f_h1, fill=ORANGE, stroke_width=2, stroke_fill=ORANGE)
    d.text((34, 668), "大肥鱼 Core · 思考与记忆骨架开源", font=f_sub, fill=ORANGE)

    # 右下角标
    d.text((W - 210, H - 34), "1146 × 717 · B站封面", font=font(13), fill=(90, 100, 112))

    img.save(OUT)
    print(f"✅ {OUT}  {OUT.stat().st_size//1024} KB")


if __name__ == "__main__":
    main()
