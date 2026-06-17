#!/usr/bin/env python3
"""감성 매거진 스타일 캐러셀 카드 제너레이터.

템플릿 3종:
  cover  — 인물/현장 사진 흑백처리 + 하단 다크 그라데이션 + 좌하단 굵은 헤드라인
  body   — 다크네이비 배경 + 상단 인셋 사진카드 + 포인트색 소제목 + 흰 본문(강조어 하이라이트)
  ending — 상단 포인트색 헤드라인 + 중앙 인셋 이미지 카드 (CTA)

사용:
  python3 make_card.py demo                         # 샘플 3장 생성 (out/)
  python3 make_card.py json spec.json              # 스펙 파일로 슬라이드 일괄 생성
  python3 make_card.py json spec.json --only 1     # 특정 슬라이드만 생성
spec.json 예시는 README.md 참조.
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageOps

W, H = 1080, 1350  # 4:5
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
F_BOLD, F_SEMI, F_MED, F_REG = 6, 4, 2, 0

# 크로스플랫폼 폰트 해석: 맥엔 AppleSDGothicNeo.ttc(가중치=index), Linux/Docker엔 번들 Pretendard 파일.
# 맥에선 기존 동작 그대로 유지(.ttc 존재 시).
_USE_TTC = os.path.exists(FONT)
_FONT_DIR = os.environ.get("FONT_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts"))
_LINUX_FONTS = {
    F_BOLD: "Pretendard-Bold.otf",
    F_SEMI: "Pretendard-SemiBold.otf",
    F_MED: "Pretendard-Medium.otf",
    F_REG: "Pretendard-Regular.otf",
}

NAVY = (17, 22, 32)
WHITE = (255, 255, 255)
SKY = (156, 206, 245)     # 소제목/강조 기본 (하늘색)
LIME = (214, 245, 90)     # 본문 키워드 하이라이트 (연두)
ORANGE = (224, 122, 63)   # 주제 브랜드색에 맞춰 교체 가능
GOLD = (229, 180, 86)     # 시그니처 골드 포인트
IVORY = (244, 241, 234)
BLACK = (20, 20, 20)
LIGHT_SUB = (85, 85, 85)
LIGHT_BORDER = (221, 216, 204)
MIN_FONT_SIZE = 28
# shrunk=자동축소 발동(정상 동작, 정보용) / clipped=최소 폰트로도 못 담음(진짜 오버플로)
LAST_RENDER_META = {"shrunk": False, "clipped": False}

def font(size, idx=F_BOLD):
    if _USE_TTC:
        return ImageFont.truetype(FONT, size, index=idx)
    fname = _LINUX_FONTS.get(idx, _LINUX_FONTS[F_REG])
    return ImageFont.truetype(os.path.join(_FONT_DIR, fname), size)

def load_photo(path, w, h, preserve_color=True, bw=False):
    """사진을 w×h로 크롭. 기본 컬러 원본 유지(레퍼런스 실측 — 흑백은 아카이브 사진의 자연 흑백뿐).

    bw=True일 때만 흑백+살짝 어둡게 (spec 슬라이드의 "bw": true 옵션)."""
    if path and os.path.exists(path):
        im = Image.open(path).convert("RGB")
        im = ImageOps.fit(im, (w, h))
    else:  # 사진 없으면 회색 플레이스홀더
        im = Image.new("RGB", (w, h), (70, 74, 82))
    if not bw:
        return im
    g = ImageOps.grayscale(im).convert("RGB")
    g = ImageEnhance.Contrast(g).enhance(1.15)
    g = ImageEnhance.Brightness(g).enhance(0.92)
    return g

def draw_rich_line(d, cx, y, parts, size, idx=F_REG, underline=False, align="center", line_factor=1.55,
                   underline_color=None):
    """parts = [(text, color), ...] 또는 [(text, color, font_idx), ...] 한 줄을 그린다.

    align="center"면 cx를 중심으로 가운데 정렬, "left"면 cx를 왼쪽 시작점으로 사용.
    line_factor = 줄간 배수(다음 줄 y 오프셋 = size × line_factor)."""
    total = 0
    normalized = []
    for part in parts:
        if len(part) == 2:
            t, col = part
            part_idx = idx
        else:
            t, col, part_idx = part
        part_font = font(size, part_idx)
        total += d.textlength(t, font=part_font)
        normalized.append((t, col, part_font))
    x = cx if align == "left" else cx - total / 2
    for t, col, part_font in normalized:
        d.text((x, y), t, font=part_font, fill=col)
        w = d.textlength(t, font=part_font)
        if underline:
            d.line([(x, y + size + 8), (x + w, y + size + 8)], fill=underline_color or col, width=3)
        x += w
    return y + int(size * line_factor)

def parse_rich(line, base=WHITE, accent=LIME, base_idx=F_REG, accent_idx=None):
    """'토큰을 [아껴야] 합니다' → [('토큰을 ',W,base_idx),('아껴야',accent,accent_idx),(' 합니다',W,base_idx)]"""
    accent_idx = base_idx if accent_idx is None else accent_idx
    parts, buf, hot = [], "", False
    for ch in line:
        if ch == "[":
            if buf:
                parts.append((buf, base, base_idx))
                buf = ""
            hot = True
        elif ch == "]":
            if buf:
                parts.append((buf, accent, accent_idx))
                buf = ""
            hot = False
        else:
            buf += ch
    if buf:
        parts.append((buf, accent if hot else base, accent_idx if hot else base_idx))
    return parts

def watermark(d, brand, theme="dark"):
    # 배경이 전 템플릿 브랜드 다크로 통일돼 워터마크도 흰 박스 단일 (theme 인자는 호환용)
    f = font(34, F_BOLD)
    w = d.textlength(brand, font=f)
    x = W - w - 48
    d.rectangle([x - 24, H - 66, x - 10, H - 52], fill=GOLD)
    d.text((x, H - 80), brand, font=f, fill=WHITE)

def clamp_kicker_bg(value):
    """커버 키커 칩 배경 불투명도(%). 기본 88, 범위 0~100. None/비수치=기본."""
    try:
        v = int(round(float(value)))
    except (TypeError, ValueError):
        return 88
    return max(0, min(100, v))

def cover(headline, photo=None, brand="MAG", out="cover.png", kicker=None, theme="dark", bw=False,
          kicker_bg=None):
    im = load_photo(photo, W, H, bw=bw)
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        a = 0 if y < H * 0.45 else int(235 * ((y - H * 0.45) / (H * 0.55)) ** 1.4)
        grad.putpixel((0, y), a)
    black = Image.new("RGB", (W, H), (8, 8, 10))
    im = Image.composite(black, im, grad.resize((W, H)))
    d = ImageDraw.Draw(im)
    size, kicker_size, shrunk, clipped = fit_cover_sizes(d, headline, kicker)
    LAST_RENDER_META["shrunk"] = shrunk
    LAST_RENDER_META["clipped"] = clipped
    lines = split_lines(headline)
    y = H - 170 - len(lines) * int(size * 1.22)
    if kicker:
        # 골드 키커는 사진 위에서 묻힌다 — 다크 반투명 칩을 깔아 또렷하게 (유저 2026-06-13)
        # 칩 불투명도는 에디터에서 슬라이드별 조절(kicker_bg, 0~100%).
        bg_alpha = int(round(clamp_kicker_bg(kicker_bg) * 255 / 100))
        kf = font(kicker_size, F_SEMI)
        kw = d.textlength(kicker, font=kf)
        ky = y - 72
        pad_x, pad_y = 22, 12
        if bg_alpha > 0:
            overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            od.rounded_rectangle(
                [72 - pad_x, ky - pad_y, 72 + kw + pad_x, ky + kicker_size + pad_y + 4],
                radius=10, fill=(8, 10, 14, bg_alpha))
            im = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
            d = ImageDraw.Draw(im)
        d.text((72, ky), kicker, font=kf, fill=GOLD)
    for ln in lines:
        parts = parse_rich(ln, base=WHITE, accent=WHITE)
        x = 72
        line_font = font(size, F_BOLD)
        for part in parts:
            if len(part) == 2:
                text, color = part
            else:
                text, color, _ = part
            d.text((x, y), text, font=line_font, fill=color,
                   stroke_width=1, stroke_fill=color)
            x += d.textlength(text, font=line_font)
        y += int(size * 1.22)
    f = font(30, F_BOLD)
    d.text((W / 2 - d.textlength(brand, font=f) / 2, H - 78), brand, font=f, fill=(230, 230, 230))
    im.save(out)
    return out

def clamp_line_spacing(value):
    """슬라이드별 본문 줄간 배수. 기본 1.4(촘촘 — 유저 2026-06-12), 에디터 게이지 범위 1.2~1.8."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 1.4
    return max(1.2, min(1.8, v))

