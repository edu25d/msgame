# 🎹 도레미 악보 읽기 챌린지 (Doremi Sheet Music Reading Challenge)

> 웹 피아노 악보 읽기 스피드런 대결 게임입니다.  
> 높은음자리표와 낮은음자리표의 계이름을 빠르게 읽고 연주하여 최고 점수와 랭킹에 도전하세요!

---

## 🚀 주요 기능

- **실시간 악보 렌더링 & 포커싱**: OSMD (OpenSheetMusicDisplay) 기반 벡터 악보, 자연스러운 네온 포커스 아우라, 가로 스냅 스크롤.
- **디딤돌 힌트 시스템**: 연주가 막히면 이전 음과의 도수(계단) 차이 화살표 및 건반 가이드가 단계별로 제공됩니다.
- **터치/마우스 피아노 건반**: 옥타브별 온스크린 건반과 Web Audio API 고품질 신디사이저 사운드.
- **실시간 리더보드 (Vercel KV)**: Vercel Serverless Function (`/api/rank`) 및 Upstash Redis Sorted Sets(`ZSET`) 기반 초고속 TOP 20 랭킹.
- **오프라인 로컬 폴백 (LocalStorage)**: 네트워크가 끊기거나 KV 환경 변수가 없어도 끊김 없이 로컬 순위로 자동 전환.

---

## 🛠️ 기술 스택

- **Frontend**: Vanilla HTML5, CSS3, ES Modules, OpenSheetMusicDisplay, Canvas Confetti
- **Backend**: Vercel Serverless Function (Node.js native `fetch`)
- **Database**: Vercel KV (Upstash Redis Sorted Sets)
- **Deployment**: Vercel

---

## ⚡ Vercel 배포 & Vercel KV 연동 가이드

1. **GitHub 저장소 연결**: Vercel 대시보드에서 `New Project` ➔ 이 저장소(`msgame`)를 Import합니다.
2. **Vercel KV (Upstash Redis) 생성**:
   - Vercel 대시보드 상단 메뉴 **Storage** 클릭
   - **Create Database** ➔ **KV** 선택 (무료 티어로 일 10,000건 제공)
   - 생성 후 **Connect to Project**를 눌러 본 프로젝트(`msgame`)에 연결합니다.
   - 환경 변수(`KV_REST_API_URL`, `KV_REST_API_TOKEN`)가 프로젝트에 자동 등록됩니다.
3. **배포 (Deploy)**:
   - 별도 빌드 설정 없이 즉시 배포 완료됩니다.
   - 이후 사이트에 접속하여 게임을 플레이하면 실시간 전국 랭킹이 Vercel KV에 자동 기록됩니다.
