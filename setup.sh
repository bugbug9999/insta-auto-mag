#!/bin/bash
# 매거진 툴 켜기 — Pillow 설치 확인 후 서버 시작 + 브라우저 자동 열기.
# (이 폴더에서 실행: bash setup.sh  또는 Claude Code에 "setup.sh 실행해줘")
cd "$(dirname "$0")" || exit 1

echo "▶ 1/3  파이썬 이미지 라이브러리(Pillow) 확인..."
if ! python3 -c "import PIL" >/dev/null 2>&1; then
  echo "   설치 중..."
  pip3 install Pillow >/dev/null 2>&1 || pip3 install --break-system-packages Pillow >/dev/null 2>&1
fi
if python3 -c "import PIL" >/dev/null 2>&1; then
  echo "   ✅ Pillow 준비됨"
else
  echo "   ❌ Pillow 설치 실패 — python3 / pip3 가 깔려 있는지 확인하세요."
fi

echo "▶ 2/3  Claude(클로드) 명령 확인..."
if command -v claude >/dev/null 2>&1; then
  echo "   ✅ claude 사용 가능 (생성은 당신의 클로드 구독으로 돌아갑니다)"
else
  echo "   ⚠️ 'claude' 명령을 못 찾음. Claude Code가 설치돼 있어야 키 없이 생성됩니다."
  echo "      (또는 앱 설정에 Anthropic API 키를 넣어도 됩니다.)"
fi

echo "▶ 3/3  서버 시작 — 잠시 후 브라우저가 자동으로 열립니다."
echo "   ⚠️ 이 창(터미널)을 닫으면 툴이 꺼집니다. 다 쓸 때까지 열어두세요."
( sleep 3; (open "http://localhost:3080" 2>/dev/null || xdg-open "http://localhost:3080" 2>/dev/null) ) &
node server.js
