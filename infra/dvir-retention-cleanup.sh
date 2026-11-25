#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# dvir-retention-cleanup.sh — expira fotos de vistoria conforme a retenção
# configurada por organização (default 12 meses) e vigia o disco do uploads.
#
#  • lê hj_dvir_retention_config (organization_id → retention_months)
#  • apaga do disco e do banco as fotos mais velhas que a retenção da org
#  • registra o log da expurgo (quantidade, bytes, por organização)
#  • se o disco de /opt/hermes-fleetbase/uploads passar de 80% → alerta NTFY
#
# Cron: 0 4 * * *  (/etc/cron.d/hermes-fleetbase-dvir-cleanup)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

FB_LOG_NAME="dvir-cleanup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/opt/hermes-fleetbase/infra/bin/fb-lib.sh
. "$SCRIPT_DIR/bin/fb-lib.sh"

UPLOADS_DIR="${UPLOADS_DIR:-/opt/hermes-fleetbase/uploads}"
DISK_ALERT_PCT="${DISK_ALERT_PCT:-80}"
DEFAULT_RETENTION_MONTHS="${DEFAULT_RETENTION_MONTHS:-12}"
LOG_DIR="${FB_LOG_DIR:-/var/log/hermes-fleetbase}"
PURGE_LOG="$LOG_DIR/dvir-purge.log"

fb_self_elevate "$@"

fb_db_env
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
mkdir -p "$LOG_DIR" 2>/dev/null

echo "=== [${STAMP}] INÍCIO DA EXPURGO DVIR ===" >> "$PURGE_LOG"

# ── 1. selectiona fotos expiradas ──────────────────────────────────────────
# Cada organização tem sua própria janela de retenção. As orgs sem config
# usam o default (12 meses).
QUERY="
SELECT p.id, p.organization_id, p.relative_path, p.file_size_bytes,
       COALESCE(c.retention_months, ${DEFAULT_RETENTION_MONTHS}) AS months,
       DATE_SUB(NOW(), INTERVAL COALESCE(c.retention_months, ${DEFAULT_RETENTION_MONTHS}) MONTH) AS limite
  FROM hj_dvir_photos p
  LEFT JOIN hj_dvir_retention_config c ON c.organization_id = p.organization_id
 WHERE p.created_at < DATE_SUB(NOW(), INTERVAL COALESCE(c.retention_months, ${DEFAULT_RETENTION_MONTHS}) MONTH)"

TOTAL_BEFORE=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM hj_dvir_photos;" 2>/dev/null || echo 0)
BYTES_BEFORE=$(fb_mysql -N -B -e "SELECT COALESCE(SUM(file_size_bytes),0) FROM hj_dvir_photos;" 2>/dev/null || echo 0)

EXPIRED=$(fb_mysql -N -B -e "$QUERY" 2>/dev/null)
if [ -z "$EXPIRED" ]; then
  echo "[${STAMP}] nenhuma foto expirada (total em banco: ${TOTAL_BEFORE})" >> "$PURGE_LOG"
  echo "=== [${STAMP}] FIM (0 foto expirada) ===" >> "$PURGE_LOG"
  fb_log "expurgo DVIR: 0 foto expirada"
else
  DELETED=0
  FREED=0
  while IFS=$'\t' read -r pid org relpath size months limite; do
    [ -z "$pid" ] && continue
    # o caminho é SEMPRE relativo a UPLOADS_DIR e vem do servidor — ainda assim
    # rejeitamos qualquer tentativa de escapar da raiz.
    case "$relpath" in
      *..*|/*) echo "[${STAMP}] ignorado (caminho inseguro): ${relpath}" >> "$PURGE_LOG"; continue ;;
    esac
    ABS="${UPLOADS_DIR}/${relpath}"
    if [ -f "$ABS" ]; then
      rm -f "$ABS"
    fi
    fb_mysql -e "DELETE FROM hj_dvir_photos WHERE id = '${pid}';" >/dev/null 2>&1
    DELETED=$((DELETED + 1))
    FREED=$((FREED + ${size:-0}))
    echo "[${STAMP}] foto expirada removida: ${relpath} (org=${org}, retencao=${months}m, limite=${limite})" >> "$PURGE_LOG"
  done <<< "$EXPIRED"

  # remove diretórios de mês que ficaram vazios
  find "$UPLOADS_DIR/dvir" -mindepth 3 -maxdepth 3 -type d -empty -delete 2>/dev/null

  TOTAL_AFTER=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM hj_dvir_photos;" 2>/dev/null || echo 0)
  BYTES_AFTER=$(fb_mysql -N -B -e "SELECT COALESCE(SUM(file_size_bytes),0) FROM hj_dvir_photos;" 2>/dev/null || echo 0)
  FREED_MB=$(( (BYTES_BEFORE - BYTES_AFTER) / 1024 ))
  echo "[${STAMP}] ${DELETED} foto(s) removida(s), ${FREED_MB} MB liberados; banco: ${TOTAL_BEFORE} -> ${TOTAL_AFTER} fotos" >> "$PURGE_LOG"
  echo "=== [${STAMP}] FIM (${DELETED} foto(s), ${FREED_MB} MB) ===" >> "$PURGE_LOG"
  fb_log "expurgo DVIR: ${DELETED} foto(s) removida(s), ${FREED_MB} MB liberados"
fi

# ── 2. vigia de disco ───────────────────────────────────────────────────────
TARGET="$UPLOADS_DIR"
[ -d "$TARGET" ] || TARGET="/"
DF_LINE="$(df -P "$TARGET" 2>/dev/null | tail -1)"
USE_PCT="$(printf '%s' "$DF_LINE" | awk '{gsub("%","",$5); print $5}')"
AVAIL="$(printf '%s' "$DF_LINE" | awk '{print $4}')"
MOUNT="$(printf '%s' "$DF_LINE" | awk '{print $6}')"

if [ -n "${USE_PCT:-}" ] && [ "$USE_PCT" -gt "$DISK_ALERT_PCT" ]; then
  fb_ntfy "Disco do uploads acima de ${DISK_ALERT_PCT}%" \
    "Alvo: ${TARGET}
Uso: ${USE_PCT}% (limite ${DISK_ALERT_PCT}%)
Livre: ${AVAIL} KB
Mount: ${MOUNT}

A retenção DVIR pode não dar conta. Liberar espaço ou ampliar retenção." "high"
  fb_log "DISCO ${TARGET}: ${USE_PCT}% usado (limite ${DISK_ALERT_PCT}%) → alerta NTFY enviado"
else
  fb_log "disco ${TARGET}: ${USE_PCT}% usado (limite ${DISK_ALERT_PCT}%) — ok"
fi

exit 0
