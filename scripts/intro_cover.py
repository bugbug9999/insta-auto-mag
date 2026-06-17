#!/usr/bin/env python3
"""스레드 인트로 커버 — 매거진 커버 카드(make_card.py 스타일 차용).
다크 스모크 배경 + 날짜 키커 + 큰 헤드라인(액센트 단어 오렌지) + 서브타이틀.
"""
import os, random, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W, H = 1080, 1350
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
F_BOLD, F_SEMI, F_MED, F_REG = 6, 4, 2, 0
WHITE = (255, 255, 255)
ORANGE = (233, 99, 40)          # 레퍼런스 액센트(비비드 오렌지)
SUB = (200, 201, 205)
OUT = os.path.join(os.path.dirname(__file__), "..", "out", "fable_intro_cover.png")

def font(size, idx=F_BOLD):
    return ImageFont.truetype(FONT, size, index=idx)

def smoke_bg():
    """near-black 베이스 + 흐릿한 흰 연기 곡선 streak(스크린 블렌딩) + 비네트."""
    random.seed(7)
    base = Image.new("RGB", (W, H), (8, 8, 9))
    # 미세 수직 그라데이션(위 살짝 밝게)
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        grad.putpixel((0, y), int(26 * (1 - y / H)))
    base = ImageChops.add(base, grad.resize((W, H)).convert("RGB"))

    # 연기: 여러 굵은 곡선 폴리라인을 흰색으로 그려 강하게 블러
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
    # 살짝 더 또렷한 코어 한 줄
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

    # 비네트(가장자리 어둡게)
    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-W * 0.3, -H * 0.2, W * 1.3, H * 1.2], fill=60)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    base = ImageChops.multiply(base, Image.merge("RGB", [vig.point(lambda v: 150 + v)] * 3))
    return base

def draw_segments(d, x, y, segs, fnt):
    """segs=[(text,color),...] 한 줄을 좌측정렬로 이어 그린다."""
    cx = x
    for text, color in segs:
        d.text((cx, y), text, font=fnt, fill=color)
        cx += d.textlength(text, font=fnt)

def main():
    im = smoke_bg()
    d = ImageDraw.Draw(im)
    LX = 64

    # 키커(날짜) — 오렌지, 자간 넓게
    kicker = "·   2 0 2 6 .  0 6 .  1 3"
    kf = font(34, F_SEMI)
    d.text((LX + 4, 396), kicker, font=kf, fill=ORANGE)

    # 헤드라인 3줄
    hf = font(116, F_BOLD)
    gap = 150
    y0 = 470
    d.text((LX, y0), "미국 정부가", font=hf, fill=WHITE)
    d.text((LX, y0 + gap), "최신 AI 모델", font=hf, fill=WHITE)
    draw_segments(d, LX, y0 + gap * 2, [("Fable", ORANGE), ("을 금지했다", WHITE)], hf)

    # 서브타이틀 3줄
    sf = font(41, F_MED)
    sy = y0 + gap * 2 + 168
    sgap = 56
    for i, line in enumerate([
        "출시 사흘 만의 전 세계 정지.",
        "사상 첫 프론티어 모델 리콜이",
        "남긴 질문들.",
    ]):
        d.text((LX, sy + sgap * i), line, font=sf, fill=SUB)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    im.save(OUT, "PNG")
    print(os.path.abspath(OUT))

if __name__ == "__main__":
    main()
