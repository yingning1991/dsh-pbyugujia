#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_bg.py —— 生成三条无版权、可循环的动态背景（960×540 渲染，编码时放大到 1080P）

  assets/bg/cold-grid.mp4   冷色深空网格（开篇～第三篇章）
  assets/bg/code-rain.mp4   极暗代码雨（技术讲解段）
  assets/bg/warm-grain.mp4  暖色胶片噪点（第四篇章～结尾）

为什么自己做：不占版权、色泽跟字幕/立绘一致、手机上几秒出片，不用去素材站淘。
用法：python3 tools/make_bg.py
"""
import math
import random
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "bg"
W, H = 960, 540
FPS, SECS = 25, 8
N = FPS * SECS
TMP = OUT / "_frames"
GLYPHS = "01{}[]<>/\\|=+*#$%&@大肥鱼记忆骨架账本核事实情报回滚差测"


def gradient(top, bot):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img


def vignette():
    v = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(v)
    d.ellipse([-W * 0.3, -H * 0.4, W * 1.3, H * 1.4], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(90))
    dark = Image.new("RGBA", (W, H), (0, 0, 0, 150))
    dark.putalpha(Image.eval(v, lambda x: 80 - int(x * 80 / 255)))
    return dark


def grain_tiles(seed=3):
    rnd = random.Random(seed)
    tiles = []
    for _ in range(3):
        im = Image.new("L", (W, H))
        px = im.load()
        for _ in range(W * H // 7):
            px[rnd.randrange(W), rnd.randrange(H)] = rnd.randrange(60, 200)
        im = im.filter(ImageFilter.GaussianBlur(0.6))
        tiles.append(im)
    return tiles


# ---------- 1. 冷色深空网格 ----------
def make_grid():
    base = gradient((16, 22, 31), (30, 42, 58)).convert("RGBA")
    cell = 64
    grid = Image.new("RGBA", (W + cell * 2, H + cell * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(grid)
    for x in range(0, W + cell * 2, cell):
        d.line([(x, 0), (x, H + cell * 2)], fill=(150, 190, 245, 46))
    for y in range(0, H + cell * 2, cell):
        d.line([(0, y), (W + cell * 2, y)], fill=(150, 190, 245, 46))
    # 一根缓慢扫过的亮线
    sweep = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vg = vignette()
    frames = []
    for i in range(N):
        t = i / N
        ox = int((t * cell) % cell)
        oy = int((t * cell * 0.6) % cell)
        img = base.copy()
        img.alpha_composite(grid.crop((ox, oy, ox + W, oy + H)))
        y = int(H * (0.15 + 0.7 * ((t * 1.0) % 1.0)))
        ds = ImageDraw.Draw(sweep)
        ds.rectangle([0, y, W, y + 2], fill=(120, 170, 255, 22))
        img.alpha_composite(sweep)
        sweep.paste((0, 0, 0, 0), (0, 0, W, H))
        img.alpha_composite(vg)
        frames.append(img.convert("RGB"))
    return frames


# ---------- 2. 极暗代码雨 ----------
def make_code():
    rnd = random.Random(11)
    base = gradient((10, 14, 20), (18, 26, 36)).convert("RGBA")
    base.alpha_composite(vignette())
    cols = 26
    cw = W // cols
    strips, speed = [], []
    for _ in range(cols):
        strip = Image.new("RGBA", (cw, H * 3), (0, 0, 0, 0))
        d = ImageDraw.Draw(strip)
        for k in range(H * 3 // 14):
            ch = rnd.choice(GLYPHS)
            a = rnd.choice([255, 255, 255, 200, 150, 110])
            d.text((2, k * 14), ch, fill=(140, 210, 255, int(a * 0.26)))
        strips.append(strip)
        speed.append(rnd.uniform(18, 60))
    frames = []
    for i in range(N):
        img = base.copy()
        for c in range(cols):
            off = int((i * speed[c]) % (H * 2))
            img.alpha_composite(strips[c].crop((0, off, cw, off + H)), (c * cw, 0))
        frames.append(img.convert("RGB"))
    return frames


# ---------- 3. 暖色胶片噪点 ----------
def make_warm():
    base = gradient((38, 23, 12), (64, 41, 20)).convert("RGBA")
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dg = ImageDraw.Draw(glow)
    dg.ellipse([W * 0.45, -H * 0.2, W * 1.2, H * 0.75], fill=(255, 190, 110, 70))
    dg.ellipse([-W * 0.2, H * 0.35, W * 0.55, H * 1.15], fill=(255, 150, 80, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    tiles = grain_tiles()
    vg = vignette()
    frames = []
    for i in range(N):
        t = i / N
        g = glow.copy()
        dx = int(14 * math.sin(2 * math.pi * t))
        dy = int(9 * math.cos(2 * math.pi * t))
        img = base.copy()
        img.alpha_composite(g, (dx, dy))
        tile = tiles[i % len(tiles)]
        g2 = Image.merge("RGBA", (tile, tile, tile, tile.point(lambda v: int(v * 0.10))))
        img.alpha_composite(g2)
        img.alpha_composite(vg)
        frames.append(img.convert("RGB"))
    return frames


def encode(name, frames):
    d = TMP / name
    d.mkdir(parents=True, exist_ok=True)
    for k, f in enumerate(frames):
        f.save(d / f"{k:04d}.png")
    out = OUT / f"{name}.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(d / "%04d.png"),
        "-vf", "scale=1920:1080:flags=lanczos",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-pix_fmt", "yuv420p", "-g", "50", str(out)], check=True)
    print(f"✓ {out.name}  {out.stat().st_size/1e6:.1f} MB")
    for f in d.glob("*.png"):
        f.unlink()
    d.rmdir()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    encode("cold-grid", make_grid())
    encode("code-rain", make_code())
    encode("warm-grain", make_warm())


if __name__ == "__main__":
    main()
