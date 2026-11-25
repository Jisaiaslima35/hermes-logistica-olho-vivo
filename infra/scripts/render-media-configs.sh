#!/usr/bin/env bash
# Renderiza os configs de MÍDIA (Coturn + LiveKit) a partir do cofre.
# REGRA: os segredos NUNCA ficam em arquivo versionado. Saem em
# /root/claudinho-secrets/ (dir 700) com mode 644 (o container do coturn roda
# como nobody:nogroup e precisa LER o conf; o dir 700 protege o caminho no host).
set -euo pipefail

COFRE=/root/claudinho-secrets/fleetbase.env
DIR_COTURN=/root/claudinho-secrets/coturn
DIR_LIVEKIT=/root/claudinho-secrets/livekit

get() { grep -E "^$1=" "$COFRE" | head -1 | cut -d= -f2-; }

mkdir -p "$DIR_COTURN" "$DIR_LIVEKIT"
chmod 700 "$DIR_COTURN" "$DIR_LIVEKIT"

# --- credencial estatica do TURN (coturn lt-cred-mech) ---
if ! grep -q '^TURN_USER=' "$COFRE"; then
  TURN_PASS="$(openssl rand -hex 16)"
  printf 'TURN_USER=fleetbase\nTURN_PASS=%s\n' "$TURN_PASS" >>"$COFRE"
  chmod 600 "$COFRE"
  echo "TURN_USER/TURN_PASS gerados no cofre"
fi

TURN_USER="$(get TURN_USER)"
TURN_PASS="$(get TURN_PASS)"
TURN_SECRET="$(get LIVEKIT_TURN_SECRET)"
EXT_IP="$(get TURN_EXTERNAL_IP)"
REALM="$(get TURN_REALM)"
MIN_PORT="$(get LIVEKIT_RELAY_MIN_PORT)"
MAX_PORT="$(get LIVEKIT_RELAY_MAX_PORT)"
UDP_PORT="$(get LIVEKIT_TURN_UDP_PORT)"
TURN_DOMAIN="$(get LIVEKIT_TURN_DOMAIN)"
RTC_UDP="$(get LIVEKIT_RTC_UDP_PORT)"
RTC_UDP_RESERVA="$(get LIVEKIT_RTC_UDP_RESERVA)"
RTC_TCP="$(get LIVEKIT_RTC_TCP_PORT)"

for v in TURN_USER TURN_PASS EXT_IP REALM MIN_PORT MAX_PORT UDP_PORT TURN_DOMAIN RTC_UDP RTC_TCP; do
  eval "val=\$$v"
  [ -n "${val:-}" ] || { echo "FALTA var no cofre: $v" >&2; exit 1; }
done

# ─────────────────────────── COTURN ───────────────────────────
cat >"$DIR_COTURN/turnserver.conf" <<EOF
# Coturn — renderizado de /root/claudinho-secrets/fleetbase.env
# NÃO versionar (contém a senha do usuário TURN).
# Regenerar: sudo bash /tmp/render-media-configs.sh

listening-port=${UDP_PORT}
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=${EXT_IP}
min-port=${MIN_PORT}
max-port=${MAX_PORT}

# Autenticacao: usuario estatico (lt-cred-mech) — as MESMAS credenciais que o
# LiveKit anuncia ao cliente em rtc.turn_servers.
# (o esquema --use-auth-secret do ADR-007 nao serve aqui: o LiveKit v1.9.1 so
#  gera credencial dinamica no TURN EMBUTIDO, ver nota de implantacao 19/11)
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
realm=${REALM}

# Endurecimento
no-cli
no-multicast-peers
no-loopback-peers
no-tlsv1
no-tlsv1_1
fingerprint
no-ipv6

# Log no stdout (docker logs).
# SEM no-udp-relay: relay UDP e obrigatorio para cliente em 4G/CGNAT (ADR-007).
simple-log
EOF

# ─────────────────────────── LIVEKIT ───────────────────────────
cat >"$DIR_LIVEKIT/livekit.yaml" <<EOF
# LiveKit Server v1.9.1 — renderizado de /root/claudinho-secrets/fleetbase.env
# NÃO versionar (contém a credencial do TURN).
# Regenerar: sudo bash /tmp/render-media-configs.sh
#
# Sinalizacao (WS) em 127.0.0.1:7880 -> tunnel livekit.automacaojs.us
# Midia (RTC/TURN) direto no IP publico — o tunnel nao transporta UDP.

port: 7880
bind_addresses:
  - 0.0.0.0

rtc:
  tcp_port: ${RTC_TCP}
  # mux UDP (2 portas = ADR-005: 7882 mídia + 7883 reserva).
  # NAO declarar port_range_start/end: se declarados, eles VENCEM o mux e o
  # SFU passaria a exigir 50000-60000/udp aberto no host.
  udp_port: "${RTC_UDP}-${RTC_UDP_RESERVA}"
  use_external_ip: true
  stun_servers:
    - "stun.l.google.com:19302"
    - "stun.cloudflare.com:3478"
  # TURN EXTERNO (coturn dedicado). Credencial ESTATICA — o mesmo par do
  # coturn (lt-cred-mech). O bloco turn: do LiveKit v1.9.1 e o TURN EMBUTIDO
  # (credencial propria, host = NodeIP interno) — nao serve para coturn.
  turn_servers:
    - host: ${TURN_DOMAIN}
      port: ${UDP_PORT}
      protocol: udp
      username: "${TURN_USER}"
      credential: "${TURN_PASS}"

room:
  auto_create: true
  empty_timeout: 300
  departure_timeout: 60
  max_participants: 50

logging:
  # v1.9.1: LoggingConfig embina logger.Config (protocol v1.41) — os campos
  # sao level/pion_level/etc. NAO existe "format" (quebra o boot com
  # "field format not found in type config.LoggingConfig").
  level: info

redis:
  address: "fleetbase-redis:6379"
EOF

chmod 644 "$DIR_COTURN/turnserver.conf" "$DIR_LIVEKIT/livekit.yaml"

echo "--- renderizado ---"
stat -c '%a %U %n' "$DIR_COTURN/turnserver.conf" "$DIR_LIVEKIT/livekit.yaml"
echo "--- chaves (sem valores) ---"
grep -E '^[a-z_-]+=' "$DIR_COTURN/turnserver.conf" | sed -E 's/=.*/=***/'
sed -E 's/(username|credential):.*/\1: ***/' "$DIR_LIVEKIT/livekit.yaml"
