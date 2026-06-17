# carousel-mag

URL·주제를 넣으면 인스타그램용 **매거진 캐러셀**(슬라이드 이미지)과 **스레드 텍스트**를 만들어주는 로컬 툴.
AI 집필/분석은 **본인 Anthropic API 키**로 돌아감 → 쓰는 사람 토큰으로 청구됨.

## 무엇이 필요한가
- **Node.js 18+** (fetch 내장)
- **Python 3** + **Pillow** (`pip3 install Pillow`) — 슬라이드 렌더용
- **Anthropic API 키** — https://console.anthropic.com 에서 발급 + 크레딧 충전
  - ⚠️ 이건 *Claude Pro 채팅 구독*과 다른 **API 종량제 키**(sk-ant-…)

## 실행
```bash
git clone <이 repo>
cd carousel-mag
pip3 install Pillow         # 처음 한 번
node server.js
```
→ 브라우저에서 http://localhost:3080

1. 우측 상단 **설정(⚙️)** → "Anthropic API 키"에 본인 키 붙여넣기 (브라우저에만 저장됨)
2. 대시보드에 **URL + 편집 방향** 입력 → **생성**
3. 슬라이드 편집·내보내기

## 폰트
한글 렌더는 번들된 **Pretendard**(`fonts/`, SIL OFL)를 사용.
macOS는 시스템 폰트(AppleSDGothicNeo)를 자동 사용. 다른 폰트를 쓰려면 `FONT_DIR` 환경변수로 지정.

## AI 백엔드
- 기본: **Anthropic API**(설정에 키 입력 시). 모델은 `CAROUSEL_MODEL` 환경변수로 변경(기본 `claude-sonnet-4-6`).
- 대안: 로컬 **Claude Code CLI**가 있으면 키 없이도 동작 — `CLAUDE_CLI` 환경변수로 실행 파일 경로 지정. (헤드리스 `-p` 호출에 `--no-session-persistence` 플래그를 쓰므로 호환되는 CLI여야 함.)
- 키도 CLI도 없으면 생성은 실패함.

## 디자인
- 캔버스 1080×1350(4:5), 다크네이비 배경, 고딕 단일 패밀리. 슬라이드 레이아웃·톤은 `make_card.py` + `style/`에서 조정.

## 호스팅(여러 명이 링크로)
서버리스(Vercel)는 불가 — python 렌더·장시간 잡 때문. 컨테이너 호스트(Railway/Render/Fly.io)용 `Dockerfile` 포함. 자세한 건 `DEPLOY.md`.

## 라이선스
앱 코드: 개인 프로젝트. 번들 폰트 Pretendard: `fonts/LICENSE.txt`(SIL OFL).
