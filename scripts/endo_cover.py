#!/usr/bin/env python3
"""윤희상 인트로 커버 — 깨끗한 인물 프레임(자막 없는 영역) + 하단 다크 그라데이션 + 헤드라인."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

W, H = 1080, 1350
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
F_BOLD, F_SEMI, F_MED = 6, 4, 2
WHITE = (255, 255, 255)
ORANGE = (233, 99, 40)
SUB = (208, 209, 213)
SRC = "/tmp/endo_frames/frame_800.jpg"
OUT = os.path.join(os.path.dirname(__file__), "..", "out", "endo_intro_cover.png")


def font(size, idx=F_BOLD):
    return ImageFont.truetype(FONT, size, index=idx)


def cover_fill(im, w, h, focus_x=0.54):
    """scale-to-fill 후 focus_x 중심으로 가로 크롭."""
    r = max(w / im.width, h / im.height)
    nw, nh = int(im.width * r), int(im.height * r)
    im = im.resize((nw, nh), Image.LANCZOS)
    cx = int(nw * focus_x)
    left = max(0, min(nw - w, cx - w // 2))
    top = max(0, min(nh - h, int((nh - h) * 0.18)))
    return im.crop((left, top, left + w, top + h))


def main():
    base = Image.open(SRC).convert("RGB")
    base = cover_fill(base, W, H, focus_x=0.55)
    # 전체를 살짝 어둡게(텍스트 대비) + 채도 약간 낮춤
    base = ImageEnhance.Brightness(base).enhance(0.92)
    base = ImageEnhance.Color(base).enhance(0.92)

    # 하단 다크 그라데이션(자막/하단 텍스트를 완전히 덮는다 — 0.68H부터 풀블랙)
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        t = (y - H * 0.42) / (H * 0.26)
        v = 0 if t < 0 else int(255 * min(1, t) ** 1.05)
        grad.putpixel((0, y), v)
    grad = grad.resize((W, H))
    black = Image.new("RGB", (W, H), (6, 7, 9))
    base = Image.composite(black, base, grad)

    # 상단 살짝 어둡게(키커 가독)
    tg = Image.new("L", (1, H), 0)
    for y in range(H):
        tg.putpixel((0, y), int(90 * max(0, 1 - y / (H * 0.25))))
    base = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), base, tg.resize((W, H)))

    d = ImageDraw.Draw(base)
    LX = 64

    # 키커
    d.text((LX + 2, 902), "비 즈 까 페   인 터 뷰   요 약", font=font(32, F_SEMI), fill=ORANGE)

    # 헤드라인 2줄
    hf = font(104, F_BOLD)
    d.text((LX, 952), "연대 의대 창업가,", font=hf, fill=WHITE)
    # 둘째 줄: a16z 오렌지 강조
    y2 = 1078
    seg = [("미국서 ", WHITE), ("a16z", ORANGE), (" 투자", WHITE)]
    cx = LX
    for t, col in seg:
        d.text((cx, y2), t, font=hf, fill=col)
        cx += d.textlength(t, font=hf)

    # 서브타이틀
    d.text((LX, 1232), "스펙이 무너진 곳에서 시작된 이야기.", font=font(40, F_MED), fill=SUB)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    base.save(OUT, "PNG")
    print(os.path.abspath(OUT))


if __name__ == "__main__":
    main()
