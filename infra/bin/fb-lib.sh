#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# fb-lib.sh — utilitários compartilhados da infra do Hermes Logística & Olho Vivo.
#
#  fb_db_env        → exporta DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
#  fb_mysql         → roda mysql no container fleetbase-mysql
#  fb_mysqldump     → roda mysqldump no container fleetbase-mysql
#  fb_ntfy          → publica no NTFY local
#  fb_log           → escreve no log (com self-elevate para root)
#  fb_self_elevate  → re-executa com sudo -n se não for root
#
# REGRA: NUNCA imprimir valor de senha. Só o NOME das variáveis.
# ─────────────────────────────────────────────────────────────────────────────

FB_ROOT="${FB_ROOT:-/opt/hermes-fleetbase}"
FB_ENV_FILE="${FB_ENV_FILE:-$FB_ROOT/infra/env/fleetbase.mysql.env}"
FB_MYSQL_CONTAINER="${FB_MYSQL_CONTAINER:-fleetbase-mysql}"
FB_LOG_DIR="${FB_LOG_DIR:-/var/log/hermes-fleetbase}"
NTFY_URL="${NTFY_URL:-http://127.0.0.1:8088}"
NTFY_TOPIC="${NTFY_TOPIC:-hermes-frota}"

fb_self_elevate() {
  if [ "$(id -u)" != "0" ]; then
    if sudo -n true 2>/dev/null; then
      exec sudo -n -E "$0" "$@"
    fi
  fi
}

fb_log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  mkdir -p "$FB_LOG_DIR" 2>/dev/null
  echo "$msg" >> "$FB_LOG_DIR/${FB_LOG_NAME:-infra}.log" 2>/dev/null
  echo "$msg"
}

# Carrega credenciais: 1) do env file do projeto  2) do container em execução
fb_db_env() {
  if [ -z "${DB_HOST:-}" ] && [ -f "$FB_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$FB_ENV_FILE"
    set +a
  fi
  if [ -z "${DB_HOST:-}" ]; then
    local envdump
    envdump="$(docker inspect fleetbase-web-radio-panel --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)"
    DB_HOST="$(printf '%s' "$envdump" | grep -E '^DB_HOST=' | cut -d= -f2-)"
    DB_USER="$(printf '%s' "$envdump" | grep -E '^DB_USER=' | cut -d= -f2-)"
    DB_PASSWORD="$(printf '%s' "$envdump" | grep -E '^DB_PASSWORD=' | cut -d= -f2-)"
    DB_NAME="$(printf '%s' "$envdump" | grep -E '^DB_NAME=' | cut -d= -f2-)"
  fi
  DB_HOST="${DB_HOST:-fleetbase-mysql}"
  DB_USER="${DB_USER:-fleetbase}"
  DB_NAME="${DB_NAME:-fleetbase_db}"
  DB_PORT="${DB_PORT:-3306}"
  export DB_HOST DB_USER DB_PASSWORD DB_NAME DB_PORT
}

fb_mysql() {
  fb_db_env
  docker exec -i "$FB_MYSQL_CONTAINER" \
    mysql -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" -D"$DB_NAME" \
    --default-character-set=utf8mb4 --batch "$@"
}

# root do MySQL (lê a senha do ambiente do container, NUNCA imprime).
# Necessário para CREATE/DROP DATABASE — o usuário da aplicação não tem o privilégio.
fb_mysql_root() {
  local root_pw
  root_pw="$(docker exec "$FB_MYSQL_CONTAINER" printenv MYSQL_ROOT_PASSWORD 2>/dev/null)"
  if [ -z "$root_pw" ]; then
    fb_log "ERRO: MYSQL_ROOT_PASSWORD não encontrado em ${FB_MYSQL_CONTAINER}"
    return 1
  fi
  docker exec -i "$FB_MYSQL_CONTAINER" \
    mysql -h"${DB_HOST:-fleetbase-mysql}" -uroot -p"$root_pw" \
    --default-character-set=utf8mb4 --batch "$@"
}

# mysqldump cru, sem lock, com triggers/routines/eventos
# --no-tablespaces: o usuário da app não tem o privilégio PROCESS
fb_mysqldump() {
  fb_db_env
  docker exec -i "$FB_MYSQL_CONTAINER" \
    mysqldump -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" \
    --single-transaction --quick --routines --events --triggers \
    --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 "$@"
}

fb_ntfy() {
  local title="$1"; shift
  local message="$1"; shift
  local priority="${1:-default}"
  curl -s -m 8 -o /dev/null -w '%{http_code}' \
    -H "Title: $title" \
    -H "Priority: $priority" \
    -H "Tags: hermes" \
    --data-binary "$message" \
    "${NTFY_URL}/${NTFY_TOPIC}" 2>/dev/null
}
