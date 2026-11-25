# MÍDIA — configs renderizados FORA do repo (cofre)

Este diretório guarda **apenas a documentação** do bloco de mídia.
Os arquivos de configuração com **credencial** NÃO ficam aqui:

| Container | Arquivo efetivo | Modo | Gerado por |
|---|---|---|---|
| `livekit` | `/root/claudinho-secrets/livekit/livekit.yaml` | 644 (dir pai 700) | `sudo bash /tmp/render-media-configs.sh` |
| `coturn` | `/root/claudinho-secrets/coturn/turnserver.conf` | 644 (dir pai 700) | `sudo bash /tmp/render-media-configs.sh` |

Por quê: o `livekit.yaml` carrega a credencial do TURN (`rtc.turn_servers[].credential`)
e o `turnserver.conf` carrega o mesmo par (`lt-cred-mech` + `user=`).
Versionar isso = vazamento de credencial. Os **valores** vivem no cofre
`/root/claudinho-secrets/fleetbase.env` (600) e o `compose.media.yml` monta os
arquivos renderizados por caminho absoluto.

Deploy:

```bash
cd /opt/hermes-fleetbase/infra/docker
sudo docker compose -p fleetbase \
  --env-file /root/claudinho-secrets/fleetbase.env \
  -f compose.f1.yml -f compose.media.yml --profile media up -d livekit coturn
```

Sempre com `--profile media`. **Nunca** junto do perfil `router` (VROOM) —
ADR-024: `router` e `fallback-mysql` são mutuamente exclusivos.

Ver mais: `docs/04-SPEC-KIT.md` §8 (config da mídia) e a nota de implantação
de 19/11/2026 no fim do §8.
