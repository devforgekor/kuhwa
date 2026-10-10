#!/bin/bash
# run.sh — opencode2 격리 세션 실행기 (devforge 계승 + kuhwa 적응)
# Usage: ./run.sh [opencode args...]   예: ./run.sh mcp list
#
# [WHY] --userns=host: daemon userns-remap(opc) 하에서 /opt/kuhwa·Obsidian(1001 소유)
#   쓰기를 위해 Docker 공식 예외 경로를 사용한다. 데몬 remap 은 유지된다.
#   (컨테이너 uid 1001 = host 1001 직접 매핑).
# [WARNING] 이미지 내 chown 은 금지(remap 빌드 = 디스크 101001). seed 는 host
#   디렉터리를 선생성해 bind 로 해결한다. named volume 미사용(과거 계획 대비 변경).
# 격리: host ~/.local/share/opencode (DB 81MB) 미마운트 — opencode2 전용 host 디렉터리
#   opencode2 를 쓴다. host DB mtime 불변이 검증 게이다.
# 인증 격리: host auth.json 은 애초에 없다(무료 모델 전용). 컨테이너도 0B auth.json
#   만 쓴다 — 유료 키 마운트 라인을 재추가하지 말 것.
# 이그레스(A): 외부 API 를 WARP sidecar(127.0.0.1:40000) 로 보내 IP 버킷을 분리한다.
#   NO_PROXY 필수 — 빠지면 localhost MCP 가 프록시를 타고 죽는다. sidecar 미기동 시
#   경고 후 호스트 IP 로 우회(무중단). --network host 는 --userns=host 와 짝 필수
#   (remap 컨테이너와는 불가 조합 — Docker docs known limitations).
set -euo pipefail

DATA=/home/ubuntu/.local/share/opencode2       # → 컨테이너 ~/.local/share/opencode
STATE=/home/ubuntu/.local/state/opencode2      # → 컨테이너 ~/.local/state
CACHE=/home/ubuntu/.cache/opencode2            # → 컨테이너 ~/.cache
mkdir -p "$DATA" "$STATE/opencode" "$CACHE"
[ -f "$DATA/auth.json" ] || : > "$DATA/auth.json"
[ -f "$STATE/opencode/model.json" ] || printf '%s' \
  '{"recent":[{"providerID":"opencode","modelID":"mimo-v2.6-flash-free"}],"favorite":[],"variant":{}}' \
  > "$STATE/opencode/model.json"

PROXY_ENV=()
if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/40000' 2>/dev/null; then
  PROXY_ENV=(
    -e HTTPS_PROXY=http://127.0.0.1:40000
    -e HTTP_PROXY=http://127.0.0.1:40000
    -e 'NO_PROXY=localhost,127.0.0.1,::1'
  )
else
  echo "run.sh: WARP sidecar 127.0.0.1:40000 미기동 — 호스트 IP로 이그레스합니다" >&2
fi

# [WHY] TTY 조건부 — 대화형은 -it(정상), 게이트/스크립트 환경은 -i (docker run -it 가
#   non-TTY 에서 즉시 실패한다). 동작은 동일.
TTY_ENV=(-i)
[ -t 0 ] && [ -t 1 ] && TTY_ENV=(-it)

exec docker run "${TTY_ENV[@]}" --rm \
  --userns=host --user 1001:1001 \
  --network host \
  -e TERM -e HOME=/home/ubuntu \
  "${PROXY_ENV[@]}" \
  -v /opt/kuhwa:/opt/kuhwa \
  -v /home/ubuntu/Obsidian:/home/ubuntu/Obsidian \
  -v /home/ubuntu/.config/opencode2:/home/ubuntu/.config/opencode:ro \
  -v "$DATA":/home/ubuntu/.local/share/opencode \
  -v "$STATE":/home/ubuntu/.local/state \
  -v "$CACHE":/home/ubuntu/.cache \
  --memory 2g --pids-limit 512 \
  opencode-kuhwa:latest "$@"
