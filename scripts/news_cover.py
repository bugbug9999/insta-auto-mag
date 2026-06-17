#!/usr/bin/env python3
"""뉴스 스레드 인트로 커버 — 재사용 생성기.
JSON 스펙 하나로 커버를 뽑는다(매번 파이썬 손수정 금지).

  python3 scripts/news_cover.py spec.json

spec.json 스키마:
{
  "out": "out/foo_cover.png",
  "kicker": "S P A C E X   ×   C U R S O R",
  "headline": [                          // 줄당 세그먼트 배열, accent=true면 오렌지
    [{"t":"스페이스"},{"t":"X","accent":true},{"t":"가"}],
    [{"t":"커서를 샀다"}],
    [{"t":"80조","accent":true},{"t":", 현금 0원"}]
  ],
  "subtitle": ["1줄","2줄","3줄"],
  "logos": [                             // 배경 워터마크(스크린 블렌딩). 선택.
    {"path":"/tmp/cursor_logo.png","w":520,"pos":[690,80],"opacity":0.6},
    {"path":"/tmp/spacex_logo.png","w":880,"pos":[100,1150],"opacity":0.5,"whiten":true}
  ]
}

뉴스 썸네일 기본값(잊지 말 것): 큰 헤드라인에 주인공(회사/인물) + 배경에 관련 로고.
로고 받기: Wikimedia `api.php imageinfo iiurlwidth` PNG 또는 사이트 apple-touch-icon.png
(이 맥엔 SVG변환기 rsvg/cairosvg/inkscape 없음 → PNG로 받을 것).
"""
import os, sys, json, random, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W, H = 1080, 1350
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
F_BOLD, F_SEMI, F_MED = 6, 4, 2
WHITE = (255, 255, 255)
ORANGE = (233, 99, 40)
SUB = (200, 201, 205)
HERE = os.path.dirname(__file__)


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
        pts = [(cx + amp * math.sin((i / H) * math.pi * 1.6 + s) * (0.4 + i / H), i)
               for i in range(0, H + 1, 14)]
        sd.line(pts, fill=int(70 - s * 8), width=26 + s * 8, joint="curve")
    smoke = smoke.filter(ImageFilter.GaussianBlur(38))
    core = Image.new("L", (W, H), 0)
    cd = ImageDraw.Draw(core)
    pts = [(W * 0.5 + 150 * math.sin((i / H) * math.pi * 1.7) * (0.3 + i / H), i)
           for i in range(0, H + 1, 12)]
    cd.line(pts, fill=110, width=18, joint="curve")
    smoke = ImageChops.add(smoke, core.filter(ImageFilter.GaussianBlur(16)))
    base = ImageChops.screen(base, smoke.convert("RGB"))
    vig = Image.new("L", (W, H), 0)
    ImageDraw.Draw(vig).ellipse([-W * 0.3, -H * 0.2, W * 1.3, H * 1.2], fill=60)
    vig = vig.filter(ImageFilter.GaussianBlur(180))
    return ImageChops.multiply(base, Image.merge("RGB", [vig.point(lambda v: 150 + v)] * 3))


def screen_logo(base, spec):
    lg = Image.open(spec["path"]).convert("RGBA")
    w = spec.get("w", 500)
    lg = lg.resize((w, max(1, int(lg.height * w / lg.width))), Image.LANCZOS)
    if spec.get("whiten"):
        white = Image.new("RGBA", lg.size, (255, 255, 255, 0))
        white.putalpha(lg.split()[3])
        lg = white
    op = spec.get("opacity", 0.5)
    r, g, b, a = lg.split()
    lg = Image.merge("RGBA", (r.point(lambda v: int(v * op)), g.point(lambda v: int(v * op)),
                              b.point(lambda v: int(v * op)), a))
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    layer.paste(lg.convert("RGB"), tuple(spec.get("pos", [0, 0])), lg)
    return ImageChops.screen(base, layer)


def draw_segments(d, x, y, segs, fnt):
    cx = x
    for seg in segs:
        color = ORANGE if seg.get("accent") else WHITE
        d.text((cx, y), seg["t"], font=fnt, fill=color)
        cx += d.textlength(seg["t"], font=fnt)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: news_cover.py spec.json")
    spec = json.load(open(sys.argv[1]))
    im = smoke_bg()
    for lg in spec.get("logos", []):
        im = screen_logo(im, lg)
    d = ImageDraw.Draw(im)
    LX = 64
    if spec.get("kicker"):
        d.text((LX + 4, 396), spec["kicker"], font=font(34, F_SEMI), fill=ORANGE)
    hf = font(116, F_BOLD)
    gap, y0 = 150, 470
    for i, line in enumerate(spec["headline"]):
        draw_segments(d, LX, y0 + gap * i, line, hf)
    sf = font(41, F_MED)
    sy = y0 + gap * len(spec["headline"]) + 18
    for i, line in enumerate(spec.get("subtitle", [])):
        d.text((LX, sy + 56 * i), line, font=sf, fill=SUB)
    out = os.path.join(HERE, "..", spec.get("out", "out/news_cover.png"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, "PNG")
    print(os.path.abspath(out))


if __name__ == "__main__":
    main()
