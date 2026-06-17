#!/usr/bin/env python3
"""프레임 품질 분류 — 문서/텍스트 스크린샷 거부용 (의존성: Pillow, numpy).

토킹헤드+화면공유형 분석 영상(예: Patrick Boyle)은 프레임 추출이 S-1 재무표·
영문 텍스트 벽 같은 '읽을 수 없는 문서 스크린샷'을 집는다. 이를 매거진 이미지로
쓰면 안 되므로 거부 분류한다.

실측 임계(2026-06-13, SpaceX IPO 분석 영상):
  흰 문서: bright>0.89, sat<0.16 / 토킹헤드: bright~0.47, sat~0.47
  → doc = (bright>0.80 AND sat<0.22)  OR  (edge>0.15 AND bright>0.65 AND sat<0.30)

사용: python3 frame-quality.py <img1> <img2> ...
출력: {"<path>": {"doc": bool, "bright": .., "sat": .., "edge": ..} | null} JSON 한 줄
"""
import json
import sys

import numpy as np
from PIL import Image


def features(path):
    im = Image.open(path).convert("RGB").resize((320, 180))
    g = np.asarray(im.convert("L"), dtype=float)
    gx = np.abs(np.diff(g, axis=1))
    gy = np.abs(np.diff(g, axis=0))
    edge = float(((gx[:-1, :] + gy[:, :-1]) > 40).mean())
    hsv = np.asarray(im.convert("HSV"), dtype=float)
    sat = float(hsv[:, :, 1].mean() / 255.0)
    bright = float(g.mean() / 255.0)
    return edge, sat, bright


def is_document(edge, sat, bright):
    if bright > 0.80 and sat < 0.22:
        return True
    if edge > 0.15 and bright > 0.65 and sat < 0.30:
        return True
    return False


def main():
    out = {}
    for p in sys.argv[1:]:
        try:
            edge, sat, bright = features(p)
            out[p] = {
                "doc": is_document(edge, sat, bright),
                "bright": round(bright, 3),
                "sat": round(sat, 3),
                "edge": round(edge, 3),
            }
        except Exception:
            out[p] = None
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
