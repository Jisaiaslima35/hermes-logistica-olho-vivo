#!/usr/bin/env bash
# infra/scripts/gate-f1-val-001.sh
#
# GATE F1-VAL-001 — decide o banco do Fleet-Ops.
#   PASS (migrate limpo, 0 erros)  => Plano A (Postgres)  [DESCARTADO em 18/11]
#   FAIL (qualquer migration nativa falha) => Plano B (MySQL 8, 640 MB)
#
# REGRA DO ISAÍAS (Telegram 6351): se o Postgres falhar numa migration nativa,
# NÃO hackear o core — parar, avisar e acionar o Plano B.
#
# Uso (a partir de infra/docker):
#   ../scripts/gate-f1-val-001.sh
#
# O script NÃO deixa lixo: roda em processo único (docker exec -d + log em
# arquivo), porque dois `migrate` concorrentes produzem erro fantasma
# ("Duplicate foreign key constraint name") — skill compose-exec-orphan-timeout.
set -euo pipefail

cd "$(dirname "$0")/../docker"
ENV_MYSQL="../env/fleetbase.mysql.env"
COMPOSE=(docker compose --profile fallback-mysql -p fleetbase
         --env-file "$ENV_MYSQL" -f compose.f1.yml -f compose.f1.planb.yml)

echo "═══ GATE F1-VAL-001 (Plano B · MySQL 8) ═══"

# 0) stack no ar?
if ! docker ps --format '{{.Names}}' | grep -qx fleetbase-mysql; then
  echo "ERRO: fleetbase-mysql não está no ar. Suba com:"
  echo "  ${COMPOSE[*]} up -d"
  exit 2
fi

# 1) provisioning dos 3 schemas (idempotente)
docker cp ../scripts/db-bootstrap.sh fleetbase-mysql:/db-bootstrap.sh >/dev/null
docker exec fleetbase-mysql sh -c \
  'chmod +x /db-bootstrap.sh; MYSQL_DATABASE=fleetbase_db MYSQL_USER=fleetbase \
   MYSQL_PASSWORD="$MYSQL_PASSWORD" MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
   sh /db-bootstrap.sh' 2>/dev/null | tail -1

# 2) migrate em processo ÚNICO, com log em arquivo (sobrevive a timeout)
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/gate-f1-${STAMP}.log"
docker exec -d fleetbase-api sh -c "php artisan migrate --force > ${LOG} 2>&1; echo \"EXIT=\$?\" >> ${LOG}"

echo "migrate rodando (log: ${LOG})…"
while ! docker exec fleetbase-api sh -c "grep -q '^EXIT=' ${LOG} 2>/dev/null"; do
  sleep 15
done

EXIT=$(docker exec fleetbase-api sh -c "grep -m1 '^EXIT=' ${LOG} | cut -d= -f2" | tr -d '\r')
DONE=$(docker exec fleetbase-api sh -c "grep -c 'DONE' ${LOG}" || echo 0)
FAIL=$(docker exec fleetbase-api sh -c "grep -c 'FAIL' ${LOG}" || echo 0)
RUN=$(docker exec fleetbase-mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM fleetbase_db.migrations;" 2>/dev/null' || echo 0)

echo "─── migrations aplicadas nesta run: ${DONE} · falhas: ${FAIL}"
echo "─── total registrado em fleetbase_db.migrations: ${RUN}"
echo "─── EXIT=${EXIT}"

if [ "$EXIT" = "0" ] && [ "$FAIL" = "0" ]; then
  echo "VEREDITO: PASS — Plano B (MySQL 8) é compatível com o core do Fleetbase."
  exit 0
fi

echo "VEREDITO: FAIL — ver as últimas linhas do log:"
docker exec fleetbase-api sh -c "tail -20 ${LOG}"
exit 1
