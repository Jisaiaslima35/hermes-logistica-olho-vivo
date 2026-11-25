#!/usr/bin/env bash
# infra/scripts/db-bootstrap.sh — Plano B (MySQL 8, ADR-002/ADR-024)
#
# Cria os TRÊS schemas que o core do Fleetbase usa e dá GRANT ao usuário do app
# em cada um. (Achado do gate F1-VAL-001 — ADR §12.5.3: o core registra as
# conexões 'mysql', 'storefront' e 'sandbox'.)
#
#   mysql (default)  -> fleetbase_db
#   storefront        -> fleetbase_db_storefront
#   sandbox          -> fleetbase_db_sandbox
#
# Uso (dentro da rede do container, sem expor nada):
#   docker compose -p fleetbase --env-file ../env/fleetbase.mysql.env \
#     -f compose.f1.yml -f compose.f1.planb.yml \
#     exec -T fleetbase-mysql sh -s -- /scripts/db-bootstrap.sh
#
# As credenciais vêm do container (MYSQL_ROOT_PASSWORD / MYSQL_*). NADA é
# impresso além do resultado.
set -euo pipefail

DB_MAIN="${MYSQL_DATABASE:-fleetbase_db}"
DB_USER="${MYSQL_USER:-fleetbase}"
DB_PASS="${MYSQL_PASSWORD:?MYSQL_PASSWORD nao setado}"
ROOT_PASS="${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD nao setado}"

main() {
  mysql -uroot -p"$ROOT_PASS" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_MAIN}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS \`${DB_MAIN}_storefront\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS \`${DB_MAIN}_sandbox\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_MAIN}\`.*            TO '${DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${DB_MAIN}_storefront\`.* TO '${DB_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${DB_MAIN}_sandbox\`.*    TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
}

check() {
  mysql -u"$DB_USER" -p"$DB_PASS" -N -e "SHOW DATABASES;" | grep -E "^${DB_MAIN}(|_storefront|_sandbox)$" | sort
}

main 2>/dev/null
echo "--- schemas visiveis para ${DB_USER} ---"
check 2>/dev/null
echo "OK: 3 schemas prontos."