def clamp_font_size(value):
    """에디터 수동 폰트 크기 오버라이드. None/비수치 = 자동(핏)."""
    try:
        v = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return max(22, min(80, v))

def para_gap(line_factor, is_archive):
    """문단(=문장) 사이 갭 — 초단문 스타일에선 이게 체감 간격의 대부분이라 게이지에 비례시킨다.
    기본 1.4에서 기존값(아카이브 20/뉴스 26) 유지, 1.2→절반, 1.8→2배."""
    base = 20 if is_archive else 26
    return max(4, int(round(base * (line_factor - 1.0) / 0.4)))

def body_geometry(theme):
    """본문 사진카드 기하. 라이트=레퍼런스 어록형 실측(카드 0.88W×0.56H, y0.10 — 이건희 포스트 3장 동일),
    다크=뉴스형은 레퍼런스 해설형 골격(상단 풀블리드 사진 + 하단 텍스트 존, 2026-06-13)."""
    if theme == "light":
        pw, ph = int(W * 0.86), int(H * 0.52)
        py = int(H * 0.10)
        text_gap = 64
        px = (W - pw) // 2
    else:
        pw, ph = W, int(H * 0.56)
        px, py = 0, 0
        text_gap = 56
    return pw, ph, px, py, text_gap

def body(subtitle, paragraphs, photo=None, brand="MAG", out="body.png",
         accent=SKY, hot=LIME, theme="dark", bw=False, line_spacing=None, source=None,
         subtitle_size=None, body_size=None, text_pos=None):
    # theme은 이제 '레이아웃' — light=아카이브형(큰 사진카드+왼쪽 정렬), dark=뉴스형(레퍼런스 해설형: 풀블리드+좌정렬).
    # 배경은 브랜드 다크로 통일 (유저 결정 2026-06-12: 흰 배경 금지).
    # 타이포는 레퍼런스 현행(2026-06-13): 형광 폐지, 소제목·강조 = 흰 볼드(+밑줄), 본문 = 소프트 화이트.
    is_archive = theme == "light"
    bg = NAVY
    subtitle_color = WHITE
    body_color = (212, 217, 226)
    highlight_color = WHITE
    line_factor = clamp_line_spacing(line_spacing)
    im = Image.new("RGB", (W, H), bg)
    pw, ph, px, py, text_gap = body_geometry(theme)
    photo_im = load_photo(photo, pw, ph, bw=bw)
    im.paste(photo_im, (px, py))
    d = ImageDraw.Draw(im)
    if is_archive:
        d.rectangle([px, py, px + pw, py + ph], outline=(58, 63, 74), width=1)
    else:
        d.rectangle([0, py + ph, W, py + ph + 3], fill=GOLD)
    subtitle_size, body_size, shrunk, clipped = fit_body_sizes(
        d, subtitle, paragraphs, theme=theme, line_spacing=line_spacing,
        subtitle_size=clamp_font_size(subtitle_size), body_size=clamp_font_size(body_size))
    LAST_RENDER_META["shrunk"] = shrunk
    LAST_RENDER_META["clipped"] = clipped
    # 레퍼런스 현행: 전 레이아웃 왼쪽 정렬 (아카이브=사진 카드 왼쪽 모서리, 뉴스=좌우 70px 마진)
    align = "left"
    anchor_x = px if is_archive else 70
    y = py + ph + text_gap
    # 텍스트 블록을 드래그로 옮긴 경우 그 좌상단(비율)에서 흐르게
    if text_pos and isinstance(text_pos, dict):
        anchor_x = float(text_pos.get("xPct", anchor_x / W)) * W
        y = float(text_pos.get("yPct", y / H)) * H
    import re as _re
    for ln in split_lines(subtitle):
        m = _re.match(r'^(\d+[.)]) (.*)$', ln)
        parts = [(m.group(1) + ' ', GOLD), (m.group(2), subtitle_color)] if m else [(ln, subtitle_color)]
        y = draw_rich_line(d, anchor_x, y, parts, subtitle_size, F_BOLD,
                           align=align, line_factor=1.5)
    y += 18
    wrap_width = pw if is_archive else W - 140
    for para in paragraphs:
        for raw0 in split_lines(para):
          for raw in split_underline_spans(raw0):
            for ln in wrap_rich_text(d, raw, body_size, wrap_width,
                                     base_idx=F_MED,
                                     accent_idx=F_BOLD):
                ul = ln.startswith("_")
                y = draw_rich_line(
                    d, anchor_x, y,
                    parse_rich(
                        ln.strip("_"),
                        base=body_color,
                        accent=highlight_color,
                        base_idx=F_MED,
                        accent_idx=F_BOLD,
                    ),
                    body_size, F_MED, underline=ul, align=align, line_factor=line_factor,
                    underline_color=GOLD)
        y += para_gap(line_factor, is_archive)
    # 핏은 기본 간격(1.4) 기준 — 게이지를 키워 실제로 넘쳤으면 여기서 경고
    if y - para_gap(line_factor, is_archive) > H - 110:
        LAST_RENDER_META["clipped"] = True
    if source and str(source).strip():
        src = str(source).strip()
        if not src.startswith("출처"):
            src = f"출처 | {src}"
        d.text((max(px, 70), H - 78), src, font=font(24, F_MED), fill=(150, 156, 168))
    watermark(d, brand, theme=theme)
    im.save(out)
    return out

