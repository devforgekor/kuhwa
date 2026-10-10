# apps/portal — kuhwa 서비스 포털

`taxonomy/concepts.yml` 단일 소스에서 정적 `dist/index.html`을 빌드하는 포털.

## 파일

| 파일 | 역할 |
|---|---|
| `taxonomy/concepts.yml` | 분류 체계 단일 소스 (트리↔YAML 1:1) |
| `template.html` | GitHub풍 골격 — `<!--TREE-->` `<!--ROWS-->` `<!--BREADCRUMB-->` 자리 |
| `build.mjs` | Node20·의존성0 빌더 + 규칙 검증 게이트 (위반 시 exit 1) |
| `dist/index.html` | 빌드 산출물 (git 미추적 — CI가 서버로 rsync) |

## 빌드

```sh
node apps/portal/build.mjs
```

검증 규칙(계획서 5장): 1 ID 중복·집합 동치 / 2 참조 유효성 / 3 children↔broader /
4 type 용어집 / 5 path 형식·예외 / 6 L0 고정4개 / 7 portal-row=리프 수 / 8 version bump 경고.

## 배포

`portal-build.yml` — `apps/portal/**` push 시 자동 빌드→rsync `/var/www/kuhwa/`.
시크릿: `KUHWA_SSH_KEY`(배포 전용 키), `KUHWA_DEPLOY_USER`.
