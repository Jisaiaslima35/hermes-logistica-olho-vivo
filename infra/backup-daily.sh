#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-daily.sh — backup diário do Hermes Logística & Olho Vivo
#
#  • mysqldump comprimido (gz) do banco fleetbase_db
#  • tar.gz das fotos de vistoria (uploads/)
#  • manifest com sha256 (pronto para rclone: nomes estável + manifesto)
#  • retenção de 7 dias
#
# Uso:
#   backup-daily.sh                 → só o backup (o que o cron roda)
#   backup-daily.sh --restore-test  → backup + RESTAURAÇÃO REAL num banco
#                                      temporário fleetbase_restore_test,
#                                      valida e APAGA o temporário
#
# Cron: 0 3 * * *  (/etc/cron.d/hermes-fleetbase-backup)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

FB_LOG_NAME="backup-daily"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/opt/hermes-fleetbase/infra/bin/fb-lib.sh
. "$SCRIPT_DIR/bin/fb-lib.sh"

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/hermes-fleetbase}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
UPLOADS_DIR="${UPLOADS_DIR:-/opt/hermes-fleetbase/uploads}"
RESTORE_DB="${RESTORE_DB:-fleetbase_restore_test}"
RCLONE_DEST="${RCLONE_DEST:-}"      # ex.: rclone:caminho/hermes-fleetbase
DO_RESTORE_TEST=0

for arg in "$@"; do
  case "$arg" in
    --restore-test) DO_RESTORE_TEST=1 ;;
  esac
done

fb_self_elevate "$@"

STAMP="$(date '+%Y%m%d-%H%M%S')"
DAY="$(date '+%Y-%m-%d')"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT" 2>/dev/null

DB_DUMP="$BACKUP_ROOT/fleetbase_db-${STAMP}.sql.gz"
UPLOAD_TAR="$BACKUP_ROOT/uploads-${STAMP}.tar.gz"
MANIFEST="$BACKUP_ROOT/manifest-${STAMP}.txt"

fb_log "=== BACKUP INICIADO (stamp=${STAMP}) ==="
fb_log "destino=${BACKUP_ROOT} retencao=${RETENTION_DAYS}d"

# ── 1. dump do banco ────────────────────────────────────────────────────────
fb_db_env
if fb_mysqldump "$DB_NAME" | gzip -6 > "$DB_DUMP" 2>/dev/null; then
  DB_SIZE=$(stat -c %s "$DB_DUMP" 2>/dev/null || echo 0)
  fb_log "dump OK: $(basename "$DB_DUMP") (${DB_SIZE} bytes)"
else
  fb_log "ERRO: falhou o dump do banco ${DB_NAME}"
  fb_ntfy "Backup falhou — dump do banco" "Não consegui gerar o dump de ${DB_NAME} em ${DB_DUMP}." "high"
  exit 1
fi

# ── 2. tar das fotos de vistoria ────────────────────────────────────────────
if [ -d "$UPLOADS_DIR" ]; then
  tar -czf "$UPLOAD_TAR" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>/dev/null \
    && fb_log "uploads OK: $(basename "$UPLOAD_TAR") ($(stat -c %s "$UPLOAD_TAR") bytes)" \
    || fb_log "AVISO: falha ao compactar ${UPLOADS_DIR}"
else
  fb_log "AVISO: ${UPLOADS_DIR} não existe — pulando tar de uploads"
fi

# ── 3. manifesto (rclone-ready) ────────────────────────────────────────────
{
  echo "# Hermes Logística & Olho Vivo — manifesto de backup"
  echo "stamp=$STAMP"
  echo "date=$DAY"
  echo "host=$(hostname)"
  echo "db=$DB_NAME"
  echo "uploads_dir=$UPLOADS_DIR"
  echo "retention_days=$RETENTION_DAYS"
  echo "--- sha256 ---"
  ( cd "$BACKUP_ROOT" && sha256sum "$(basename "$DB_DUMP")" "$(basename "$UPLOAD_TAR")" 2>/dev/null )
} > "$MANIFEST"
fb_log "manifest: $(basename "$MANIFEST")"

# symlink "latest" (facilita o rclone copy)
ln -sf "$(basename "$DB_DUMP")" "$BACKUP_ROOT/latest-db.sql.gz" 2>/dev/null
ln -sf "$(basename "$UPLOAD_TAR")" "$BACKUP_ROOT/latest-uploads.tar.gz" 2>/dev/null

# ── 4. retenção (7 dias) ────────────────────────────────────────────────────
REMOVED=$(find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'fleetbase_db-*.sql.gz' -o -name 'uploads-*.tar.gz' -o -name 'manifest-*.txt' \) -mtime +"$RETENTION_DAYS" -print -delete 2>/dev/null | wc -l)
fb_log "retenção: ${REMOVED} arquivo(s) com mais de ${RETENTION_DAYS} dias removido(s)"

