#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# watchdog-ntfy.sh — vigia os containers fleetbase-* e alerta via NTFY.
#
#  • container fora do ar (exit/created/morto)  → alerta IMEDIATO
#  • container reiniciando (RestartCount mudou) → alerta IMEDIATO
#  • health HTTP do painel (8601) e da bridge (8600) caído → alerta IMEDIATO
#
# Anti-spam: estado persistido em /var/lib/hermes-fleetbase/watchdog.state
# (alerta uma vez por transição; re-alerta se o cooldown de 10 min passar).
#
# Cron: */2 * * * *  (/etc/cron.d/hermes-fleetbase-watchdog)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

FB_LOG_NAME="watchdog"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/opt/hermes-fleetbase/infra/bin/fb-lib.sh
. "$SCRIPT_DIR/bin/fb-lib.sh"

STATE_DIR="${STATE_DIR:-/var/lib/hermes-fleetbase}"
STATE_FILE="$STATE_DIR/watchdog.state"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-600}"
PANEL_HEALTH="${PANEL_HEALTH:-http://127.0.0.1:8601/health}"
BRIDGE_HEALTH="${BRIDGE_HEALTH:-http://127.0.0.1:8600/health}"

fb_self_elevate "$@"

mkdir -p "$STATE_DIR" 2>/dev/null
touch "$STATE_FILE" 2>/dev/null

NOW=$(date +%s)
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

state_get() {
  grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}
state_set() {
  local key="$1" val="$2"
  sed -i "/^${key}=/d" "$STATE_FILE" 2>/dev/null
  echo "${key}=${val}" >> "$STATE_FILE"
}

# alerta com dedupe: só dispara se (a) mudou o estado ou (b) passou o cooldown
alert() {
  local key="$1" title="$2" msg="$3" prio="${4:-high}"
  local last_state last_at
  last_state="$(state_get "$key.state")"
  last_at="$(state_get "$key.at")"
  local changed=1
  if [ "$last_state" = "alerted" ]; then
    changed=0
    if [ -n "$last_at" ] && [ $(( NOW - last_at )) -gt "$COOLDOWN_SECONDS" ]; then
      changed=1
    fi
  fi
  if [ "$changed" = "1" ]; then
    local code
    code="$(fb_ntfy "$title" "$msg" "$prio")"
    fb_log "[${STAMP}] ALERTA ${key} (ntfy_http=${code}) :: ${title} :: $(printf '%s' "$msg" | head -1)"
    state_set "$key.state" "alerted"
    state_set "$key.at" "$NOW"
  fi
}

# ── 1. containers fleetbase-* ───────────────────────────────────────────────
CONTAINERS=$(docker ps -a --format '{{.Names}}' | grep '^fleetbase-' | sort)
if [ -z "$CONTAINERS" ]; then
  alert "docker" "Watchdog — nenhum container fleetbase-* encontrado" \
    "O docker ps -a não retornou nenhum container fleetbase-*. A stack pode ter sido derrubada." "high"
  exit 0
fi

for c in $CONTAINERS; do
  status="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)"
  running="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)"
  exitcode="$(docker inspect -f '{{.State.ExitCode}}' "$c" 2>/dev/null)"
  started="$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null)"

  key="container.${c}"

  if [ "$running" != "true" ]; then
    alert "$key" "Watchdog — container ${c} FORA DO AR" \
      "Container: ${c}
Estado: ${status} (exit_code=${exitcode})
Iniciado em: ${started}
Reinícios: ${restarts}

A stack do Hermes Logística & Olho Vivo foi-impactada. Verifique: docker logs --tail 100 ${c}" "high"
    continue
  fi

  prev_restarts="$(state_get "${key}.restarts")"
  if [ -n "$prev_restarts" ] && [ "$restarts" != "$prev_restarts" ]; then
    alert "$key" "Watchdog — container ${c} REINICIOU" \
      "Container: ${c}
Reinícios: ${prev_restarts} -> ${restarts}
Estado atual: ${status}
Iniciado em: ${started}

O container subiu de novo — confira o motivo no log." "high"
  fi
  state_set "${key}.restarts" "$restarts"
  state_set "${key}.status" "$status"
done

# ── 2. health HTTP dos serviços próprios ───────────────────────────────────
check_http() {
  local name="$1" url="$2"
  local code
  code="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  if [ "$code" != "200" ]; then
    alert "http.${name}" "Watchdog — ${name} sem resposta (${code})" \
      "Serviço: ${name}
Endpoint: ${url}
HTTP: ${code}

O serviço responde mas não devolve 200. Verifique os logs do container." "high"
  else
    state_set "http.${name}.state" "ok"
  fi
}
check_http "web-radio-panel" "$PANEL_HEALTH"
check_http "bridge-whatsapp" "$BRIDGE_HEALTH"

exit 0