def ending(headline, photo=None, brand="MAG", out="ending.png", accent=ORANGE, theme="dark", headline_pos=None):
    # 배경은 브랜드 다크 통일. 타이포는 레퍼런스 현행(2026-06-13): 흰 볼드 단일, 형광·오렌지 폐지.
    is_archive = theme == "light"
    im = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(im)
    size, shrunk, clipped = fit_ending_size(d, headline)
    LAST_RENDER_META["shrunk"] = shrunk
    LAST_RENDER_META["clipped"] = clipped
    base_color = WHITE
    hot_color = WHITE
    has_photo = bool(photo and os.path.exists(photo))
    lines = split_lines(headline)
    line_h = int(size * 1.24)
    total_h = line_h * max(1, len(lines))
    cx = W / 2
    # 헤드라인을 드래그로 옮긴 경우 그 중심(비율)에 배치
    if headline_pos and isinstance(headline_pos, dict):
        cx = float(headline_pos.get("xPct", 0.5)) * W
        y = float(headline_pos.get("yPct", 0.5)) * H - total_h / 2
    elif has_photo:
        y = int(H * 0.13)
    else:
        # 사진 없으면 텍스트 전용 엔딩 — 헤드라인을 수직 중앙 정렬.
        y = max(int(H * 0.13), (H - total_h) // 2)
    for ln in lines:
        ul = ln.startswith("_")
        y = draw_rich_line(
            d, cx, y,
            parse_rich(ln.strip("_"), base=base_color, accent=hot_color, base_idx=F_BOLD),
            size, F_BOLD, underline=ul)
    if has_photo:
        pw, ph = int(W * 0.74), int(H * 0.46)
        px, py = (W - pw) // 2, int(H * 0.28)
        card = Image.open(photo).convert("RGB")
        card = ImageOps.fit(card, (pw, ph))
        im.paste(card, (px, py))
        d.rectangle([px, py, px + pw, py + ph], outline=(58, 63, 74) if is_archive else (245, 245, 245), width=2)
    watermark(d, brand)
    im.save(out)
    return out

def split_lines(text):
    return str(text or "").split("\n")

def split_underline_spans(raw):
    """문장 중간의 _밑줄_ 스팬을 자기 줄로 분리한다(밑줄은 줄 단위 문법 — AI가 문단 끝에
    붙여 보내는 경우가 흔함). 스팬 뒤 구두점 꼬리는 스팬 안으로 합친다."""
    import re
    line = str(raw or "")
    stripped = line.strip()
    if line.count("_") < 2 or (stripped.startswith("_") and stripped.endswith("_") and line.count("_") == 2):
        return [line]
    out = []
    for seg in re.split(r'(_[^_]+_)', line):
        if not seg or not seg.strip():
            continue
        if re.fullmatch(r'_[^_]+_', seg):
            out.append(seg)
        elif out and out[-1].endswith("_") and re.fullmatch(r'["\u201d\u2019\'.,!?]+', seg.strip()):
            out[-1] = out[-1][:-1] + seg.strip() + "_"
        else:
            out.append(seg.strip())
    return out or [line]

def wrap_rich_text(d, line, size, max_width, base_idx=F_MED, accent_idx=None):
    """완결 문장을 폭에 맞춰 단어 단위로 wrap (레퍼런스 현행: 본문은 \\n 없이 자연 줄바꿈).
    [강조] 마크업이 줄 경계에 걸리면 닫고 다음 줄에 다시 연다. _밑줄_은 줄마다 유지."""
    accent_idx = base_idx if accent_idx is None else accent_idx
    text = str(line or "")
    underline = text.startswith("_")
    inner = text.strip("_") if underline else text

    def measure(s):
        return rich_width(d, parse_rich(s, base_idx=base_idx, accent_idx=accent_idx), size, base_idx)

    if measure(inner) <= max_width:
        return [text]

    lines = []
    cur = ""
    hot_carry = False
    for word in inner.split(" "):
        candidate = f"{cur} {word}".strip()
        probe = ("[" + candidate) if hot_carry else candidate
        if cur and measure(probe) > max_width:
            emit = ("[" + cur) if hot_carry else cur
            if emit.count("[") > emit.count("]"):
                emit += "]"
                hot_carry = True
            else:
                hot_carry = False
            lines.append(emit)
            cur = word
        else:
            cur = candidate
    if cur:
        emit = ("[" + cur) if hot_carry else cur
        if emit.count("[") > emit.count("]"):
            emit += "]"
        lines.append(emit)
    if underline:
        lines = [f"_{ln}_" for ln in lines]
    return lines

def rich_width(d, parts, size, idx=F_REG):
    total = 0
    for part in parts:
        if len(part) == 2:
            t, _ = part
            part_idx = idx
        else:
            t, _, part_idx = part
        total += d.textlength(t, font=font(size, part_idx))
    return total

def fit_cover_sizes(d, headline, kicker):
    default_size = 86
    size = default_size
    lines = split_lines(headline)
    max_width = W - 144
    min_top = int(H * 0.45)
    while size >= MIN_FONT_SIZE:
        line_gap = int(size * 1.22)
        y = H - 170 - len(lines) * line_gap
        widths = [rich_width(d, parse_rich(ln, base=WHITE, accent=SKY), size, F_BOLD) for ln in lines]
        kicker_size = max(MIN_FONT_SIZE, int(round(size * 40 / 86)))
        kicker_ok = True
        if kicker:
            kicker_width = d.textbbox((0, 0), kicker, font=font(kicker_size, F_SEMI))[2]
            kicker_ok = kicker_width <= max_width and (y - 64) >= min_top
        if widths and max(widths) <= max_width and y >= min_top and kicker_ok:
            return size, kicker_size, size != default_size, False
        size -= 2
    return MIN_FONT_SIZE, MIN_FONT_SIZE, True, True

def fit_body_sizes(d, subtitle, paragraphs, theme="dark", line_spacing=None,
                   subtitle_size=None, body_size=None):
    is_light = theme == "light"
    # 아카이브는 카드가 커서(0.52H) 텍스트 존이 좁다 — 기본 폰트도 레퍼런스 실측 스케일로 한 단계 작게
    default_subtitle = 46 if is_light else 54
    default_body = 36 if is_light else 40
    # 간격 게이지는 폰트 크기에 영향을 주지 않는다(유저 2026-06-12) — 핏 계산은 기본 간격(1.4) 고정.
    # 간격을 키워 넘치면 폰트를 줄이는 대신 WARN:overflow로 알린다.
    line_factor = 1.4
    gap = para_gap(line_factor, is_light)
    pw, ph, px, py, text_gap = body_geometry(theme)
    start_y = py + ph + text_gap
    max_y = H - 110
    # 아카이브는 사진 카드 폭에 맞춘 왼쪽 정렬이라 가용 폭 = 카드 폭
    max_width = pw if is_light else W - 140
    # 폭 초과는 해당 텍스트만 줄인다(한 줄 긴 소제목이 본문까지 끌어내리지 않게, 유저 2026-06-13).
    # 세로 초과는 기존처럼 둘 다 줄인다.
    delta_st = 0
    delta_bd = 0
    while True:
        # 수동 오버라이드는 핏이 건드리지 않는다(축소 대상에서 제외)
        st = subtitle_size if subtitle_size else max(MIN_FONT_SIZE, default_subtitle - delta_st)
        bd = body_size if body_size else max(MIN_FONT_SIZE, default_body - delta_bd)
        y = start_y
        st_wide = False
        bd_wide = False
        for ln in split_lines(subtitle):
            width = rich_width(d, [(ln, WHITE)], st, F_BOLD)
            if width > max_width:
                st_wide = True
            y += int(st * 1.5)
        y += 18
        for para in paragraphs:
            for raw0 in split_lines(para):
              for raw in split_underline_spans(raw0):
                for ln in wrap_rich_text(d, raw, bd, max_width,
                                         base_idx=F_MED,
                                         accent_idx=F_BOLD):
                    width = rich_width(
                        d,
                        parse_rich(
                            ln.strip("_"),
                            base=WHITE,
                            accent=LIME,
                            base_idx=F_MED,
                            accent_idx=F_BOLD,
                        ),
                        bd,
                        F_MED,
                    )
                    if width > max_width:
                        bd_wide = True
                    y += int(bd * line_factor)
            y += gap
        shrunk = (delta_st + delta_bd) > 0
        if not st_wide and not bd_wide and y <= max_y:
            return st, bd, shrunk, False
        st_can = not subtitle_size and st > MIN_FONT_SIZE
        bd_can = not body_size and bd > MIN_FONT_SIZE
        progressed = False
        if st_wide and st_can:
            delta_st += 2
            progressed = True
        if bd_wide and bd_can:
            delta_bd += 2
            progressed = True
        if not st_wide and not bd_wide:
            # 세로만 초과 — 둘 다 한 단계씩
            if st_can:
                delta_st += 2
                progressed = True
            if bd_can:
                delta_bd += 2
                progressed = True
        if not progressed:
            return st, bd, shrunk, True

def fit_ending_size(d, headline):
    default_size = 56
    size = default_size
    max_width = W - 160
    card_top = int(H * 0.28)
    while size >= MIN_FONT_SIZE:
        y = int(H * 0.13)
        overflow = False
        for ln in split_lines(headline):
            width = rich_width(d, parse_rich(ln.strip("_"), base=WHITE, accent=WHITE, base_idx=F_BOLD), size, F_BOLD)
            if width > max_width:
                overflow = True
            y += int(size * 1.55)
        if not overflow and y <= card_top - 36:
            return size, size != default_size, False
        size -= 2
    return MIN_FONT_SIZE, True, True

def resolve_photo_path(photo, spec_dir):
    if not photo:
        return None
    if os.path.isabs(photo):
        return photo
    return os.path.normpath(os.path.join(spec_dir, photo))

def normalize_out_path(outdir, slide, index, spec_dir):
    out = slide.get("out")
    if isinstance(out, str) and out:
        return out if os.path.isabs(out) else os.path.normpath(os.path.join(spec_dir, out))
    base_outdir = outdir if os.path.isabs(outdir) else os.path.normpath(os.path.join(spec_dir, outdir))
    return os.path.join(base_outdir, f"{index:02d}_{slide['type']}.png")

def draw_overlays(out_path, overlays):
    """사용자가 에디터에서 드래그로 배치한 자유 텍스트를 최종 PNG 위에 그린다.
    좌표는 0~1 비율(중심 기준), size는 1080폭 캔버스 기준 px. 가독 위해 다크 스트로크."""
    if not overlays:
        return
    im = Image.open(out_path).convert("RGB")
    d = ImageDraw.Draw(im)
    for ov in overlays:
        text = str(ov.get("text", "")).strip()
        if not text:
            continue
        size = int(max(16, min(180, ov.get("size", 48))))
        weight = F_BOLD if ov.get("weight", "bold") != "regular" else F_MED
        col = ov.get("color", "#ffffff")
        try:
            col = col.lstrip("#"); rgb = (int(col[0:2], 16), int(col[2:4], 16), int(col[4:6], 16))
        except Exception:
            rgb = WHITE
        f = font(size, weight)
        cx = float(ov.get("xPct", 0.5)) * W
        cy = float(ov.get("yPct", 0.5)) * H
        lines = text.split("\n")
        lh = int(size * 1.22)
        total = lh * len(lines)
        y = cy - total / 2
        for ln in lines:
            w = d.textlength(ln, font=f)
            x = cx - w / 2
            d.text((x, y), ln, font=f, fill=rgb,
                   stroke_width=max(2, size // 18), stroke_fill=(10, 12, 18))
            y += lh
    im.save(out_path)

def run_spec(path, only_index=None):
    with open(path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    brand = spec.get("brand", "MAG")
    outdir = spec.get("outdir", "out")
    theme = str(spec.get("theme", "dark")).lower()
    if theme not in ("dark", "light"):
        theme = "dark"
    spec_dir = os.path.dirname(os.path.abspath(path))
    base_outdir = outdir if os.path.isabs(outdir) else os.path.normpath(os.path.join(spec_dir, outdir))
    os.makedirs(base_outdir, exist_ok=True)
    outs = []
    warns = []
    slides = spec.get("slides", [])
    for i, s in enumerate(slides, 1):
        zero_index = i - 1
        if only_index is not None and zero_index != only_index:
            continue
        out = normalize_out_path(outdir, s, i, spec_dir)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        photo = resolve_photo_path(s.get("photo"), spec_dir)
        if s["type"] == "cover":
            prebuilt = resolve_photo_path(s.get("prebuilt"), spec_dir)
            if prebuilt and os.path.exists(prebuilt):
                # 완성 커버(히어로 합성 등)는 그대로 출고 — 텍스트/그라데이션 재적용 안 함
                Image.open(prebuilt).convert("RGB").resize((W, H)).save(out)
            else:
                cover(s["headline"], photo, brand, out, s.get("kicker"), theme=theme,
                      bw=bool(s.get("bw", False)), kicker_bg=s.get("kickerBg"))
        elif s["type"] == "body":
            body(s["subtitle"], s["paragraphs"], photo, brand, out,
                 accent=tuple(s.get("accent", SKY)), hot=tuple(s.get("hot", LIME)),
                 theme=theme, bw=bool(s.get("bw", False)),
                 line_spacing=s.get("lineSpacing"), source=s.get("source"),
                 subtitle_size=s.get("subtitleSize"), body_size=s.get("bodySize"),
                 text_pos=s.get("bodyPos"))
        elif s["type"] == "ending":
            ending(s["headline"], photo, brand, out,
                   accent=tuple(s.get("accent", ORANGE)), theme=theme,
                   headline_pos=s.get("headlinePos"))
        draw_overlays(out, s.get("overlays") or [])
        if LAST_RENDER_META["clipped"]:
            warns.append(f"WARN:overflow:{zero_index}")
        elif LAST_RENDER_META["shrunk"]:
            warns.append(f"WARN:shrunk:{zero_index}")
        if not (photo and os.path.exists(photo)):
            # 이미지 미배정 → 회색 플레이스홀더가 그대로 출고되는 사고 방지 (2026-06-12 엔딩 빈 카드)
            warns.append(f"WARN:placeholder:{zero_index}")
        outs.append(out)
    lines = warns + outs
    if lines:
        print("\n".join(lines))

def demo():
    os.makedirs("out", exist_ok=True)
    cover("AI 토큰이\n사람보다 비싸졌다", brand="MAG", out="out/01_cover.png")
    body("기업들의 기조가 바뀌고 있습니다",
         ["우버는 올해 클로드 코드 할당량을\n이미 다 써버렸습니다.",
          "이제는 토큰 맥싱이 아니라\n[토큰 효율화]가 경쟁력입니다.",
          "_먼저 많이 써본 사람이 이깁니다._"],
         brand="MAG", out="out/02_body.png")
    ending("다음 격차는\n여기서 벌어집니다", brand="MAG", out="out/03_ending.png")
    print("out/01_cover.png\nout/02_body.png\nout/03_ending.png")

def parse_only_arg(argv):
    if not argv:
        return None
    if argv[0] == "--only":
        if len(argv) < 2:
            raise SystemExit("missing value for --only")
        return int(argv[1])
    return int(argv[0])

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "json":
        if len(sys.argv) < 3:
            raise SystemExit("missing spec path")
        only = parse_only_arg(sys.argv[3:]) if len(sys.argv) > 3 else None
        run_spec(sys.argv[2], only)
    else:
        demo()
