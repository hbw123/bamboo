#!/usr/bin/env python3
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SKIN = ROOT / "app" / "assets" / "skins" / "default"
OUT = ROOT / "docs" / "demo.gif"
W, H = 760, 420


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, size=size, index=1 if bold else 0)
        except Exception:
            pass
    return ImageFont.load_default()


F_TITLE = font(22, True)
F_BODY = font(16)
F_SMALL = font(13)
F_TINY = font(12)


def rounded(draw: ImageDraw.ImageDraw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text_size(draw: ImageDraw.ImageDraw, text: str, fnt) -> tuple[int, int]:
    b = draw.textbbox((0, 0), text, font=fnt)
    return b[2] - b[0], b[3] - b[1]


def load_sprite(name: str, size: int) -> Image.Image:
    im = Image.open(SKIN / name).convert("RGBA")
    im.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2))
    return canvas


SPRITES = {
    "idle": load_sprite("idle.png", 132),
    "done": load_sprite("done.png", 132),
    "waiting": load_sprite("waiting.png", 132),
}


def bubble(draw: ImageDraw.ImageDraw, cx: int, y: int, text: str):
    tw, th = text_size(draw, text, F_BODY)
    pad_x, pad_y = 16, 9
    bw = min(232, tw + pad_x * 2)
    bh = th + pad_y * 2
    x = cx - bw // 2
    rounded(draw, (x, y, x + bw, y + bh), 16, (255, 255, 255, 248), (218, 225, 236, 255))
    draw.polygon([(cx - 8, y + bh - 1), (cx + 8, y + bh - 1), (cx, y + bh + 10)], fill=(255, 255, 255, 248))
    draw.text((cx - tw // 2, y + pad_y - 2), text, font=F_BODY, fill=(35, 43, 58, 255))


def panel(draw: ImageDraw.ImageDraw, x: int, y: int):
    rounded(draw, (x, y, x + 232, y + 150), 16, (255, 255, 255, 250), (218, 225, 236, 255))
    draw.text((x + 14, y + 12), "进行中的会话", font=F_TINY, fill=(100, 111, 128, 255))
    rows = [
        ("bamboo", "工作中", (74, 124, 199, 255)),
        ("docs-site", "等待", (210, 154, 74, 255)),
        ("release", "完成", (90, 160, 106, 255)),
    ]
    yy = y + 42
    for name, status, color in rows:
        rounded(draw, (x + 10, yy, x + 222, yy + 30), 9, (246, 248, 252, 255))
        draw.text((x + 20, yy + 7), name, font=F_SMALL, fill=(35, 43, 58, 255))
        sw, _ = text_size(draw, status, F_TINY)
        bx = x + 210 - sw
        rounded(draw, (bx - 8, yy + 6, bx + sw + 8, yy + 24), 9, color)
        draw.text((bx, yy + 7), status, font=F_TINY, fill=(255, 255, 255, 255))
        yy += 34


def base() -> Image.Image:
    im = Image.new("RGBA", (W, H), (250, 252, 255, 255))
    d = ImageDraw.Draw(im)
    for x in range(0, W, 32):
        d.line((x, 0, x, H), fill=(235, 239, 247, 255), width=1)
    for y in range(0, H, 32):
        d.line((0, y, W, y), fill=(235, 239, 247, 255), width=1)
    rounded(d, (70, 44, 690, 360), 24, (255, 255, 255, 245), (218, 225, 236, 255))
    d.text((104, 76), "Panda Pet", font=F_TITLE, fill=(35, 43, 58, 255))
    d.text((104, 108), "感知 Claude Code 状态的安静桌宠", font=F_BODY, fill=(86, 98, 118, 255))
    return im


def draw_card(im: Image.Image, x: int, y: int, sprite: Image.Image, scale: float = 1.0):
    d = ImageDraw.Draw(im)
    size = int(148 * scale)
    shadow = Image.new("RGBA", im.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    rounded(sd, (x, y + 8, x + size, y + size + 8), int(26 * scale), (35, 43, 58, 32))
    im.alpha_composite(shadow)
    rounded(d, (x, y, x + size, y + size), int(26 * scale), (255, 255, 255, 255))
    sp = sprite.resize((int(sprite.width * scale), int(sprite.height * scale)), Image.Resampling.LANCZOS)
    im.alpha_composite(sp, (x + (size - sp.width) // 2, y + (size - sp.height) // 2))


def frame(i: int) -> Image.Image:
    im = base()
    d = ImageDraw.Draw(im)
    phase = i % 36
    card_x, card_y = 494, 178

    if phase < 12:
        dy = int(math.sin(phase / 12 * math.pi * 2) * 3)
        bubble(d, card_x + 74, 122 + dy, "bamboo 正在工作")
        draw_card(im, card_x, card_y + dy, SPRITES["idle"])
        d.text((104, 178), "提交任务后", font=F_BODY, fill=(35, 43, 58, 255))
        d.text((104, 210), "熊猫进入工作状态，轻微呼吸。", font=F_SMALL, fill=(86, 98, 118, 255))
    elif phase < 24:
        p = phase - 12
        bounce = -14 * math.sin(min(1, p / 8) * math.pi)
        bubble(d, card_x + 74, 112, "bamboo 好了")
        draw_card(im, card_x, int(card_y + bounce), SPRITES["done"], 1.03)
        d.text((104, 178), "任务完成时", font=F_BODY, fill=(35, 43, 58, 255))
        d.text((104, 210), "轻提醒，不打断当前节奏。", font=F_SMALL, fill=(86, 98, 118, 255))
    else:
        panel(d, 348, 72)
        bubble(d, card_x + 74, 204, "点一下查看会话")
        draw_card(im, card_x, 270, SPRITES["waiting"])
        d.text((104, 178), "多会话聚合", font=F_BODY, fill=(35, 43, 58, 255))
        d.text((104, 210), "展开面板查看正在进行的任务。", font=F_SMALL, fill=(86, 98, 118, 255))
    return im.convert("P", palette=Image.Palette.ADAPTIVE, colors=128)


def main():
    frames = [frame(i) for i in range(36)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=90,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(OUT)


if __name__ == "__main__":
    main()
