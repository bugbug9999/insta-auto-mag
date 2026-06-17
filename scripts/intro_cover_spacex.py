#!/usr/bin/env python3
"""스레드 인트로 커버 — SpaceX × Cursor.
다크 스모크 배경 + SpaceX/Cursor 로고 워터마크(스크린 블렌딩) + 큰 헤드라인.
"""
import os, random, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W, H = 1080, 1350
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
F_BOLD, F_SEMI, F_MED, F_REG = 6, 4, 2, 0
WHITE = (255, 255, 255)
ORANGE = (233, 99, 40)
SUB = (200, 201, 205)
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "out", "spacex_intro_cover.png")
SPX_LOGO = "/tmp/spacex_logo.png"
CUR_LOGO = "/tmp/cursor_logo.png"


def font(size, idx=F_BOLD):
    return ImageFont.truetype(FONT, size, index=idx)


def smoke_bg():
    random.seed(7)
    base = Image.new("RGB", (W, H), (8, 8, 9))
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        grad.putpixel((0, y), int(26 * (1 - y / H)))
    base = ImageChops.add(base, grad.resize((W, H)).convert("RGB"))

    smoke = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(smoke)
    for s in range(5):
        cx = W * (0.45 + 0.12 * s / 4)
        amp = 120 + 40 * s
        pts = []
        for i in range(0, H + 1, 14):
            t = i / H
            x = cx + amp * math.sin(t * math.pi * 1.6 + s) * (0.4 + t)
            pts.append((x, i))
        wdt = 26 + s * 8
        sd.line(pts, fill=int(70 - s * 8), width=wdt, joint="curve")
    smoke = smoke.filter(ImageFilter.GaussianBlur(38))
    core = Image.new("L", (W, H), 0)
    cd = ImageDraw.Draw(core)
    pts = []
    for i in range(0, H + 1, 12):
        t = i / H
        x = W * 0.5 + 150 * math.sin(t * math.pi * 1.7) * (0.3 + t)
        pts.append((x, i))
    cd.line(pts, fill=110, width=18, joint="curve")
    core = core.filter(ImageFilter.GaussianBlur(16))
    smoke = ImageChops.add(smoke, core)
    base = ImageChops.screen(base, smoke.convert("RGB"))

    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-W * 0.3, -H * 0.2, W * 1.3, H * 1.2], fill=60)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    base = ImageChops.multiply(base, Image.merge("RGB", [vig.point(lambda v: 150 + v)] * 3))
    return base


def screen_logo(base, logo_path, target_w, pos, opacity, whiten=False):
    """로고를 검은 캔버스에 올려 base와 screen 블렌딩(밝은 부분만 더해짐 = 워터마크)."""
    lg = Image.open(logo_path).convert("RGBA")
    ratio = target_w / lg.width
    lg = lg.resize((target_w, max(1, int(lg.height * ratio))), Image.LANCZOS)

    if whiten:
        alpha = lg.split()[3]
        white = Image.new("RGBA", lg.size, (255, 255, 255, 0))
        white.putalpha(alpha)
        lg = white

    r, g, b, a = lg.split()
    r = r.point(lambda v: int(v * opacity))
    g = g.point(lambda v: int(v * opacity))
    b = b.point(lambda v: int(v * opacity))
    lg = Image.merge("RGBA", (r, g, b, a))

    layer = Image.new("RGB", (W, H), (0, 0, 0))
    layer.paste(lg.convert("RGB"), pos, lg)
    return ImageChops.screen(base, layer)


def draw_segments(d, x, y, segs, fnt):
    cx = x
    for text, color in segs:
        d.text((cx, y), text, font=fnt, fill=color)
        cx += d.textlength(text, font=fnt)


def main():
    im = smoke_bg()
    # 배경 로고 워터마크 — Cursor 큐브(우상단), SpaceX 워드마크(하단 가로)
    im = screen_logo(im, CUR_LOGO, target_w=520, pos=(690, 80), opacity=0.6)
    im = screen_logo(im, SPX_LOGO, target_w=880, pos=(100, 1150), opacity=0.5, whiten=True)

    d = ImageDraw.Draw(im)
    LX = 64

    kicker = "S P A C E X   ×   C U R S O R"
    kf = font(34, F_SEMI)
    d.text((LX + 4, 396), kicker, font=kf, fill=ORANGE)

    hf = font(116, F_BOLD)
    gap = 150
    y0 = 470
    draw_segments(d, LX, y0, [("스페이스", WHITE), ("X", ORANGE), ("가", WHITE)], hf)
    d.text((LX, y0 + gap), "커서를 샀다", font=hf, fill=WHITE)
    draw_segments(d, LX, y0 + gap * 2, [("80조", ORANGE), (", 현금 0원", WHITE)], hf)

    sf = font(41, F_MED)
    sy = y0 + gap * 2 + 168
    sgap = 56
    for i, line in enumerate([
        "주가가 오른 만큼, 그 돈으로",
        "Cursor를 통째로 삼킨 방식.",
        "약점이라던 AI가 무기가 됐다.",
    ]):
        d.text((LX, sy + sgap * i), line, font=sf, fill=SUB)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    im.save(OUT, "PNG")
    print(os.path.abspath(OUT))


if __name__ == "__main__":
    main()
