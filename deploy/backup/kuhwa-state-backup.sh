#!/usr/bin/env bash
# kuhwa 서버 상태 백업 → Azure
# 크론: 0 15 * * * (UTC) = 00:00 KST
set -euo pipefail

ACCT="stcommonprodkrc"
CONT="kuhwa-server-backup"
KEEP=7
LOG="${HOME}/kuhwa-backup.log"
ROOT="${HOME}"
APP="${ROOT}/pdf-to-spreadsheet"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TAR="/tmp/kuhwa-state-${STAMP}.tar.gz"
NAME="$(basename "${TAR}")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"${LOG}"; }
die() { log "FAIL: $*"; exit 1; }

cleanup() { rm -f "${TAR}"; }
trap cleanup EXIT
trap 'die "rc=$? at line $LINENO"' ERR

log "start"

tar czf "${TAR}" \
  -C "${APP}" .env instance output uploads \
  -C "${ROOT}" .azure .config ops-archive-20261008 \
  || die "tar failed"

SIZE="$(stat -c%s "${TAR}")"
log "archive ${SIZE} B"

az storage blob upload \
  --account-name "${ACCT}" --container-name "${CONT}" \
  --name "${NAME}" --file "${TAR}" --only-show-errors \
  --auth-mode login --overwrite true --output none >>"${LOG}" 2>&1

REMOTE="$(az storage blob show \
  --account-name "${ACCT}" --container-name "${CONT}" \
  --name "${NAME}" --auth-mode login \
  --query properties.contentLength -o tsv 2>>"${LOG}")"

[ "${SIZE}" = "${REMOTE}" ] || die "size mismatch local=${SIZE} remote=${REMOTE}"
log "uploaded ok"

# 파일명이 YYYYMMDD-HHMMSS 를 포함하므로 name 정렬 = 시간순. 최근 KEEP 건 외 삭제.
az storage blob list --account-name "${ACCT}" --container-name "${CONT}" \
  --auth-mode login --query "[].name" -o tsv 2>>"${LOG}" \
  | sort | head -n "-${KEEP}" \
  | while read -r old; do
      [ -z "${old}" ] && continue
      az storage blob delete --account-name "${ACCT}" --container-name "${CONT}" \
        --name "${old}" --auth-mode login --output none >>"${LOG}" 2>&1 \
        && log "pruned ${old}"
    done

log "done"