# ── 5. rclone (opcional — só se RCLONE_DEST estiver definido) ──────────────
if [ -n "$RCLONE_DEST" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$BACKUP_ROOT" "$RCLONE_DEST" --include 'fleetbase_db-*' --include 'uploads-*' --include 'manifest-*' --exclude '*' \
      && fb_log "rclone copy OK -> ${RCLONE_DEST}" \
      || fb_log "ERRO: rclone copy falhou para ${RCLONE_DEST}"
  else
    fb_log "AVISO: rclone não instalado — cópia externa pulada"
  fi
fi

# ── 6. TESTE DE RESTAURAÇÃO REAL (opcional) ────────────────────────────────
# Resolve o schema alvo do teste:
#  1) tenta criar ${RESTORE_DB} (padrão fleetbase_restore_test) — exige CREATE DATABASE
#  2) se o usuário da app não tiver esse privilégio, cai para ${FALLBACK_RESTORE_DB}
#     (fleetbase_db_sandbox — schema vazio e descartável, com privilégio total)
#     e remove tudo o que restaurou ao final.
if [ "$DO_RESTORE_TEST" = "1" ]; then
  fb_log "--- TESTE DE RESTAURAÇÃO REAL (alvo preferido: ${RESTORE_DB}) ---"
  fb_db_env
  TARGET_DB="$RESTORE_DB"
  TARGET_IS_TEMP_DB=1

  fb_mysql -e "DROP DATABASE IF EXISTS \`${RESTORE_DB}\`; CREATE DATABASE \`${RESTORE_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    TARGET_DB="${FALLBACK_RESTORE_DB:-fleetbase_db_sandbox}"
    TARGET_IS_TEMP_DB=0
    fb_log "AVISO: o usuário '${DB_USER}' não tem CREATE DATABASE — usando o schema descartável '${TARGET_DB}'"
    fb_mysql -e "SET FOREIGN_KEY_CHECKS=0;" >/dev/null 2>&1
  fi

  if gzip -dc "$DB_DUMP" | docker exec -i "$FB_MYSQL_CONTAINER" mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" "$TARGET_DB" 2>/dev/null; then
    TABLES=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}';" 2>/dev/null)
    HJ_TABLES=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}' AND table_name LIKE 'hj\_%';" 2>/dev/null)
    ORDERS=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM \`${TARGET_DB}\`.hermes_orders;" 2>/dev/null)
    VEH=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM \`${TARGET_DB}\`.hermes_vehicles;" 2>/dev/null)
    fb_log "RESTAURAÇÃO OK em ${TARGET_DB}: ${TABLES} tabela(s) restauradas, ${HJ_TABLES} hj_*, ${ORDERS} pedido(s) em hermes_orders, ${VEH} veículo(s) em hermes_vehicles"

    # limpeza: apaga o banco temporário OU as tabelas restauradas no sandbox
    if [ "$TARGET_IS_TEMP_DB" = "1" ]; then
      fb_mysql -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`;" >/dev/null 2>&1
      fb_log "banco temporário ${TARGET_DB} APAGADO (teste concluído)"
    else
      TBL_LIST="$(fb_mysql -N -B -e "SELECT table_name FROM information_schema.tables WHERE table_schema='${TARGET_DB}';" 2>/dev/null | sed 's/^/DROP TABLE IF EXISTS `/; s/$/`;/' | paste -sd' ')"
      [ -n "$TBL_LIST" ] && fb_mysql -e "SET FOREIGN_KEY_CHECKS=0; ${TBL_LIST}; SET FOREIGN_KEY_CHECKS=1;" >/dev/null 2>&1
      LEFT_TABLES=$(fb_mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}';" 2>/dev/null)
      fb_log "tabelas restauradas removidas de ${TARGET_DB} (restaram ${LEFT_TABLES}) — sandbox limpo, como estava"
    fi
  else
    fb_log "ERRO: restauração falhou em ${TARGET_DB}"
    fb_ntfy "Backup falhou — teste de restauração" "A restauração em ${TARGET_DB} falhou. Dump: $(basename "$DB_DUMP")" "high"
  fi
fi

TOTAL=$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)
fb_log "=== BACKUP CONCLUÍDO — total em disco: ${TOTAL} ==="
fb_ntfy "Backup diário concluído" "Dump: $(basename "$DB_DUMP")
Uploads: $(basename "$UPLOAD_TAR")
Total em disco: ${TOTAL}" "low"
exit 0
