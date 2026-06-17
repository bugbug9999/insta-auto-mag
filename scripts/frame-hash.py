#!/usr/bin/env python3
"""이미지 aHash(8x8 평균 해시) 일괄 계산 — 프레임 시각 중복 탐지용 (TASK-004).

사용: python3 frame-hash.py <img1> <img2> ...
출력: {"<path>": "0123456789abcdef" | null} JSON 한 줄
"""
import json
import sys

from PIL import Image


def ahash(path):
    im = Image.open(path).convert("L").resize((8, 8))
    px = list(im.getdata())
    avg = sum(px) / 64.0
    bits = "".join("1" if v > avg else "0" for v in px)
    return f"{int(bits, 2):016x}"


def main():
    out = {}
    for p in sys.argv[1:]:
        try:
            out[p] = ahash(p)
        except Exception:
            out[p] = None
    print(json.dumps(out))


if __name__ == "__main__":
    main()
