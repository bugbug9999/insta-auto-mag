# carousel-mag — 멀티유저 호스팅 이미지 (node 서버 + python/PIL 렌더 + 한글폰트)
# 빌드/실행: 컨테이너 호스트(Railway/Render/Fly.io)에서. AI 호출은 사용자별 API 키(헤더)로.
FROM node:22-slim

# python3 + PIL + 렌더 보조 도구(yt-dlp는 유튜브 소스용, 없어도 기사/스레드는 동작)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      ffmpeg curl unzip ca-certificates fontconfig \
    && rm -rf /var/lib/apt/lists/*

# PIL(Pillow) + yt-dlp — PEP668 우회 위해 --break-system-packages
RUN pip3 install --no-cache-dir --break-system-packages Pillow yt-dlp

WORKDIR /app

# 한글 폰트(Pretendard, OFL) — make_card.py가 FONT_DIR에서 weight별 .otf를 읽음.
# ⚠️ 첫 빌드에서 zip 내부 경로 확인 필요(아래 member 경로가 릴리스 구조와 맞아야 함).
RUN mkdir -p /app/fonts \
    && curl -fsSL -o /tmp/pretendard.zip \
       https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip \
    && unzip -o /tmp/pretendard.zip -d /tmp/pretendard \
    && find /tmp/pretendard -name 'Pretendard-Bold.otf'     -exec cp {} /app/fonts/ \; \
    && find /tmp/pretendard -name 'Pretendard-SemiBold.otf' -exec cp {} /app/fonts/ \; \
    && find /tmp/pretendard -name 'Pretendard-Medium.otf'   -exec cp {} /app/fonts/ \; \
    && find /tmp/pretendard -name 'Pretendard-Regular.otf'  -exec cp {} /app/fonts/ \; \
    && rm -rf /tmp/pretendard /tmp/pretendard.zip \
    && ls -la /app/fonts

# 앱 소스
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .

ENV FONT_DIR=/app/fonts
ENV NODE_ENV=production
# 컨테이너는 0.0.0.0 바인딩 필요 — server.js가 HOST env를 읽도록 되어 있어야 함(아래 패치 참조).
ENV HOST=0.0.0.0
ENV PORT=3080
EXPOSE 3080

CMD ["node", "server.js"]
