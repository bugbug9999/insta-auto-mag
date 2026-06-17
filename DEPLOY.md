# carousel-mag 멀티유저 배포 (각자 API 키)

## 구조
- AI 호출 = 사용자 브라우저가 보낸 `x-anthropic-key` 헤더의 키로 Anthropic API 직접 호출 → **각 사용자 토큰으로 청구**.
- 키 없으면 생성 안 됨(컨테이너엔 Claude CLI 없음). 키는 브라우저 localStorage에만 저장, 서버 미보관.
- 렌더 = python3 + Pillow + Pretendard(한글) 폰트.

## 사용자 사용법
1. console.anthropic.com 에서 API 키 발급(+크레딧 충전).
2. 사이트 접속 → 설정(⚙️) → "Anthropic API 키"에 붙여넣기.
3. URL + 편집 방향 입력 → 생성.

## 호스팅 (Vercel 불가 — python 렌더+장시간 잡+파일저장 때문에 서버리스 X)
컨테이너 호스트 권장: **Railway / Render / Fly.io**.

### Railway (가장 간단)
1. railway.app 가입(GitHub 연동).
2. 이 폴더를 GitHub repo로 push.
3. New Project → Deploy from repo → Dockerfile 자동 감지.
4. 배포되면 도메인 발급 → 지인에게 공유.

### Fly.io
1. `fly launch` (Dockerfile 감지) → `fly deploy`.
2. PORT/HOST는 Dockerfile env로 이미 0.0.0.0 처리됨.

## ⚠️ 첫 빌드에서 확인할 것
- **폰트 다운로드**: Dockerfile의 Pretendard zip 내부 경로(`find ... Pretendard-*.otf`)가 실제 릴리스 구조와 맞는지. 빌드 로그의 `ls -la /app/fonts`에 4개 .otf가 보여야 함. 안 보이면 렌더가 □□□로 깨짐.
- **저장소**: data/posts는 컨테이너 재시작 시 사라짐(임시). 영구 보관 필요하면 볼륨 마운트.

## 남은 보강 (선택)
- 키별/IP 레이트리밋(남용 방지) — 미구현.
- settings PUT 보호(공개 호스트에서 누구나 톤/브랜드 변경 가능) — 미구현.
