# kuhwa

한국구화학교 사이트 모노레포입니다. 저장소 루트는 Vercel 프로젝트의 `rootDirectory`로 사용하지 않으므로,
각 앱은 반드시 `apps/` 아래에 배치합니다 (2026-10-08 재편).

## 저장소 구조

```
/opt/kuhwa/
├── apps/
│   ├── schedule/     # 학사일정 사이트 (Vercel: kuhwa)
│   ├── cashbook/     # 가계부     (Vercel: mini-cashbook, rootDirectory = apps/cashbook/frontend)
│   └── timetable/    # 시간표     (Vercel: mini-timetable)
├── etxfetch/         # 전자교과서 OCI on-demand 캐시 페처 (systemd: etxfetch.service)
└── docker-compose.yml
```

## apps/schedule — 학사일정

한국구화학교(서울특별시교육청, 학교코드 7010473)의 학사일정만 보여주는 서버 없는(Vercel 서버리스) 웹사이트입니다.

- `apps/schedule/public/index.html` — 정적 프론트엔드. `/api/schedule`를 호출해 학사일정을 연도별로 보여줍니다.
- `apps/schedule/api/schedule.js` — Vercel 서버리스 함수. NEIS(교육정보 개방 포털) `SchoolSchedule` API를 호출해 한국구화학교의 학사일정을 조회하고, 학교급(초/중/고 등) 중복을 병합해 JSON으로 반환합니다.
- `apps/schedule/scripts/fetch-schedule.js` — NEIS 데이터를 정적 파일로 미리 받아 `apps/schedule/public/data/{year}.json`에 저장하고 커밋·푸시합니다.

### 환경변수

Vercel 프로젝트에 아래 환경변수가 필요합니다.

- `NEIS_API_KEY` — NEIS Open API 인증키

### 로컬 개발

```bash
cd apps/schedule
npm ci
npm install -g vercel   # 최초 1회
vercel dev
```

## 배포

이 저장소는 Vercel 프로젝트 3개에 연결되며, **각 프로젝트의 `rootDirectory`가 재편에 맞춰져 있어야** 합니다.

| Vercel 프로젝트 | projectId | rootDirectory |
|---|---|---|
| `kuhwa` | `prj_TBAJ1w7MsHhxBm51rwbNBYopv1ex` | `apps/schedule` |
| `mini-cashbook` | `prj_QBezAF62BvVw4YA70I3mVIL6zEZw` | `apps/cashbook/frontend` |
| `mini-timetable` | `prj_rvPCSamTzjTeOL1iaP2KW3KYN7cH` | `apps/timetable` |

GitHub Actions(`.github/workflows/update-schedule.yml`)는 `defaults.run.working-directory: apps/schedule`로 실행됩니다.
