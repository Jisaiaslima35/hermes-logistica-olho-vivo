#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# own-services.sh — sobe/reinicia os SERVIÇOS PRÓPRIOS do Hermes Fleetbase.
#
# REGRA: só mexe em fleetbase-web-radio-panel e fleetbase-bridge-whatsapp.
# NUNCA toca em fleetbase-api, fleetbase-mysql, fleetbase-livekit, fleetbase-coturn,
# fleetbase-redis, Evolution GO, Mendes, Mercado Express, CRM Hermes, Supabase.
#
# Teto de RAM: 128 MB por container (--memory=134217728 / swap 256 MB).
#
# Uso:
#   ./own-services.sh up       → sobe os dois (recria se já existirem)
#   ./own-services.sh down     → para os dois (docker stop, sem -f)
#   ./own-services.sh restart  → down + up
#   ./own-services.sh status   → containers + health + uso de RAM
#   ./own-services.sh logs     → últimas linhas dos dois
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="/opt/hermes-fleetbase"
ENV_DIR="$ROOT/infra/env"
PANEL_ENV="$ENV_DIR/web-radio-panel.env"
BRIDGE_ENV="$ENV_DIR/bridge-whatsapp.env"
PANEL_IMG="fleetbase-web-radio-panel:6.2"
BRIDGE_IMG="fleetbase-bridge-whatsapp:3.0"
MEM=134217728
MEM_SWAP=268435456

PANEL="fleetbase-web-radio-panel"
BRIDGE="fleetbase-bridge-whatsapp"

# ⚠️ EVOLUTION GO: o container publica a porta só em 127.0.0.1 do host, então
#    http://host.docker.internal:8096 NÃO funciona de dentro do container
#    (fetch failed). A solução é entrar na rede do GO e usar o nome do serviço.
#    NÃO se alterar o bind do Evolution GO — a regra de ouro é não tocá-lo.
GO_NET="evolution-go-net"

up_panel() {
  docker stop "$PANEL" >/dev/null 2>&1
  docker rm "$PANEL" >/dev/null 2>&1
  docker run -d --name "$PANEL" --restart unless-stopped \
    --memory="$MEM" --memory-swap="$MEM_SWAP" \
    --network fleetbase_net --network ntfy_default \
    --env-file "$PANEL_ENV" \
    -v "$ROOT/uploads:/app/uploads" \
    -p 127.0.0.1:8601:8601 \
    "$PANEL_IMG" >/dev/null || { echo "✘ falhou ao subir $PANEL"; return 1; }
  echo "✔ $PANEL no ar (127.0.0.1:8601)"
}

up_bridge() {
  docker stop "$BRIDGE" >/dev/null 2>&1
  docker rm "$BRIDGE" >/dev/null 2>&1
  docker run -d --name "$BRIDGE" --restart unless-stopped \
    --memory="$MEM" --memory-swap="$MEM_SWAP" \
    --network fleetbase_net --network ntfy_default --network "$GO_NET" \
    --env-file "$BRIDGE_ENV" \
    -p 127.0.0.1:8600:8600 \
    "$BRIDGE_IMG" >/dev/null || { echo "✘ falhou ao subir $BRIDGE"; return 1; }
  echo "✔ $BRIDGE no ar (127.0.0.1:8600 · Evolution GO via $GO_NET)"
}

down_one() {
  local c="$1"
  if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
    docker stop "$c" >/dev/null && docker rm "$c" >/dev/null
    echo "✔ $c parado e removido"
  else
    echo "· $c não existe"
  fi
}

status() {
  echo "── containers ────────────────────────────────────────────"
  docker ps --filter "name=fleetbase" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  echo "── health (pelo host) ───────────────────────────────────"
  printf 'painel  :8601 → '; curl -s --max-time 4 http://127.0.0.1:8601/health || echo "SEM RESPOSTA"
  echo
  printf 'bridge  :8600 → '; curl -s --max-time 4 http://127.0.0.1:8600/health || echo "SEM RESPOSTA"
  echo
  echo
  echo "── RAM (teto 128 MiB) ────────────────────────────────────"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' "$PANEL" "$BRIDGE" 2>/dev/null
  echo
  echo "── public ───────────────────────────────────────────────"
  curl -s -o /dev/null -w 'frota.automacaojs.us/health → %{http_code}\n' --max-time 6 https://frota.automacaojs.us/health
}

case "${1:-status}" in
  up)      up_panel; up_bridge; sleep 5; status ;;
  down)    down_one "$BRIDGE"; down_one "$PANEL" ;;
  restart) down_one "$BRIDGE"; down_one "$PANEL"; up_panel; up_bridge; sleep 5; status ;;
  status)  status ;;
  logs)    docker logs --tail 40 "$PANEL"; echo; docker logs --tail 40 "$BRIDGE" ;;
  *)       echo "uso: $0 {up|down|restart|status|logs}"; exit 1 ;;
esac
